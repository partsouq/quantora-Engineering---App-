-- 2026-11-03 Operations: Material tracker + daily site reports (My day).
-- Same access rules as project issues and inspections: the project team can see,
-- people with Operations write access can add and change.

create table if not exists public.material_progress (
  project_id uuid not null references public.projects(id) on delete cascade,
  item_key text not null,                  -- the BOQ line (system + item identity), stable across AI re-runs
  system_category text, description text, unit text,
  ordered numeric, delivered numeric, installed numeric,
  note text,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (project_id, item_key)
);
alter table public.material_progress enable row level security;
drop policy if exists material_progress_select on public.material_progress;
drop policy if exists material_progress_insert on public.material_progress;
drop policy if exists material_progress_update on public.material_progress;
drop policy if exists material_progress_delete on public.material_progress;
create policy material_progress_select on public.material_progress for select to authenticated using (team_can_view(project_id));
create policy material_progress_insert on public.material_progress for insert to authenticated
  with check (team_can_write(project_id, 'ops') or project_workspace_allowed(project_id, 'operations'));
create policy material_progress_update on public.material_progress for update to authenticated
  using (team_can_write(project_id, 'ops') or project_workspace_allowed(project_id, 'operations'))
  with check (team_can_write(project_id, 'ops') or project_workspace_allowed(project_id, 'operations'));
create policy material_progress_delete on public.material_progress for delete to authenticated
  using (team_can_write(project_id, 'ops') or project_workspace_allowed(project_id, 'operations'));

create table if not exists public.site_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  report_date date not null default current_date,
  manpower int, work_done text, delays text, weather text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists site_reports_project_date on public.site_reports (project_id, report_date desc);
alter table public.site_reports enable row level security;
drop policy if exists site_reports_select on public.site_reports;
drop policy if exists site_reports_insert on public.site_reports;
drop policy if exists site_reports_update on public.site_reports;
drop policy if exists site_reports_delete on public.site_reports;
create policy site_reports_select on public.site_reports for select to authenticated using (team_can_view(project_id));
create policy site_reports_insert on public.site_reports for insert to authenticated
  with check (team_can_write(project_id, 'ops') or project_workspace_allowed(project_id, 'operations'));
create policy site_reports_update on public.site_reports for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy site_reports_delete on public.site_reports for delete to authenticated using (created_by = auth.uid());
