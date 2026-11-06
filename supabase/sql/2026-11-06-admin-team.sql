-- Admin Team with per-section access (2026-11-06).
--
-- Until now the admin portal was all-or-nothing: platform_admins saw every section.
-- platform_admins stays exactly that -- the OWNER, with everything. A new team member is a row in
-- platform_staff with a level per admin section: none (absent), 'view', or 'act'.
-- Only the owner can add, change, pause or remove team members, and every change is recorded.
--
-- Access is enforced in the database and the edge functions, not only hidden on screen:
--   * q_staff_level(section)          -- the signed-in user's level: 0 none, 1 view, 2 act (owner = 2)
--   * q_staff_level_for(user, section) -- the same, for edge functions (service role only)
--   * extra permissive RLS policies below give a team member read (or write) on exactly the tables
--     their sections need. The owner's existing policies are untouched.

create table if not exists public.platform_staff (
  email       text primary key,                         -- lower-case; the member signs in with it
  user_id     uuid unique references auth.users(id) on delete set null,
  perms       jsonb not null default '{}'::jsonb,        -- {"customers":"view","livechat":"act",...}
  status      text not null default 'active' check (status in ('active', 'paused')),
  added_by    uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.platform_staff enable row level security;   -- read only through the functions below

create table if not exists public.platform_staff_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  by_user    uuid,
  email      text not null,
  change     text not null,                              -- added / updated / paused / resumed / removed
  perms      jsonb
);
alter table public.platform_staff_audit enable row level security;

-- link a member to their account the first time they sign in (or if they already had one)
create or replace function public.q_staff_link() returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
begin
  if (select auth.uid()) is null or v_email = '' then return; end if;
  update platform_staff set user_id = (select auth.uid()), updated_at = now()
   where email = v_email and (user_id is null or user_id <> (select auth.uid()));
end $$;

create or replace function public.q_staff_level_for(p_user uuid, p_section text) returns int
language sql stable security definer set search_path = public as $$
  select case
    when p_user is null then 0
    when exists (select 1 from platform_admins pa where pa.user_id = p_user) then 2
    else coalesce((select case s.perms ->> p_section when 'act' then 2 when 'view' then 1 else 0 end
                     from platform_staff s where s.user_id = p_user and s.status = 'active'), 0)
  end;
$$;

create or replace function public.q_staff_level(p_section text) returns int
language sql stable security definer set search_path = public as $$
  select public.q_staff_level_for((select auth.uid()), p_section);
$$;

-- a ticket's level for the signed-in team member: live chats follow Live Chat, outreach messages
-- follow Customers, and Support & Feedback covers every ticket
create or replace function public.q_staff_ticket_level(p_kind text, p_category text) returns int
language sql stable security definer set search_path = public as $$
  select greatest(
    public.q_staff_level('support'),
    case when p_category = 'live_chat' then public.q_staff_level('livechat') else 0 end,
    case when p_kind = 'outreach' then public.q_staff_level('customers') else 0 end);
$$;
create or replace function public.q_staff_ticket_level_id(p_ticket uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select public.q_staff_ticket_level(t.kind, t.category) from support_tickets t where t.id = p_ticket), 0);
$$;

-- what the signed-in user may do in the admin portal (the app calls this once after sign-in)
create or replace function public.q_staff_me() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform public.q_staff_link();
  if public.is_platform_admin() then return jsonb_build_object('owner', true, 'perms', '{}'::jsonb); end if;
  select perms, status into r from platform_staff where user_id = (select auth.uid());
  if r is null or r.status <> 'active' then return jsonb_build_object('owner', false, 'perms', null); end if;
  return jsonb_build_object('owner', false, 'perms', r.perms);
end $$;

-- ---------- owner-only management ----------
create or replace function public.q_staff_list() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Only the owner can manage the admin team.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'email', s.email, 'perms', s.perms, 'status', s.status, 'created_at', s.created_at, 'updated_at', s.updated_at,
      'has_account', s.user_id is not null or exists (select 1 from auth.users u where lower(u.email) = s.email),
      'last_seen', (select max(a.last_seen_at) from user_activity a where a.user_id = s.user_id))
      order by s.created_at)
    from platform_staff s), '[]'::jsonb);
end $$;

