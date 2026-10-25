-- 2026-10-25: admin-analytics read storage.objects through the REST API, which
-- does not expose the storage schema, so System Health showed "0 B, 0 files".
-- These two read-only functions give the service role (only) the numbers.
create or replace function public.admin_storage_totals()
returns table (total_bytes bigint, total_objects bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint, count(*)::bigint from storage.objects o;
$$;

create or replace function public.admin_storage_objects()
returns table (name text, size bigint)
language sql stable security definer set search_path = '' as $$
  select o.name, coalesce((o.metadata->>'size')::bigint, 0) from storage.objects o;
$$;

revoke all on function public.admin_storage_totals() from public, anon, authenticated;
revoke all on function public.admin_storage_objects() from public, anon, authenticated;
grant execute on function public.admin_storage_totals() to service_role;
grant execute on function public.admin_storage_objects() to service_role;
