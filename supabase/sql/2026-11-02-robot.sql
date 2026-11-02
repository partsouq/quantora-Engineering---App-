-- 2026-11-02 Test robot: an internal account that uses the live site like a customer every 30 minutes.
-- Runs are stored in robot_runs; a failure opens an admin alert (push to the admin), a pass closes it.
-- The robot is kept out of user stats, error watch and live-chat tickets.

create table if not exists public.q_internal_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
alter table public.q_internal_users enable row level security;
drop policy if exists q_internal_users_admin_read on public.q_internal_users;
create policy q_internal_users_admin_read on public.q_internal_users for select to authenticated using (is_platform_admin());

create table if not exists public.robot_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  mode text,
  ok boolean not null,
  failed_step text,
  message text,
  steps jsonb,
  duration_s numeric,
  build text,
  run_url text
);
create index if not exists robot_runs_at on public.robot_runs (created_at desc);
alter table public.robot_runs enable row level security;
drop policy if exists robot_runs_admin_read on public.robot_runs;
create policy robot_runs_admin_read on public.robot_runs for select to authenticated using (is_platform_admin());

-- one alert per failing step; stays open (no repeat pushes) until the robot passes again
create or replace function public.q_robot_alert(p_fp text, p_title text, p_text text, p_example jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare al record;
begin
  select * into al from admin_alerts where fingerprint = p_fp;
  if found then
    update admin_alerts
       set occurrences = occurrences + 1, last_seen = now(), updated_at = now(), title = p_title,
           error_text = left(coalesce(p_text, ''), 4000),
           examples = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(coalesce(al.examples, '[]'::jsonb) || jsonb_build_array(p_example)) e offset greatest(0, jsonb_array_length(coalesce(al.examples, '[]'::jsonb)) + 1 - 10)) x),
           status = case when al.status in ('fixed', 'ignored') then 'open' else al.status end
     where id = al.id;
  else
    insert into admin_alerts (fingerprint, service, title, error_text, occurrences, first_seen, last_seen, examples, status)
    values (p_fp, 'robot', p_title, left(coalesce(p_text, ''), 4000), 1, now(), now(), jsonb_build_array(p_example), 'open');
  end if;
