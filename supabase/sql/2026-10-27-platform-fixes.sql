-- 2026-10-27: platform fixes from the audit. Safe to run more than once.

-- 1. Admin Assist usage was never recorded: ai-engine bills those runs as
--    'admin_comp', which this check did not allow, so every insert failed and
--    admin-assisted AI cost was missing from the analytics (0 rows ever).
alter table public.ai_usage drop constraint if exists ai_usage_billed_from_check;
alter table public.ai_usage add constraint ai_usage_billed_from_check
  check (billed_from is null or billed_from = any (array['free_quota','wallet','admin_comp']));

-- 2. Admin Assist "Could not check analysis status": the app polls
--    analysis_runs as the signed-in admin, and RLS hides a customer's runs from
--    anyone outside their team. This returns just the status fields to a
--    platform admin.
create or replace function public.admin_run_status(p_run_id uuid)
returns table (status text, summary jsonb, error_message text, run_kind text, change_reason text, project_id uuid)
language plpgsql security definer set search_path = public
as $$
begin
  if not is_platform_admin() then raise exception 'Only a platform admin can read another company''s run.'; end if;
  return query select r.status, r.summary, r.error_message, r.run_kind, r.change_reason, r.project_id
    from analysis_runs r where r.id = p_run_id;
end $$;
revoke all on function public.admin_run_status(uuid) from public, anon;
grant execute on function public.admin_run_status(uuid) to authenticated;

create or replace function public.admin_drawing_classification(p_drawing_id uuid)
returns table (classification_status text, total_pages_detected integer)
language plpgsql security definer set search_path = public
as $$
begin
  if not is_platform_admin() then raise exception 'Only a platform admin can read another company''s drawing.'; end if;
  return query select d.classification_status, d.total_pages_detected from drawings d where d.id = p_drawing_id;
end $$;
revoke all on function public.admin_drawing_classification(uuid) from public, anon;
grant execute on function public.admin_drawing_classification(uuid) to authenticated;

-- 3. Admin Assist reads big sheets at high resolution, the same as the
--    customer's own button: that needs the admin to open the PDF and write the
--    temporary tiles in the project's folder. Platform admins only.
create or replace function public.team_can_view_path(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$'
              then public.team_can_view(split_part(p_name, '/', 1)::uuid) or public.is_platform_admin()
              else false end;
$$;
create or replace function public.team_can_write_path(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$'
              then public.team_can_write(split_part(p_name, '/', 1)::uuid, 'est') or public.is_platform_admin()
              else false end;
$$;

-- 4. The refund helpers refuse anyone who is not allowed, but should not be
--    callable without signing in at all.
revoke execute on function public.run_charge(uuid) from anon;
revoke execute on function public.admin_refund_ticket(uuid, integer, text) from anon;