create or replace function public.q_staff_save(p_email text, p_perms jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_clean jsonb := '{}'::jsonb; k text; v text; v_new boolean;
begin
  if not public.is_platform_admin() then raise exception 'Only the owner can manage the admin team.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if exists (select 1 from platform_admins pa join auth.users u on u.id = pa.user_id where lower(u.email) = v_email) then
    raise exception 'That email is the owner account, which already has everything.';
  end if;
  for k, v in select * from jsonb_each_text(coalesce(p_perms, '{}'::jsonb)) loop
    if k ~ '^[a-z]{2,20}$' and v in ('view', 'act') then v_clean := v_clean || jsonb_build_object(k, v); end if;
  end loop;
  v_new := not exists (select 1 from platform_staff where email = v_email);
  insert into platform_staff (email, user_id, perms, added_by)
  values (v_email, (select u.id from auth.users u where lower(u.email) = v_email limit 1), v_clean, (select auth.uid()))
  on conflict (email) do update set perms = excluded.perms, updated_at = now(),
    user_id = coalesce(platform_staff.user_id, excluded.user_id);
  insert into platform_staff_audit (by_user, email, change, perms)
  values ((select auth.uid()), v_email, case when v_new then 'added' else 'updated' end, v_clean);
end $$;

create or replace function public.q_staff_set_status(p_email text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_platform_admin() then raise exception 'Only the owner can manage the admin team.'; end if;
  if p_status not in ('active', 'paused') then raise exception 'Unknown status.'; end if;
  update platform_staff set status = p_status, updated_at = now() where email = v_email;
  insert into platform_staff_audit (by_user, email, change)
  values ((select auth.uid()), v_email, case when p_status = 'paused' then 'paused' else 'resumed' end);
end $$;

create or replace function public.q_staff_remove(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_platform_admin() then raise exception 'Only the owner can manage the admin team.'; end if;
  delete from platform_staff where email = v_email;
  insert into platform_staff_audit (by_user, email, change) values ((select auth.uid()), v_email, 'removed');
end $$;

create or replace function public.q_staff_audit_list() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Only the owner can manage the admin team.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'email', a.email, 'change', a.change, 'perms', a.perms) order by a.at desc)
                     from (select * from platform_staff_audit order by at desc limit 100) a), '[]'::jsonb);
end $$;

-- ---------- Online Users ----------
alter table public.user_activity add column if not exists page text;

-- who is using Quantora right now: a session seen in the last 3 minutes (the app beats every minute)
create or replace function public.q_online_users() returns jsonb
language plpgsql security definer set search_path = public as $$
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
      order by a.user_id, a.last_seen_at desc) q), '[]'::jsonb);
end $$;

