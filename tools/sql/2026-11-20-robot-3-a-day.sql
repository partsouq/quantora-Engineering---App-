-- 2026-11-20 (owner approved): the test robot runs 3 times a day -- 08:07, 14:07, 20:07 Dubai (04:07, 10:07, 16:07 UTC).
-- The website is still checked every 30 minutes by robot-watchdog (no GitHub minutes).
select cron.alter_job((select jobid from cron.job where jobname = 'robot-dispatch'), schedule := '7 4,10,16 * * *');

create or replace function public.q_robot_watchdog()
 returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare last_run timestamptz; prev record; site_ok boolean;
begin
  select max(created_at) into last_run from robot_runs;
  select * into prev from robot_site_checks where id = 1;
  if prev.req_id is not null then
    select status_code between 200 and 399 into site_ok from net._http_response where id = prev.req_id;
  end if;
  insert into robot_site_checks (id, req_id, checked_at)
  values (1, net.http_get('https://quantoraengineering.com/?robot-watchdog=' || extract(epoch from now())::bigint), now())
  on conflict (id) do update set req_id = excluded.req_id, checked_at = excluded.checked_at;
  -- the website check no longer waits for the robot: it runs every 30 minutes on its own
  if site_ok is false then
    perform q_robot_alert('robot:site-down', 'Website did not answer',
      'The website did not answer the 30-minute server check.',
      jsonb_build_object('at', now(), 'file', 'watchdog', 'source_kind', 'robot', 'user_email', 'test robot'));
  elsif last_run is not null and last_run < now() - interval '9 hours' then
    perform q_robot_alert('robot:silent', 'Robot has not reported for 9 hours',
      'The website answers, but the test robot (3 runs a day) has not reported for 9 hours. Check GitHub Actions.',
      jsonb_build_object('at', now(), 'file', 'watchdog', 'source_kind', 'robot', 'user_email', 'test robot'));
  end if;
end $function$;
