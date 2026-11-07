-- 2026-11-07  Sign-up watch (approved by the owner):
--   1. the robot tests the whole sign-up journey once a day (sign up -> confirmation email sent ->
--      link works -> company + Welcome Pack created) and then removes its test account,
--   2. the hourly report flags anyone who signed up 30+ minutes ago and has not confirmed,
--   3. one automatic reminder (a fresh confirmation link) after 1 hour.

-- the robot's own sign-up test addresses: quantoraengineering01+signup<anything>@gmail.com
create or replace function public.q_is_robot_signup(p_email text) returns boolean
language sql immutable as $$
  select coalesce(lower(p_email) ~ '^quantoraengineering01\+signup[0-9a-z._-]*@gmail\.com$', false)
$$;

-- only the robot account may call the robot sign-up helpers
create or replace function public.q_is_robot_caller() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u where u.id = (select auth.uid()) and lower(u.email) = 'quantoraengineering01+robot@gmail.com')
$$;

-- what happened to a robot test sign-up (email sent? confirmed? company and Welcome Pack?)
create or replace function public.q_robot_signup_check(p_email text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u record; c record;
begin
  if not public.q_is_robot_caller() then raise exception 'Robot only.'; end if;
  if not public.q_is_robot_signup(p_email) then raise exception 'Not a robot test address.'; end if;
  select id, email_confirmed_at, confirmation_sent_at, confirmation_token into u from auth.users where lower(email) = lower(p_email);
  if u.id is null then return jsonb_build_object('exists', false); end if;
  select co.id, co.plan, co.trial_end_date into c from profiles p join companies co on co.id = p.company_id where p.id = u.id;
  return jsonb_build_object('exists', true, 'confirmation_sent_at', u.confirmation_sent_at, 'confirmed', u.email_confirmed_at is not null,
    'token_hash', nullif(u.confirmation_token, ''), 'company_id', c.id, 'plan', c.plan,
    'welcome_pack', c.id is not null and c.plan = 'trial' and c.trial_end_date > now());
end $$;

-- remove robot test sign-ups (this one, and any left behind by an earlier run)
create or replace function public.q_robot_signup_cleanup(p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not public.q_is_robot_caller() then raise exception 'Robot only.'; end if;
  for r in select u.id, p.company_id from auth.users u left join profiles p on p.id = u.id
           where public.q_is_robot_signup(u.email) and (lower(u.email) = lower(p_email) or u.created_at < now() - interval '2 hours') loop
    delete from auth.users where id = r.id;
    if r.company_id is not null then
      delete from trial_signup_log where company_id = r.company_id;
      delete from companies where id = r.company_id and not exists (select 1 from profiles where company_id = r.company_id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.q_robot_signup_check(text) from public, anon;
revoke all on function public.q_robot_signup_cleanup(text) from public, anon;
grant execute on function public.q_robot_signup_check(text) to authenticated;
grant execute on function public.q_robot_signup_cleanup(text) to authenticated;

-- one reminder per person
create table if not exists public.signup_reminders (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now(),
  result text
);
alter table public.signup_reminders enable row level security;

-- for the hourly report (service role only): real people who signed up in the last 7 days and have not confirmed
create or replace function public.q_pending_signups_ops() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'full_name', u.raw_user_meta_data->>'full_name',
      'created_at', u.created_at, 'confirmation_sent_at', u.confirmation_sent_at, 'minutes', floor(extract(epoch from now() - u.created_at) / 60),
      'reminded_at', r.sent_at) order by u.created_at desc), '[]'::jsonb)
  from auth.users u left join signup_reminders r on r.user_id = u.id
  where u.email_confirmed_at is null and u.email is not null
    and u.created_at > now() - interval '7 days'
    and not public.q_is_robot_signup(u.email)
$$;
revoke all on function public.q_pending_signups_ops() from public, anon, authenticated;
grant execute on function public.q_pending_signups_ops() to service_role;

-- the hourly "new users" count never includes the robot's test sign-ups
create or replace function public.q_ops_stats(p_from timestamp with time zone, p_to timestamp with time zone)
 returns jsonb language sql stable security definer set search_path to 'public', 'auth'
