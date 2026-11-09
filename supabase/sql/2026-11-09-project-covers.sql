-- 2026-11-09  Project cover photos (approved by the owner). Applied as migration project_cover_photos_2026_11_09.
alter table public.projects add column if not exists cover_path text;
alter table public.projects add column if not exists cover_updated_at timestamptz;
grant update (cover_path, cover_updated_at) on public.projects to authenticated;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-covers', 'project-covers', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
drop policy if exists project_covers_select on storage.objects;
drop policy if exists project_covers_insert on storage.objects;
drop policy if exists project_covers_update on storage.objects;
drop policy if exists project_covers_delete on storage.objects;
create policy project_covers_select on storage.objects for select to authenticated using (bucket_id = 'project-covers' and public.team_can_view_path(name));
create policy project_covers_insert on storage.objects for insert to authenticated with check (bucket_id = 'project-covers' and public.team_can_write_path(name));
create policy project_covers_update on storage.objects for update to authenticated using (bucket_id = 'project-covers' and public.team_can_write_path(name)) with check (bucket_id = 'project-covers' and public.team_can_write_path(name));
create policy project_covers_delete on storage.objects for delete to authenticated using (bucket_id = 'project-covers' and public.team_can_write_path(name));
