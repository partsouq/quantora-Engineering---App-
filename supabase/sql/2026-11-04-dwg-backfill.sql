-- 2026-11-04 Queue the DWG files that were uploaded before automatic conversion existed
-- (26 files from 2 users, none of them analysed). Run once, after 2026-11-04-dwg-convert.sql.
insert into public.dwg_jobs (drawing_id, project_id, storage_path)
select d.id, d.project_id, d.storage_path
from public.drawings d
where lower(coalesce(d.file_type, '')) = 'dwg' and d.analysis_source_path is null and coalesce(d.storage_path, '') <> ''
  and not exists (select 1 from public.dwg_jobs j where j.drawing_id = d.id);
select public.q_dwg_dispatch();
