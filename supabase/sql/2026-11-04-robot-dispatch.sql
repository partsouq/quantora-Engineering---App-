-- 2026-11-04 Start the test robot from our own server every 30 minutes.
-- GitHub delays or skips free scheduled jobs when it is busy (overnight it ran 3 times instead of ~30),
-- so pg_cron now asks GitHub to run the "Test robot" workflow at :07 and :37 of every hour.
-- The GitHub token lives in app_secrets (key GITHUB_ROBOT_TOKEN), set by the owner, never in code.
-- Without the token the function does nothing. The GitHub schedule stays as a backup.
create or replace function public.q_robot_dispatch() returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text; rid bigint;
begin
  select value into tok from app_secrets where key = 'GITHUB_ROBOT_TOKEN';
  if coalesce(tok, '') = '' then return null; end if;
  select net.http_post(
    url := 'https://api.github.com/repos/partsouq/quantora-Engineering---App-/actions/workflows/robot.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'quantora-robot-dispatch',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('full', 'false'))
  ) into rid;
  return rid;
end $$;
revoke all on function public.q_robot_dispatch() from public, anon, authenticated;

select cron.unschedule('robot-dispatch') where exists (select 1 from cron.job where jobname = 'robot-dispatch');
select cron.schedule('robot-dispatch', '7,37 * * * *', 'select public.q_robot_dispatch()');
