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
