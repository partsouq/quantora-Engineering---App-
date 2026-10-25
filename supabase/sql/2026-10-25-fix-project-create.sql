-- Fix (25 Oct 2026, APPLIED to production): creating a project failed since the
-- 24 Oct team-access change. The app inserts a project and reads it back
-- (insert ... returning). The SELECT policy called team_can_view(id), which looks
-- the project up again and cannot see the row being inserted, so every create
-- was refused with "new row violates row-level security policy".
-- The policy now checks the row's own columns; who can see what is unchanged.
alter policy projects_team_select on projects using (
  owner_id = (select auth.uid())
  or (company_id is not null and company_id = public.team_company()
      and (coalesce((select project_scope from profiles where id = (select auth.uid())), 'all') = 'all'
           or exists (select 1 from member_projects m where m.user_id = (select auth.uid()) and m.project_id = projects.id))));
