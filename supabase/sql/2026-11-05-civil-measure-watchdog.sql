-- 2026-11-05 A civil / duct measure job left "running" by a worker that stopped (out of memory, redeploy)
-- is put back in the queue after 15 minutes, up to 3 times, then marked failed. Before this a stuck job
-- stayed "running" for ever (Hesham's partition sheet, 2026-11-04).
alter table public.civil_measure_jobs add column if not exists attempts int not null default 0;

create or replace function public.q_civil_measure_watch() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update civil_measure_jobs
     set status = case when attempts >= 2 then 'failed' else 'queued' end,
         attempts = attempts + 1,
         error = coalesce(error, 'The measuring worker stopped before finishing.'),
         worker = null, started_at = null,
         finished_at = case when attempts >= 2 then now() else null end
   where status = 'running' and started_at < now() - interval '15 minutes';
end $$;
revoke all on function public.q_civil_measure_watch() from public, anon, authenticated;
select cron.unschedule('civil-measure-watch') where exists (select 1 from cron.job where jobname = 'civil-measure-watch');
select cron.schedule('civil-measure-watch', '*/5 * * * *', 'select public.q_civil_measure_watch()');
