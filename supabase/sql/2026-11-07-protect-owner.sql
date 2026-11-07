-- 2026-11-07  Protect the owner account (approved by the owner).
-- The owner email can never be removed, changed, banned or deleted by anyone on the platform,
-- and the owner (and the owner's company) is hidden from every Admin Team member.

-- ---------- who the owner is ----------
create or replace function public.q_owner_email() returns text
language sql immutable as $$ select 'irfan.aidigital@gmail.com'::text $$;

create or replace function public.q_owner_uid() returns uuid
language sql stable security definer set search_path = public as $$
  select u.id from auth.users u where lower(u.email) = public.q_owner_email() limit 1
$$;

create or replace function public.q_owner_company() returns uuid
language sql stable security definer set search_path = public as $$
  select p.company_id from profiles p where p.id = public.q_owner_uid()
$$;

-- service role only: lets edge functions hide the owner from Admin Team members
create or replace function public.q_owner_ids() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('uid', public.q_owner_uid(), 'email', public.q_owner_email(), 'company', public.q_owner_company())
$$;
revoke all on function public.q_owner_ids() from public, anon, authenticated;
grant execute on function public.q_owner_ids() to service_role;

-- true when the signed-in caller must NOT see this row (the row belongs to the owner or the owner's
-- company, and the caller is neither the owner nor in the owner's own company)
create or replace function public.q_hide_owner(p_user uuid, p_company uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare me uuid := (select auth.uid()); o uuid; oc uuid;
begin
  if me is null then return false; end if;
  o := public.q_owner_uid();
  if o is null or me = o then return false; end if;
  oc := public.q_owner_company();
  if p_user is distinct from o and (p_company is null or p_company is distinct from oc) then return false; end if;
  if oc is not null and exists (select 1 from profiles where id = me and company_id = oc) then return false; end if;
  return true;
end $$;

-- ---------- hide the owner from everyone else (restrictive = applies on top of every other policy) ----------
do $$
declare r record;
begin
  for r in select * from (values
    ('profiles',                      'id',      'company_id'),
    ('user_activity',                 'user_id', 'company_id'),
    ('client_errors',                 'user_id', null),
    ('platform_feedback',             'user_id', 'company_id'),
    ('billing_payments',              null,      'company_id'),
    ('mt_packs',                      null,      'company_id'),
    ('mt_sheet_usage',                'user_id', 'company_id'),
    ('company_storage_subscriptions', null,      'company_id'),
    ('support_tickets',               'user_id', 'company_id'),
    ('q_internal_users',              'user_id', null)
  ) t(tbl, ucol, ccol) loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('drop policy if exists owner_hidden on public.%I', r.tbl);
    execute format('create policy owner_hidden on public.%I as restrictive for select to authenticated using (not public.q_hide_owner(%s, %s))',
      r.tbl, coalesce(quote_ident(r.ucol), 'null::uuid'), coalesce(quote_ident(r.ccol), 'null::uuid'));
  end loop;
end $$;

-- ---------- guards: nobody can remove or change the owner ----------
create or replace function public.q_guard_owner_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.user_id = public.q_owner_uid() then raise exception 'The owner account is protected and cannot be removed or changed.'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists q_guard_owner_admin on public.platform_admins;
create trigger q_guard_owner_admin before update or delete on public.platform_admins
  for each row execute function public.q_guard_owner_admin();

create or replace function public.q_guard_owner_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(coalesce(old.email, '')) = public.q_owner_email() then
    if tg_op = 'DELETE' then raise exception 'The owner account is protected and cannot be deleted.'; end if;
    if lower(coalesce(new.email, '')) <> public.q_owner_email()
       or new.email_change is distinct from old.email_change and coalesce(new.email_change, '') <> ''
       or (new.banned_until is not null and new.banned_until > now())
       or new.deleted_at is not null then
      raise exception 'The owner email is protected and cannot be changed, banned or deleted.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists q_guard_owner_user on auth.users;
create trigger q_guard_owner_user before update or delete on auth.users
  for each row execute function public.q_guard_owner_user();

create or replace function public.q_guard_owner_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := (select auth.uid());
begin
  if old.id = public.q_owner_uid() then
    if tg_op = 'DELETE' then raise exception 'The owner profile is protected and cannot be deleted.'; end if;
    if me is not null and me <> old.id then raise exception 'The owner profile can only be changed by the owner.'; end if;
    if new.company_id is distinct from old.company_id then raise exception 'The owner company cannot be changed.'; end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists q_guard_owner_profile on public.profiles;
create trigger q_guard_owner_profile before update or delete on public.profiles
  for each row execute function public.q_guard_owner_profile();

create or replace function public.q_guard_owner_company() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := (select auth.uid());
begin
  if old.id = public.q_owner_company() then
    if tg_op = 'DELETE' then raise exception 'The owner company is protected and cannot be deleted.'; end if;
    if me is not null and me <> public.q_owner_uid()
       and not exists (select 1 from profiles where id = me and company_id = old.id) then
      raise exception 'The owner company can only be changed by the owner.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists q_guard_owner_company on public.companies;
create trigger q_guard_owner_company before update or delete on public.companies
  for each row execute function public.q_guard_owner_company();

-- the owner email can never become an Admin Team member (so it can never be limited)
create or replace function public.q_guard_owner_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(coalesce(new.email, '')) = public.q_owner_email() or new.user_id = public.q_owner_uid() then
    raise exception 'That email is the owner account, which already has everything.';
  end if;
  return new;
end $$;
drop trigger if exists q_guard_owner_staff on public.platform_staff;
create trigger q_guard_owner_staff before insert or update on public.platform_staff
  for each row execute function public.q_guard_owner_staff();

-- ---------- Online Users: team members never see the owner ----------
create or replace function public.q_online_users()
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
begin
  if public.q_staff_level('online') < 1 then raise exception 'No access to Online Users.'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'last_seen' desc) from (
      select distinct on (a.user_id) jsonb_build_object(
        'user_id', a.user_id, 'email', coalesce(a.email, u.email), 'full_name', coalesce(p.full_name, a.full_name),
        'company_id', coalesce(p.company_id, a.company_id), 'company_name', c.name, 'plan', c.plan,
        'country', p.country, 'city', p.city, 'user_agent', a.user_agent, 'time_zone', a.time_zone,
        'page', a.page, 'online_since', a.started_at, 'last_seen', a.last_seen_at,
        'signed_up', u.created_at,
        'projects', (select count(*) from projects pr where pr.owner_id = a.user_id),
        'is_team', exists (select 1 from platform_admins pa where pa.user_id = a.user_id) or exists (select 1 from platform_staff s where s.user_id = a.user_id)) x
      from user_activity a
      left join auth.users u on u.id = a.user_id
      left join profiles p on p.id = a.user_id
      left join companies c on c.id = coalesce(p.company_id, a.company_id)
      where a.last_seen_at > now() - interval '3 minutes'
        and not public.q_hide_owner(a.user_id, coalesce(p.company_id, a.company_id))
      order by a.user_id, a.last_seen_at desc) q), '[]'::jsonb);
end $function$;
