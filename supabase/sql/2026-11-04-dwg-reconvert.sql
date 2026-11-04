-- 2026-11-04 Re-convert DWG files with the improved converter (leader labels, diagnostics).
-- A new conversion may replace an earlier automatic one (path ..._dwg_<drawing id>.pdf), never an
-- export the user attached themselves.
create or replace function public.q_dwg_finish(p_job uuid, p_ok boolean, p_error text, p_path text, p_pages int, p_report jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare j dwg_jobs;
begin
  select * into j from dwg_jobs where id = p_job for update;
  if not found then return; end if;
  if p_ok then
    update dwg_jobs set status = 'done', finished_at = now(), error = null, pages = p_pages, report = p_report where id = p_job;
    update drawings set analysis_source_path = p_path, analysis_source_type = 'pdf',
      total_pages_detected = coalesce(p_pages, total_pages_detected)
    where id = j.drawing_id
      and (analysis_source_path is null or analysis_source_path ~ ('_dwg_' || j.drawing_id::text || '\.pdf$'));
  elsif j.attempts < 3 then
    update dwg_jobs set status = 'queued', error = p_error where id = p_job;
  else
    update dwg_jobs set status = 'failed', finished_at = now(), error = p_error where id = p_job;
  end if;
end $$;
revoke all on function public.q_dwg_finish(uuid, boolean, text, text, int, jsonb) from public, anon, authenticated;

-- queue every DWG again
update public.dwg_jobs set status = 'queued', attempts = 0, error = null, started_at = null, finished_at = null, preview_jpg = null
where status in ('done', 'failed');
