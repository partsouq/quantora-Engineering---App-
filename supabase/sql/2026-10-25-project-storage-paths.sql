-- 2026-10-25: deleting a project removes ALL of its files.
-- Before, the app removed only the uploaded drawings (drawings.storage_path);
-- generated files (draftsman/, design/, tiles/, civil/ ...) and tender
-- documents stayed in storage. The app now asks for every path first,
-- removes them through the Storage API (normal storage policies still
-- apply), and deletes the project only when all of them are gone.
create or replace function public.project_storage_paths(p_project uuid)
returns table (bucket text, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.team_can_write_path(p_project::text || '/x') or public.is_platform_admin()) then
    raise exception 'Not allowed to delete this project';
  end if;
  return query
    select o.bucket_id::text, o.name::text from storage.objects o
     where o.bucket_id = 'drawings' and split_part(o.name, '/', 1) = p_project::text
    union
    select 'drawings', d.storage_path from public.drawings d
     where d.project_id = p_project and d.storage_path is not null
       and exists (select 1 from storage.objects o where o.bucket_id = 'drawings' and o.name = d.storage_path)
    union
    select o.bucket_id::text, o.name::text from storage.objects o
     join public.tenders t on t.id::text = split_part(o.name, '/', 1)
     where o.bucket_id = 'tenders' and t.project_id = p_project;
end $$;

revoke all on function public.project_storage_paths(uuid) from public, anon;
grant execute on function public.project_storage_paths(uuid) to authenticated, service_role;

-- Same list for welcome-cleanup (service role), for many projects at once.
create or replace function public.admin_storage_for_projects(p_ids uuid[])
returns table (bucket text, name text, size bigint)
language sql stable security definer set search_path = '' as $$
  select o.bucket_id::text, o.name::text, coalesce((o.metadata->>'size')::bigint, 0)
    from storage.objects o
   where o.bucket_id = 'drawings' and split_part(o.name, '/', 1) = any(select x::text from unnest(p_ids) x)
  union
  select o.bucket_id::text, o.name::text, coalesce((o.metadata->>'size')::bigint, 0)
    from storage.objects o join public.drawings d on d.storage_path = o.name
   where o.bucket_id = 'drawings' and d.project_id = any(p_ids)
  union
  select o.bucket_id::text, o.name::text, coalesce((o.metadata->>'size')::bigint, 0)
    from storage.objects o join public.tenders t on t.id::text = split_part(o.name, '/', 1)
   where o.bucket_id = 'tenders' and t.project_id = any(p_ids);
$$;
revoke all on function public.admin_storage_for_projects(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_storage_for_projects(uuid[]) to service_role;
