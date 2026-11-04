-- 2026-11-04 Fewer false "robot has not reported" alerts.
-- GitHub sometimes skips scheduled robot runs for hours even when the website is fine.
-- The watchdog now checks the website itself first: if the site answers, it waits 4 hours of robot
-- silence before alerting; if the site does not answer, it alerts after 75 minutes as before.
-- The dispatch job ignores the token until a real GitHub token (github_pat_... / ghp_...) is saved.
create or replace function public.q_robot_dispatch() returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text; rid bigint;
begin
  select value into tok from app_secrets where key = 'GITHUB_ROBOT_TOKEN';
  if coalesce(tok, '') !~ '^(github_pat_|ghp_)' then return null; end if;
  select net.http_post(
    url := 'https://api.github.com/repos/partsouq/quantora-Engineering---App-/actions/workflows/robot.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'quantora-robot-dispatch', 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('full', 'false'))) into rid;
  return rid;
end $$;
revoke all on function public.q_robot_dispatch() from public, anon, authenticated;

-- Remember the last website check so the watchdog can read it on its next run.
create table if not exists public.robot_site_checks (id bigint primary key, req_id bigint, checked_at timestamptz default now());
alter table public.robot_site_checks enable row level security;

create or replace function public.q_robot_watchdog() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare last_run timestamptz; prev record; site_ok boolean;
begin
  select max(created_at) into last_run from robot_runs;
  if last_run is null then return; end if;
  -- result of the website check started 30 minutes ago
  select * into prev from robot_site_checks where id = 1;
  if prev.req_id is not null then
    select status_code between 200 and 399 into site_ok from net._http_response where id = prev.req_id;
  end if;
  -- start the next website check
  insert into robot_site_checks (id, req_id, checked_at)
  values (1, net.http_get('https://quantoraengineering.com/?robot-watchdog=' || extract(epoch from now())::bigint), now())
  on conflict (id) do update set req_id = excluded.req_id, checked_at = excluded.checked_at;
  if last_run < now() - interval '75 minutes' and site_ok is false then
    perform q_robot_alert('robot:site-down', 'Website did not answer',
      'The website did not answer the server check and the test robot has not reported for over an hour.',
      jsonb_build_object('at', now(), 'file', 'watchdog', 'source_kind', 'robot', 'user_email', 'test robot'));
  elsif last_run < now() - interval '4 hours' then
    perform q_robot_alert('robot:silent', 'Robot has not reported for 4 hours',
      'The website answers, but the test robot has not reported for 4 hours. GitHub may be skipping the scheduled job.',
      jsonb_build_object('at', now(), 'file', 'watchdog', 'source_kind', 'robot', 'user_email', 'test robot'));
  end if;
end $$;