-- ---------- what a team member may read or change (added to the owner's policies, never replacing them) ----------
drop policy if exists staff_read_alerts on public.admin_alerts;
create policy staff_read_alerts on public.admin_alerts for select to authenticated using (public.q_staff_level('alerts') >= 1);
drop policy if exists staff_update_alerts on public.admin_alerts;
create policy staff_update_alerts on public.admin_alerts for update to authenticated
  using (public.q_staff_level('alerts') >= 2) with check (public.q_staff_level('alerts') >= 2);
drop policy if exists staff_read_reports on public.admin_reports;
create policy staff_read_reports on public.admin_reports for select to authenticated using (public.q_staff_level('hourly') >= 1);
drop policy if exists staff_read_payments on public.billing_payments;
create policy staff_read_payments on public.billing_payments for select to authenticated
  using (greatest(public.q_staff_level('payments'), public.q_staff_level('customers')) >= 1);
drop policy if exists staff_read_measure on public.civil_measure_jobs;
create policy staff_read_measure on public.civil_measure_jobs for select to authenticated using (public.q_staff_level('projects') >= 1);
drop policy if exists staff_read_errors on public.client_errors;
create policy staff_read_errors on public.client_errors for select to authenticated
  using (greatest(public.q_staff_level('health'), public.q_staff_level('alerts')) >= 1);
drop policy if exists staff_read_storage_subs on public.company_storage_subscriptions;
create policy staff_read_storage_subs on public.company_storage_subscriptions for select to authenticated using (public.q_staff_level('customers') >= 1);
drop policy if exists staff_read_mt_packs on public.mt_packs;
create policy staff_read_mt_packs on public.mt_packs for select to authenticated using (public.q_staff_level('customers') >= 1);
drop policy if exists staff_read_mt_usage on public.mt_sheet_usage;
create policy staff_read_mt_usage on public.mt_sheet_usage for select to authenticated using (public.q_staff_level('customers') >= 1);
drop policy if exists staff_read_feedback on public.platform_feedback;
create policy staff_read_feedback on public.platform_feedback for select to authenticated
  using (greatest(public.q_staff_level('ratings'), public.q_staff_level('support')) >= 1);
drop policy if exists staff_read_profiles on public.profiles;
create policy staff_read_profiles on public.profiles for select to authenticated
  using (greatest(public.q_staff_level('customers'), public.q_staff_level('online'), public.q_staff_level('livechat'), public.q_staff_level('support')) >= 1);
drop policy if exists staff_read_internal on public.q_internal_users;
create policy staff_read_internal on public.q_internal_users for select to authenticated
  using (greatest(public.q_staff_level('customers'), public.q_staff_level('exec'), public.q_staff_level('revenue')) >= 1);
drop policy if exists staff_read_robot on public.robot_runs;
create policy staff_read_robot on public.robot_runs for select to authenticated using (public.q_staff_level('health') >= 1);
drop policy if exists staff_read_activity on public.user_activity;
create policy staff_read_activity on public.user_activity for select to authenticated
  using (greatest(public.q_staff_level('customers'), public.q_staff_level('online')) >= 1);

-- support tickets and chats
drop policy if exists staff_read_tickets on public.support_tickets;
create policy staff_read_tickets on public.support_tickets for select to authenticated
  using (public.q_staff_ticket_level(kind, category) >= 1);
drop policy if exists staff_insert_tickets on public.support_tickets;
create policy staff_insert_tickets on public.support_tickets for insert to authenticated
  with check (opened_by_admin and public.q_staff_ticket_level(kind, category) >= 2);
drop policy if exists staff_update_tickets on public.support_tickets;
create policy staff_update_tickets on public.support_tickets for update to authenticated
  using (public.q_staff_ticket_level(kind, category) >= 2) with check (public.q_staff_ticket_level(kind, category) >= 2);
drop policy if exists staff_insert_messages on public.support_messages;
create policy staff_insert_messages on public.support_messages for insert to authenticated
  with check (sender_user_id = (select auth.uid()) and from_admin and public.q_staff_ticket_level_id(ticket_id) >= 2);

drop policy if exists staff_read_support_files on storage.objects;
create policy staff_read_support_files on storage.objects for select to authenticated
  using (bucket_id = 'support' and greatest(public.q_staff_level('livechat'), public.q_staff_level('support')) >= 1);

create or replace function public.user_can_see_ticket(p_ticket_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $function$
  select exists (
    select 1 from support_tickets t
    where t.id = p_ticket_id
      and ( t.user_id = (select auth.uid())
            or (t.company_id is not null and public.user_in_company(t.company_id))
            or public.is_platform_admin()
            or public.q_staff_ticket_level(t.kind, t.category) >= 1 )
  );
$function$;

create or replace function public.mark_support_thread_read(p_ticket_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if not public.user_can_see_ticket(p_ticket_id) then
    raise exception 'not permitted';
  end if;
  if public.is_platform_admin() or public.q_staff_ticket_level_id(p_ticket_id) >= 1 then
    update support_messages set read_by_admin_at = now()
     where ticket_id = p_ticket_id and from_admin = false and read_by_admin_at is null;
  else
    update support_messages set read_by_customer_at = now()
     where ticket_id = p_ticket_id and from_admin = true and read_by_customer_at is null;
  end if;
end;
$function$;

revoke all on function public.q_staff_level_for(uuid, text) from public, anon, authenticated;
grant execute on function public.q_staff_level_for(uuid, text) to service_role;
revoke all on function public.q_staff_list(), public.q_staff_save(text, jsonb), public.q_staff_set_status(text, text),
  public.q_staff_remove(text), public.q_staff_audit_list(), public.q_online_users(), public.q_staff_me(), public.q_staff_link() from public, anon;
grant execute on function public.q_staff_list(), public.q_staff_save(text, jsonb), public.q_staff_set_status(text, text),
  public.q_staff_remove(text), public.q_staff_audit_list(), public.q_online_users(), public.q_staff_me(), public.q_staff_link() to authenticated;