as $function$
  with adm as (select user_id from platform_admins union select user_id from q_internal_users
               union select id from auth.users where public.q_is_robot_signup(email)),
  admin_projects as (select p.id from projects p where p.owner_id in (select user_id from adm)),
  runs as (select * from analysis_runs r where r.created_at >= p_from and r.created_at < p_to
             and r.project_id not in (select id from admin_projects) and coalesce(r.is_admin_assisted, false) = false)
  select jsonb_build_object(
    'users', jsonb_build_object(
      'signups', (select count(*) from auth.users u where u.created_at >= p_from and u.created_at < p_to and u.id not in (select user_id from adm)),
      'logins',  (select count(*) from auth.users u where u.last_sign_in_at >= p_from and u.last_sign_in_at < p_to and u.id not in (select user_id from adm)),
      'waiting_confirmation', (select count(*) from auth.users u where u.email_confirmed_at is null and u.created_at > now() - interval '7 days'
                                 and u.created_at < now() - interval '30 minutes' and not public.q_is_robot_signup(u.email))),
    'runs', jsonb_build_object(
      'completed', (select count(*) from runs where status = 'completed'),
      'failed',    (select count(*) from runs where status = 'failed'),
      'empty',     (select count(*) from runs where status = 'completed' and coalesce(run_kind,'') <> 'quotation_compliance'
                      and coalesce(run_kind,'') <> 'design_ifc' and coalesce((summary->>'item_count')::int, 0) = 0)),
    'drawings', jsonb_build_object(
      'done',   (select count(*) from draftsman_jobs where coalesce(finished_at, created_at) >= p_from and coalesce(finished_at, created_at) < p_to and status = 'done'
                   and project_id not in (select id from admin_projects)),
      'failed', (select count(*) from draftsman_jobs where coalesce(finished_at, created_at) >= p_from and coalesce(finished_at, created_at) < p_to and status = 'failed'
                   and project_id not in (select id from admin_projects))),
    'pages', (select coalesce(sum(page_count), 0) from ai_usage where created_at >= p_from and created_at < p_to and coalesce(is_admin_assisted, false) = false
                and coalesce(user_id::text, '') not in (select user_id::text from adm)),
    'chats', jsonb_build_object(
      'new_chats', (select count(*) from support_tickets where category = 'live_chat' and created_at >= p_from and created_at < p_to and coalesce(opened_by_admin, false) = false
                      and user_id not in (select user_id from adm)),
      'customer_messages', (select count(*) from support_messages m join support_tickets t on t.id = m.ticket_id
                      where t.category = 'live_chat' and m.from_admin = false and m.created_at >= p_from and m.created_at < p_to and t.user_id not in (select user_id from adm)),
      'waiting', (select count(*) from support_tickets t where t.category = 'live_chat' and t.status <> 'resolved' and t.user_id not in (select user_id from adm)
                    and coalesce((select max(m.created_at) from support_messages m where m.ticket_id = t.id and m.from_admin), 'epoch'::timestamptz)
                      < greatest(t.created_at, coalesce((select max(m.created_at) from support_messages m where m.ticket_id = t.id and not m.from_admin), t.created_at)))),
    'ratings', (select jsonb_build_object('count', count(*), 'avg', round(avg(rating)::numeric, 1)) from platform_feedback
                  where created_at >= p_from and created_at < p_to and coalesce(user_id::text, '') not in (select user_id::text from adm)),
    'payments', (select count(*) from billing_events where received_at >= p_from and received_at < p_to),
    'user_errors', (select count(*) from client_errors where created_at >= p_from and created_at < p_to and user_id not in (select user_id from adm)),
    'user_errors_users', (select count(distinct user_id) from client_errors where created_at >= p_from and created_at < p_to and user_id not in (select user_id from adm)),
    'uploads_not_saved', (select count(*) from storage.objects o
                where o.bucket_id = 'drawings' and o.created_at >= p_from and o.created_at < p_to
                  and split_part(o.name, '/', 2) ~ '^[0-9]{10,}_' and split_part(o.name, '/', 3) = ''
                  and coalesce(o.owner::text, '') not in (select user_id::text from adm)
                  and not exists (select 1 from drawings d where d.storage_path = o.name)),
    'robot', (select jsonb_build_object('runs', count(*), 'failed', count(*) filter (where not ok),
                'last_at', max(created_at), 'last_ok', (select ok from robot_runs order by created_at desc limit 1))
                from robot_runs where created_at >= p_from and created_at < p_to),
    'alerts_new',  (select count(*) from admin_alerts where first_seen >= p_from and first_seen < p_to),
    'alerts_open', (select count(*) from admin_alerts where status = 'open'),
    'stuck_runs',  (select count(*) from analysis_runs where status = 'processing' and created_at < now() - interval '30 minutes' and created_at > now() - interval '1 day'),
    'stuck_jobs',  (select count(*) from draftsman_jobs where status in ('queued', 'running') and created_at < now() - interval '60 minutes' and created_at > now() - interval '1 day')
  );
$function$;

-- a passing main robot run no longer closes a sign-up robot alert (and the other way round)
create or replace function public.q_robot_report(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_ok boolean := coalesce((p->>'ok')::boolean, false); v_step text := nullif(p->>'failed_step', '');
        v_signup boolean := coalesce(p->>'mode', '') = 'signup';
begin
  if not exists (select 1 from q_internal_users where user_id = auth.uid()) then
    raise exception 'not allowed';
  end if;
  insert into robot_runs (mode, ok, failed_step, message, steps, duration_s, build, run_url)
  values (left(p->>'mode', 20), v_ok, left(v_step, 120), left(p->>'message', 2000), p->'steps',
          nullif(p->>'duration_s', '')::numeric, left(p->>'build', 40), left(p->>'run_url', 300));
  if v_ok then
    update admin_alerts set status = 'fixed', updated_at = now()
     where service = 'robot' and status = 'open'
       and (case when v_signup then fingerprint like 'robot:Sign-up%' else fingerprint not like 'robot:Sign-up%' end);
  else
    perform q_robot_alert('robot:' || coalesce(v_step, 'run'),
      'Robot check failed: ' || coalesce(v_step, 'run'),
      coalesce(p->>'message', ''),
      jsonb_build_object('at', now(), 'file', coalesce(v_step, 'run'), 'source_kind', 'robot', 'page', p->>'run_url', 'user_email', 'test robot'));
  end if;
end $$;

-- (applied 2026-11-07, migration signup_robot_welcome_exception_2026_11_07)
-- bootstrap_company_for_user: the robot's test addresses (q_is_robot_signup) are never a repeat trial.
-- q_robot_signup_cleanup: also removes the signup_checks row of the robot's test company.
