-- Security hardening (approved 15 Nov 2026). Applied as migration security_2026_11_15.

-- 1. AI Draftsman page limit: no way around it.
--    a) a signed-in user is always recorded as themselves (created_by can't be set to someone else,
--       e.g. an admin, to skip the limit or hide the pages from the count)
--    b) "rework" and "add to set" stay free, but only on a finished set of the same project and at
--       most 3 per finished set; after that they count like any new request.
create or replace function public.enforce_draftsman_pages()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_company uuid; q record; v_uid uuid := auth.uid(); v_ref text; v_free_used int; v_base int;
begin
  if v_uid is not null then new.created_by := v_uid;           -- a user can only act as themselves
  elsif new.created_by is null then new.created_by := v_uid; end if;
  if new.created_by is not null and exists (select 1 from platform_admins where user_id = new.created_by) then return new; end if;
  v_ref := coalesce(new.options->>'rework_of', new.options->>'add_to');
  if v_ref is not null and exists (select 1 from draftsman_jobs b where b.id::text = v_ref and b.project_id = new.project_id and b.status = 'done') then
    select count(*) into v_free_used from draftsman_jobs j
     where j.project_id = new.project_id and (j.options ? 'rework_of' or j.options ? 'add_to') and j.status in ('queued', 'running', 'done');
    select count(*) into v_base from draftsman_jobs j
     where j.project_id = new.project_id and not (j.options ? 'rework_of' or j.options ? 'add_to') and j.status = 'done';
    if v_free_used < 3 * v_base then return new; end if;
  end if;
  select company_id into v_company from projects where id = new.project_id;
  if v_company is null then return new; end if;
  select * into q from draftsman_quota(v_company);
  if q.lim is not null and q.used >= q.lim then
    if q.plan_id in ('trial', 'free') then
      raise exception 'DRAFTSMAN_LIMIT_REACHED: your free welcome pack is used. Choose a plan to keep generating drawings.';
    end if;
    raise exception 'DRAFTSMAN_LIMIT_REACHED: all % drawing page(s) of your plan are used this month. Upgrade the plan or ask the administrator for more pages.', q.lim;
  end if;
  return new;
end $function$;

-- 2. Only a platform admin can mark an analysis run "admin assisted".
create or replace function public.q_guard_admin_assisted()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or exists (select 1 from platform_admins where user_id = auth.uid()) then return new; end if;
  if tg_op = 'INSERT' then new.is_admin_assisted := false;
  else new.is_admin_assisted := old.is_admin_assisted; end if;
  return new;
end $$;
drop trigger if exists q_guard_admin_assisted on public.analysis_runs;
create trigger q_guard_admin_assisted before insert or update on public.analysis_runs
  for each row execute function public.q_guard_admin_assisted();

-- 3. Lookups that reveal the owner account: signed-in callers only.
revoke execute on function public.q_owner_uid() from public, anon;
revoke execute on function public.q_owner_company() from public, anon;
grant execute on function public.q_owner_uid() to authenticated, service_role;
grant execute on function public.q_owner_company() to authenticated, service_role;

-- 4. Trigger functions are never called directly: nobody outside may run them.
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prosecdef and format_type(p.prorettype, null) = 'trigger'
  loop execute format('revoke execute on function %s from public, anon, authenticated', f); end loop;
end $$;

-- 5. Fixed search path on the three functions that lacked one.
alter function public.q_owner_email() set search_path = public;
alter function public.q_is_robot_signup(text) set search_path = public;
do $$ declare f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where proname = 'q_email_welcome_stages' and pronamespace = 'public'::regnamespace
  loop execute format('alter function %s set search_path = public', f); end loop;
end $$;

-- 6. Payment requests: one per company every 20 seconds (stops double clicks and repeated plan changes).
create table if not exists public.billing_action_locks (
  company_id uuid primary key,
  action text not null,
  locked_at timestamptz not null default now()
);
alter table public.billing_action_locks enable row level security;
revoke all on public.billing_action_locks from anon, authenticated;
create or replace function public.q_billing_lock(p_company uuid, p_action text, p_seconds int default 20)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare ok boolean;
begin
  insert into billing_action_locks (company_id, action, locked_at) values (p_company, p_action, now())
  on conflict (company_id) do update set action = excluded.action, locked_at = excluded.locked_at
   where billing_action_locks.locked_at < now() - make_interval(secs => p_seconds)
  returning true into ok;
  return coalesce(ok, false);
end $$;
revoke execute on function public.q_billing_lock(uuid, text, int) from public, anon, authenticated;
grant execute on function public.q_billing_lock(uuid, text, int) to service_role;

-- 7. Speed limit for the AI engines and the visit counter: per caller, per minute.
create table if not exists public.rate_hits (
  k text not null,
  minute timestamptz not null,
  n int not null default 0,
  primary key (k, minute)
);
alter table public.rate_hits enable row level security;
revoke all on public.rate_hits from anon, authenticated;
create or replace function public.q_rate_ok(p_key text, p_limit int)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare m timestamptz := date_trunc('minute', now()); c int;
begin
  insert into rate_hits (k, minute, n) values (p_key, m, 1)
  on conflict (k, minute) do update set n = rate_hits.n + 1 returning n into c;
  if random() < 0.01 then delete from rate_hits where minute < now() - interval '10 minutes'; end if;
  return c <= p_limit;
end $$;
revoke execute on function public.q_rate_ok(text, int) from public, anon, authenticated;
grant execute on function public.q_rate_ok(text, int) to service_role;
