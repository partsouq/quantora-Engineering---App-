-- Stuck take-off runs (2026-11-05, Vadiraj, E SPACE Pune).
-- The server stops a job at its time limit (about 6.5 minutes). A long two-floor sheet was stopped after
-- its 36 BOQ lines were saved but before the run was marked complete, so it sat on "processing" and the
-- customer never saw the BOQ; run-doctor only looks at failed or completed runs.
-- Every 5 minutes, a run still "processing" after 20 minutes is closed:
--   - lines were saved  -> completed with those lines (the civil measurer then runs as usual)
--   - nothing was saved -> failed "timed out", which run-doctor re-runs once for free
create or replace function public.q_close_stuck_runs() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; c int;
begin
  for r in select id, summary from analysis_runs
           where status = 'processing' and created_at < now() - interval '20 minutes'
             and created_at > now() - interval '2 days'
           for update skip locked
  loop
    -- a civil / HVAC run held for the measuring worker is not stuck
    if exists (select 1 from civil_measure_jobs j where j.analysis_run_id = r.id and j.status in ('queued','running')) then
      continue;
    end if;
    select count(*) into c from boq_items where analysis_run_id = r.id;
    if c > 0 then
      update analysis_runs set status = 'completed', completed_at = now(),
        summary = coalesce(r.summary, '{}'::jsonb) || jsonb_build_object('item_count', c, 'closed_by', 'stuck-run watchdog')
      where id = r.id;
    else
      update analysis_runs set status = 'failed', completed_at = now(),
        error_message = 'The take-off timed out before it finished. Nothing was charged.'
      where id = r.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.q_close_stuck_runs() from public, anon, authenticated;
select cron.unschedule('stuck-run-watch') where exists (select 1 from cron.job where jobname = 'stuck-run-watch');
select cron.schedule('stuck-run-watch', '*/5 * * * *', 'select public.q_close_stuck_runs()');
