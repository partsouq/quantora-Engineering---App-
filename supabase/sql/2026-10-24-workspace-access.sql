-- Quantora: workspace access by plan (24 Oct 2026)
--
-- Commercial and Operations were open to every account forever, because only
-- the AI features check the plan. Now each plan lists the workspaces it
-- includes, and a plan can give a preview of the others for a number of days.
--
--   Paid plans (Individual, Professional, Team, Enterprise): all four workspaces.
--   Free welcome pack: Projects and Draftsman, plus a 7-day preview of
--   Commercial and Operations. After the preview those two are read-only:
--   the data stays and comes back the moment the account subscribes.
--
-- Existing welcome-pack accounts get their 7 days from 25 Oct 2026, so nobody
-- is locked out the day this goes live.
--
-- To change what a plan includes later ("stage limits"), edit
-- plans.workspace_access / plans.workspace_preview_days. No code change needed.

alter table public.plans add column if not exists workspace_access text[] not null
  default '{projects,draftsman}';
alter table public.plans add column if not exists workspace_preview_days integer not null default 0;

update public.plans set workspace_access = '{projects,commercial,operations,draftsman}'
 where id in ('starter', 'professional', 'business', 'enterprise');
update public.plans set workspace_preview_days = 7 where id = 'trial';

-- Access for one company, per workspace: {allowed, mode: plan|preview|locked, ends_at}
create or replace function public.workspace_access_for(p_company uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with c as (
    select co.trial_start_date, co.created_at,
           coalesce(pl.workspace_access, '{projects,draftsman}') as wa,
           coalesce(pl.workspace_preview_days, 0) as pd
      from companies co left join plans pl on pl.id = coalesce(co.plan, 'free')
     where co.id = p_company
  ), s as (
    select wa, pd,
           greatest(coalesce(trial_start_date, created_at, now()), timestamptz '2026-10-25 00:00+04')
             + make_interval(days => pd) as preview_end
      from c
  )
  select coalesce(jsonb_object_agg(w,
           case when w = any(s.wa) then jsonb_build_object('allowed', true, 'mode', 'plan')
                when s.pd > 0 and now() < s.preview_end
                  then jsonb_build_object('allowed', true, 'mode', 'preview', 'ends_at', s.preview_end)
                else jsonb_build_object('allowed', false, 'mode', 'locked',
                       'ends_at', case when s.pd > 0 then s.preview_end end)
           end), '{}'::jsonb)
    from s, unnest(array['projects', 'commercial', 'operations', 'draftsman']) w;
$$;
revoke execute on function public.workspace_access_for(uuid) from public, anon, authenticated;

-- What the signed-in user's company may use. Read by the app to draw the locks.
create or replace function public.my_workspace_access()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select public.workspace_access_for(
    (select company_id from profiles where id = (select auth.uid())));
$$;
revoke execute on function public.my_workspace_access() from public, anon;
grant execute on function public.my_workspace_access() to authenticated;

-- Used by the write rules below.
create or replace function public.project_workspace_allowed(p_project uuid, p_ws text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((public.workspace_access_for(
           (select coalesce(p.company_id, pr.company_id)
              from projects p left join profiles pr on pr.id = p.owner_id
             where p.id = p_project)) -> p_ws ->> 'allowed')::boolean, false);
$$;
create or replace function public.company_workspace_allowed(p_company uuid, p_ws text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((public.workspace_access_for(p_company) -> p_ws ->> 'allowed')::boolean, false);
$$;
revoke execute on function public.project_workspace_allowed(uuid, text) from public, anon;
revoke execute on function public.company_workspace_allowed(uuid, text) from public, anon;
grant execute on function public.project_workspace_allowed(uuid, text) to authenticated;
grant execute on function public.company_workspace_allowed(uuid, text) to authenticated;

-- Write rules. Restrictive, so they add to the existing owner rules: reading
-- is unchanged (locked accounts still see their data), adding, changing and
-- deleting need the workspace.
do $$
declare t text; ws text;
begin
  for t, ws in select * from (values
      ('project_contracts', 'commercial'), ('payment_applications', 'commercial'),
      ('payment_receipts', 'commercial'),
      ('project_issues', 'operations'), ('project_milestones', 'operations'),
      ('project_inspections', 'operations'), ('project_applications', 'operations')) v(t, ws)
  loop
    execute format('drop policy if exists %I on public.%I', t || '_ws_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_ws_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_ws_delete', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.project_workspace_allowed(project_id, %L))', t || '_ws_insert', t, ws);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.project_workspace_allowed(project_id, %L)) with check (public.project_workspace_allowed(project_id, %L))', t || '_ws_update', t, ws, ws);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.project_workspace_allowed(project_id, %L))', t || '_ws_delete', t, ws);
  end loop;
end $$;

drop policy if exists sales_targets_ws_insert on public.sales_targets;
drop policy if exists sales_targets_ws_update on public.sales_targets;
drop policy if exists sales_targets_ws_delete on public.sales_targets;
create policy sales_targets_ws_insert on public.sales_targets as restrictive for insert to authenticated
  with check (public.company_workspace_allowed(company_id, 'commercial'));
create policy sales_targets_ws_update on public.sales_targets as restrictive for update to authenticated
  using (public.company_workspace_allowed(company_id, 'commercial'))
  with check (public.company_workspace_allowed(company_id, 'commercial'));
create policy sales_targets_ws_delete on public.sales_targets as restrictive for delete to authenticated
  using (public.company_workspace_allowed(company_id, 'commercial'));
