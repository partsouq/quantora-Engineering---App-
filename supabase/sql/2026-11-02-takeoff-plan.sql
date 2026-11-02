-- 2026-11-02 Take-off plan: Manual Take-off only, $12/month, 150 drawings a month.
-- No AI pages. Projects and users are not limited (only drawings count).
-- A drawing = one page of one uploaded file, counted once a month when first marked;
-- usage rows are never deleted, so deleting a drawing does not give it back.
insert into public.plans (id, name, price_usd, monthly_drawing_analyses, monthly_ai_requests, max_projects, max_users,
  max_drawing_pages, max_rework_per_project, max_chat_requests, is_trial, trial_duration_days, quota_period,
  max_design_requests, max_classify_pages, max_overage_cents, max_draftsman_pages, workspace_access,
  workspace_preview_days, storage_gb, max_documents, mt_drawings_month)
values ('takeoff', 'Take-off', 12, 0, 0, 100000, 100000,
  0, 0, 0, false, null, 'monthly',
  0, 0, 0, 0, array['projects','draftsman'],
  0, 10, 0, 150)
on conflict (id) do update set name = excluded.name, price_usd = excluded.price_usd, max_projects = excluded.max_projects,
  max_users = excluded.max_users, mt_drawings_month = excluded.mt_drawings_month, max_drawing_pages = 0, max_overage_cents = 0;

-- Allow companies to be on the new plan.
alter table public.companies drop constraint if exists companies_plan_check;
alter table public.companies add constraint companies_plan_check
  check (plan = any (array['trial','starter','professional','business','free','enterprise','takeoff']));

-- Attaching a file to Manual Take-off counts every sheet in it at once (all or nothing).
-- p_keys = one key per sheet ("<drawing id>:p<page>"). Sheets already counted this month are free.
create or replace function public.q_mt_use_sheets(p_project uuid, p_keys text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_co uuid; q jsonb; v_month date := date_trunc('month', now())::date; v_new int; v_keys text[];
begin
  select company_id into v_co from profiles where id = auth.uid();
  if v_co is null or not exists (select 1 from projects where id = p_project and company_id = v_co) and not is_platform_admin() then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select coalesce(array_agg(distinct left(k, 120)), '{}') into v_keys from unnest(coalesce(p_keys, '{}')) k where k is not null and k <> '';
  if array_length(v_keys, 1) > 500 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  select count(*) into v_new from unnest(v_keys) k
    where not exists (select 1 from mt_sheet_usage u where u.company_id = v_co and u.month = v_month and u.sheet_key = p_project::text || ':' || k);
  q := q_mt_quota();
  if v_new > 0 and not (q->>'unlimited')::boolean and (q->>'used')::int + v_new > (q->>'allowance')::int then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'needed', v_new) || q;
  end if;
  insert into mt_sheet_usage (company_id, month, sheet_key, project_id, user_id)
  select v_co, v_month, p_project::text || ':' || k, p_project, auth.uid() from unnest(v_keys) k on conflict do nothing;
  return jsonb_build_object('ok', true, 'counted', v_new) || q_mt_quota();
end $$;
revoke all on function public.q_mt_use_sheets(uuid, text[]) from public, anon;
grant execute on function public.q_mt_use_sheets(uuid, text[]) to authenticated;
