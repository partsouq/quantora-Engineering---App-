-- 2026-11-04 A small JPEG of sheet 1 (base64) kept with each DWG job, so the admin can check a conversion.
alter table public.dwg_jobs add column if not exists preview_jpg text;
