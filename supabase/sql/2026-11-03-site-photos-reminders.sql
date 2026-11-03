-- 2026-11-03 Site photos in the daily site report + "Remind" for payments and inspections.

-- 1) Photos taken with a daily site report (storage paths in the drawings bucket).
alter table public.site_reports add column if not exists photos text[] not null default '{}';

-- 2) When the team last sent a reminder (shown as "Reminded 3d ago").
alter table public.project_applications add column if not exists last_reminded_at timestamptz;
alter table public.project_inspections add column if not exists last_reminded_at timestamptz;

-- 3) Site photos live in the drawings bucket under <project id>/site/...
--    The existing drawings rules only let estimators upload. Operations people who may write site
--    reports for the project may upload (and remove) photos in that project's site/ folder only.
--    Viewing uses the existing drawings_team_select rule (anyone who can see the project).
drop policy if exists drawings_site_photos_insert on storage.objects;
create policy drawings_site_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'drawings' and split_part(name, '/', 2) = 'site'
              and split_part(name, '/', 1) ~ '^[0-9a-f-]{36}$'
              and public.team_can_write(split_part(name, '/', 1)::uuid, 'ops'));
drop policy if exists drawings_site_photos_delete on storage.objects;
create policy drawings_site_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'drawings' and split_part(name, '/', 2) = 'site'
         and split_part(name, '/', 1) ~ '^[0-9a-f-]{36}$'
         and public.team_can_write(split_part(name, '/', 1)::uuid, 'ops'));
