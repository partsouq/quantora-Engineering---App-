-- ===========================================================================
-- Draftsman jobs have their own project allowance (25 Oct 2026)
-- A draftsman job is stored as a project (project_scope = drafting service).
-- Before, it shared the plan's project limit with take-off projects, so a
-- Welcome Pack user (1 project) could try take-off OR draftsman, not both.
-- Now each kind is counted on its own against max_projects. What a user can
-- actually generate is still capped by the plan's drawing / draftsman pages.
-- ===========================================================================
create or replace function public.enforce_project_limit()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  v_plan_id text;
  v_max_projects integer;
  v_current_count integer;
  v_dft boolean := coalesce(new.project_scope, '') like 'Shop drawings — drafting service%';
begin
  if new.company_id is null then
    return new; -- no company attributed yet: fail open rather than block a provisioning race
  end if;
  select plan into v_plan_id from public.companies where id = new.company_id;
  if v_plan_id is null then return new; end if;
  select max_projects into v_max_projects from public.plans where id = v_plan_id;
  if v_max_projects is null then return new; end if;   -- unlimited

  select count(*) into v_current_count from public.projects
   where company_id = new.company_id
     and (coalesce(project_scope, '') like 'Shop drawings — drafting service%') = v_dft;
  if v_current_count >= v_max_projects then
    raise exception 'PROJECT_LIMIT_REACHED: Your % plan allows a maximum of % % project(s). Upgrade to create more.',
      v_plan_id, v_max_projects, case when v_dft then 'draftsman' else 'take-off' end;
  end if;
  return new;
end;
$function$;