end $$;
revoke all on function public.q_robot_alert(text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.q_robot_report(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_ok boolean := coalesce((p->>'ok')::boolean, false); v_step text := nullif(p->>'failed_step', '');
begin
  if not exists (select 1 from q_internal_users where user_id = auth.uid()) then
    raise exception 'not allowed';
  end if;
  insert into robot_runs (mode, ok, failed_step, message, steps, duration_s, build, run_url)
  values (left(p->>'mode', 20), v_ok, left(v_step, 120), left(p->>'message', 2000), p->'steps',
          nullif(p->>'duration_s', '')::numeric, left(p->>'build', 40), left(p->>'run_url', 300));
  if v_ok then
    update admin_alerts set status = 'fixed', updated_at = now()
     where service = 'robot' and status = 'open';
  else
    perform q_robot_alert('robot:' || coalesce(v_step, 'run'),
      'Robot check failed: ' || coalesce(v_step, 'run'),
      coalesce(p->>'message', ''),
      jsonb_build_object('at', now(), 'file', coalesce(v_step, 'run'), 'source_kind', 'robot', 'page', p->>'run_url', 'user_email', 'test robot'));
  end if;
end $$;
revoke all on function public.q_robot_report(jsonb) from public, anon;
grant execute on function public.q_robot_report(jsonb) to authenticated;

-- the robot itself went quiet (GitHub or sign-in down): alert after 75 minutes
create or replace function public.q_robot_watchdog()
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from robot_runs)
     and not exists (select 1 from robot_runs where created_at > now() - interval '75 minutes') then
    perform q_robot_alert('robot:silent', 'Robot has not reported for over an hour',
      'The test robot did not report in the last 75 minutes. The website may be down, sign-in may be failing, or the GitHub job stopped.',
      jsonb_build_object('at', now(), 'file', 'watchdog', 'source_kind', 'robot', 'user_email', 'test robot'));
  end if;
end $$;
revoke all on function public.q_robot_watchdog() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'robot-watchdog';
select cron.schedule('robot-watchdog', '*/30 * * * *', $cron$select public.q_robot_watchdog()$cron$);

-- keep the robot out of user errors and user stats
create or replace function public.q_client_error_ingest()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fp text := 'app:' || left(new.fingerprint, 300);
  al record; v_email text; v_company uuid; v_admin uuid; v_ticket uuid; recent int; ex jsonb;
begin
  -- platform admins testing do not raise alerts; a runaway browser cannot flood (30 per user per hour)
  if exists (select 1 from platform_admins where user_id = new.user_id)
     or exists (select 1 from q_internal_users where user_id = new.user_id) then return new; end if;
  select count(*) into recent from client_errors where user_id = new.user_id and created_at > now() - interval '1 hour';
  if recent > 30 then return new; end if;

  select email into v_email from auth.users where id = new.user_id;
  select company_id into v_company from profiles where id = new.user_id;
  ex := jsonb_build_object('at', now(), 'user_email', v_email, 'file', new.context, 'source_kind', 'user error', 'page', new.page);

  select * into al from admin_alerts where fingerprint = fp;
  if found then
    update admin_alerts
       set occurrences = occurrences + 1, last_seen = now(), updated_at = now(),
           examples = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(coalesce(al.examples, '[]'::jsonb) || jsonb_build_array(ex)) e offset greatest(0, jsonb_array_length(coalesce(al.examples, '[]'::jsonb)) + 1 - 10)) x),
           status = case when al.status in ('fixed', 'ignored') then 'open' else al.status end
     where id = al.id;
  else
    insert into admin_alerts (fingerprint, service, title, error_text, occurrences, first_seen, last_seen, examples, status)
    values (fp, 'app', 'Users hitting an error: ' || left(new.context, 80), left(coalesce(new.message, ''), 4000), 1, now(), now(), jsonb_build_array(ex), 'open');
  end if;

  -- live chat for the user, once per user per error per day
  if not exists (select 1 from support_tickets where user_id = new.user_id and page_context = 'auto-error:' || left(new.fingerprint, 300)
                 and created_at > now() - interval '1 day') then
    select user_id into v_admin from platform_admins limit 1;
    insert into support_tickets (user_id, company_id, contact_email, kind, category, message, page_context, status, opened_by_admin)
    values (new.user_id, v_company, v_email, 'help', 'live_chat',
            'Automatic: "' || left(new.context, 80) || '" did not work for this user. ' || left(coalesce(new.message, ''), 300),
            'auto-error:' || left(new.fingerprint, 300), 'in_progress', true)
    returning id into v_ticket;
    if v_admin is not null then
      insert into support_messages (ticket_id, sender_user_id, from_admin, body)
      values (v_ticket, v_admin, true,
        'Hi, this is the Quantora team. We saw that "' || left(new.context, 80) || '" did not work for you just now. It is a problem on our side, not something you did, and we are fixing it. We will message you right here as soon as it works again. Sorry for the trouble!');
    end if;
  end if;
  return new;
exception when others then
  raise warning 'q_client_error_ingest failed: %', sqlerrm;
  return new;
end $$;
create or replace function public.q_ops_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public, auth as $$
  with adm as (select user_id from platform_admins union select user_id from q_internal_users),
  admin_projects as (select p.id from projects p where p.owner_id in (select user_id from adm)),
  runs as (select * from analysis_runs r where r.created_at >= p_from and r.created_at < p_to
             and r.project_id not in (select id from admin_projects) and coalesce(r.is_admin_assisted, false) = false)
  select jsonb_build_object(
    'users', jsonb_build_object(
      'signups', (select count(*) from auth.users u where u.created_at >= p_from and u.created_at < p_to and u.id not in (select user_id from adm)),
      'logins',  (select count(*) from auth.users u where u.last_sign_in_at >= p_from and u.last_sign_in_at < p_to and u.id not in (select user_id from adm))),
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
    'robot', (select jsonb_build_object('runs', count(*), 'failed', count(*) filter (where not ok),
                'last_at', max(created_at), 'last_ok', (select ok from robot_runs order by created_at desc limit 1))
                from robot_runs where created_at >= p_from and created_at < p_to),
    'alerts_new',  (select count(*) from admin_alerts where first_seen >= p_from and first_seen < p_to),
    'alerts_open', (select count(*) from admin_alerts where status = 'open'),
    'stuck_runs',  (select count(*) from analysis_runs where status = 'processing' and created_at < now() - interval '30 minutes' and created_at > now() - interval '1 day'),
    'stuck_jobs',  (select count(*) from draftsman_jobs where status in ('queued', 'running') and created_at < now() - interval '60 minutes' and created_at > now() - interval '1 day')
  );
$$;
revoke all on function public.q_ops_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.q_ops_stats(timestamptz, timestamptz) to service_role;
