-- Quantora: team access (24 Oct 2026)
--
-- Before this, every project, drawing and BOQ was visible only to the person
-- who created it, so a team of five was five separate accounts on one bill.
-- Now a company's projects are shared with its members, by role:
--
--   owner       everything, including billing and the plan
--   admin       everything except ownership; manages the team
--   estimator   projects, drawings, take-off, BOQ, draftsman; logs site issues
--   commercial  contracts, claims, collection, sales; logs site issues; views projects
--   viewer      sees and exports, changes nothing
--
-- Each member can also be limited to some workspaces (profiles.workspace_access,
-- null = what the role allows) and to selected projects (project_scope =
-- 'selected' + member_projects). The plan's own workspace rules still apply.
-- Whoever created a project can always see it.

-- 1. Member settings ---------------------------------------------------------
alter table public.profiles add column if not exists workspace_access text[];
alter table public.profiles add column if not exists project_scope text not null default 'all';
alter table public.profiles drop constraint if exists profiles_project_scope_check;
alter table public.profiles add constraint profiles_project_scope_check check (project_scope in ('all', 'selected'));

alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles p set role = 'owner'
  from public.companies c where c.created_by_user_id = p.id and p.company_id = c.id and coalesce(p.role, '') <> 'owner';
update public.profiles set role = 'estimator' where role is null or role not in ('owner', 'admin', 'estimator', 'commercial', 'viewer');
alter table public.profiles add constraint profiles_role_check check (role in ('owner', 'admin', 'estimator', 'commercial', 'viewer'));

create table if not exists public.member_projects (
  user_id    uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  primary key (user_id, project_id)
);
alter table public.member_projects enable row level security;

alter table public.company_invites add column if not exists role text not null default 'estimator';
alter table public.company_invites add column if not exists workspace_access text[];
alter table public.company_invites add column if not exists project_scope text not null default 'all';
alter table public.company_invites add column if not exists project_ids uuid[];
alter table public.company_invites drop constraint if exists company_invites_role_check;
alter table public.company_invites add constraint company_invites_role_check check (role in ('admin', 'estimator', 'commercial', 'viewer'));

alter table public.companies add column if not exists extra_seats integer not null default 0;

create table if not exists public.team_audit (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  actor        uuid,
  target_user  uuid,
  target_email text,
  action       text not null,
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists team_audit_company on public.team_audit (company_id, created_at desc);
alter table public.team_audit enable row level security;

-- 2. Who am I ----------------------------------------------------------------
create or replace function public.team_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role from profiles where id = (select auth.uid())), 'owner');
$$;
create or replace function public.team_company() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select company_id from profiles where id = (select auth.uid());
$$;

-- Workspaces a member may change things in.
create or replace function public.team_ws_ok(p_ws text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when pr.workspace_access is not null then p_ws = any(pr.workspace_access)
    else true end
  from (select (select workspace_access from profiles where id = (select auth.uid())) as workspace_access) pr;
$$;

create or replace function public.team_can_view(p_project uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from projects p
     where p.id = p_project
       and (p.owner_id = (select auth.uid())
            or (p.company_id is not null and p.company_id = public.team_company()
                and (coalesce((select project_scope from profiles where id = (select auth.uid())), 'all') = 'all'
                     or exists (select 1 from member_projects m where m.user_id = (select auth.uid()) and m.project_id = p.id)))));
$$;

-- grp: est (projects, take-off, BOQ), dft (draftsman), com (contracts, claims,
-- collection), ops (programme, site issues).
create or replace function public.team_can_write(p_project uuid, p_grp text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.team_can_view(p_project) and case p_grp
    when 'est' then public.team_role() in ('owner', 'admin', 'estimator') and public.team_ws_ok('projects')
    when 'dft' then public.team_role() in ('owner', 'admin', 'estimator') and public.team_ws_ok('draftsman')
    when 'com' then public.team_role() in ('owner', 'admin', 'commercial') and public.team_ws_ok('commercial')
    when 'ops' then public.team_role() in ('owner', 'admin', 'commercial', 'estimator') and public.team_ws_ok('operations')
    else false end;
$$;

create or replace function public.team_can_view_path(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$'
              then public.team_can_view(split_part(p_name, '/', 1)::uuid) else false end;
$$;
create or replace function public.team_can_write_path(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$'
              then public.team_can_write(split_part(p_name, '/', 1)::uuid, 'est') else false end;
$$;

-- For the edge functions (service role): what can this user do on this project?
create or replace function public.project_access_for(p_user uuid, p_project uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pr record; p record;
begin
  select * into p from projects where id = p_project;
  if p.id is null then return null; end if;
  select * into pr from profiles where id = p_user;
  if p.owner_id = p_user and coalesce(pr.role, 'owner') <> 'viewer' then return 'edit'; end if;
  if p.owner_id <> p_user and (p.company_id is null or pr.company_id is distinct from p.company_id) then return null; end if;
  if p.owner_id <> p_user and coalesce(pr.project_scope, 'all') = 'selected'
     and not exists (select 1 from member_projects m where m.user_id = p_user and m.project_id = p_project) then return null; end if;
  if coalesce(pr.role, 'owner') in ('owner', 'admin', 'estimator')
     and (pr.workspace_access is null or 'projects' = any(pr.workspace_access)) then return 'edit'; end if;
  return 'view';
end $$;

revoke execute on function public.project_access_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.team_role(), public.team_company(), public.team_ws_ok(text),
  public.team_can_view(uuid), public.team_can_write(uuid, text),
  public.team_can_view_path(text), public.team_can_write_path(text) to authenticated;
revoke execute on function public.team_role(), public.team_company(), public.team_ws_ok(text),
  public.team_can_view(uuid), public.team_can_write(uuid, text),
  public.team_can_view_path(text), public.team_can_write_path(text) from anon;

-- 3. Shared project rules ----------------------------------------------------
-- projects
drop policy if exists projects_owner on public.projects;
drop policy if exists projects_team_select on public.projects;
drop policy if exists projects_team_insert on public.projects;
drop policy if exists projects_team_update on public.projects;
drop policy if exists projects_team_delete on public.projects;
create policy projects_team_select on public.projects for select to authenticated using (public.team_can_view(id));
create policy projects_team_insert on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.team_role() in ('owner', 'admin', 'estimator') and public.team_ws_ok('projects'));
create policy projects_team_update on public.projects for update to authenticated
  using (public.team_can_write(id, 'est')) with check (public.team_can_write(id, 'est'));
create policy projects_team_delete on public.projects for delete to authenticated
  using (public.team_can_write(id, 'est') and (owner_id = (select auth.uid()) or public.team_role() in ('owner', 'admin')));

-- Tables that hang off a project: read if you can see the project, change if
-- your role may change that kind of record.
do $$
declare t text; g text; old text;
begin
  for t, g, old in select * from (values
      ('analysis_runs', 'est', 'runs_via_project'), ('boq_items', 'est', 'boq_via_project'),
      ('boq_price_lookups', 'est', 'boq_price_lookups_via_project'), ('boq_price_runs', 'est', 'boq_price_runs_via_project'),
      ('drawings', 'est', 'drawings_via_project'), ('estimate_labour', 'est', 'estimate_labour_via_project'),
      ('estimate_staff', 'est', 'estimate_staff_via_project'), ('project_base_plans', 'dft', 'project_base_plans_owner'),
      ('project_estimates', 'est', 'project_estimates_via_project'), ('project_specifications', 'est', 'project_specifications_owner'),
      ('purchase_orders', 'est', 'purchase_orders_via_project'), ('system_budgets', 'est', 'system_budgets_via_project'),
      ('draftsman_briefs', 'dft', 'draftsman_briefs_owner'),
      ('payment_applications', 'com', 'payment_applications_owner'), ('payment_receipts', 'com', 'payment_receipts_owner'),
      ('project_contracts', 'com', 'project_contracts_owner'),
      ('project_applications', 'ops', 'project_applications_owner'), ('project_inspections', 'ops', 'project_inspections_owner'),
      ('project_issues', 'ops', 'project_issues_owner'), ('project_milestones', 'ops', 'project_milestones_owner')) v(t, g, old)
  loop
    execute format('drop policy if exists %I on public.%I', old, t);
    execute format('drop policy if exists %I on public.%I', t || '_team_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_team_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_team_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_team_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.team_can_view(project_id))', t || '_team_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.team_can_write(project_id, %L))', t || '_team_insert', t, g);
    execute format('create policy %I on public.%I for update to authenticated using (public.team_can_write(project_id, %L)) with check (public.team_can_write(project_id, %L))', t || '_team_update', t, g, g);
    execute format('create policy %I on public.%I for delete to authenticated using (public.team_can_write(project_id, %L))', t || '_team_delete', t, g);
  end loop;
end $$;

-- Read-mostly tables keep their shape, with the team in place of the owner.
drop policy if exists boq_assumptions_owner_read on public.boq_assumptions;
drop policy if exists boq_assumptions_team_read on public.boq_assumptions;
create policy boq_assumptions_team_read on public.boq_assumptions for select to authenticated using (public.team_can_view(project_id));

drop policy if exists cost_optimizations_owner_read on public.cost_optimizations;
drop policy if exists cost_optimizations_owner_update on public.cost_optimizations;
drop policy if exists cost_optimizations_team_read on public.cost_optimizations;
drop policy if exists cost_optimizations_team_update on public.cost_optimizations;
create policy cost_optimizations_team_read on public.cost_optimizations for select to authenticated using (public.team_can_view(project_id));
create policy cost_optimizations_team_update on public.cost_optimizations for update to authenticated
  using (public.team_can_write(project_id, 'est')) with check (public.team_can_write(project_id, 'est'));

drop policy if exists boq_review_items_owner_read on public.boq_review_items;
drop policy if exists boq_review_items_owner_update on public.boq_review_items;
drop policy if exists boq_review_items_team_read on public.boq_review_items;
drop policy if exists boq_review_items_team_update on public.boq_review_items;
create policy boq_review_items_team_read on public.boq_review_items for select to authenticated using (public.team_can_view(project_id));
create policy boq_review_items_team_update on public.boq_review_items for update to authenticated
  using (public.team_can_write(project_id, 'est')) with check (public.team_can_write(project_id, 'est'));

drop policy if exists drawing_pages_owner_read on public.drawing_pages;
drop policy if exists drawing_pages_team_read on public.drawing_pages;
create policy drawing_pages_team_read on public.drawing_pages for select to authenticated using (
  exists (select 1 from drawings d where d.id = drawing_pages.drawing_id and public.team_can_view(d.project_id)));

drop policy if exists "civil_measure_jobs: read own or admin" on public.civil_measure_jobs;
drop policy if exists civil_measure_jobs_team_read on public.civil_measure_jobs;
create policy civil_measure_jobs_team_read on public.civil_measure_jobs for select to authenticated
  using (public.team_can_view(project_id) or public.is_platform_admin());

drop policy if exists comments_via_item on public.item_comments;
drop policy if exists item_comments_team_read on public.item_comments;
drop policy if exists item_comments_team_write on public.item_comments;
create policy item_comments_team_read on public.item_comments for select to authenticated using (
  exists (select 1 from boq_items b where b.id = item_comments.boq_item_id and public.team_can_view(b.project_id)));
-- Everyone who can see a BOQ line may comment on it, viewers included.
create policy item_comments_team_write on public.item_comments for all to authenticated
  using (exists (select 1 from boq_items b where b.id = item_comments.boq_item_id and public.team_can_view(b.project_id)))
  with check (exists (select 1 from boq_items b where b.id = item_comments.boq_item_id and public.team_can_view(b.project_id)));

drop policy if exists system_briefs_owner_select on public.system_briefs;
drop policy if exists system_briefs_owner_insert on public.system_briefs;
drop policy if exists system_briefs_owner_update on public.system_briefs;
drop policy if exists system_briefs_owner_delete on public.system_briefs;
drop policy if exists system_briefs_team_select on public.system_briefs;
drop policy if exists system_briefs_team_insert on public.system_briefs;
drop policy if exists system_briefs_team_update on public.system_briefs;
drop policy if exists system_briefs_team_delete on public.system_briefs;
create policy system_briefs_team_select on public.system_briefs for select to authenticated using (public.team_can_view(project_id));
create policy system_briefs_team_insert on public.system_briefs for insert to authenticated with check (public.team_can_write(project_id, 'est'));
create policy system_briefs_team_update on public.system_briefs for update to authenticated using (public.team_can_write(project_id, 'est')) with check (public.team_can_write(project_id, 'est'));
create policy system_briefs_team_delete on public.system_briefs for delete to authenticated using (public.team_can_write(project_id, 'est'));

drop policy if exists draftsman_jobs_owner_select on public.draftsman_jobs;
drop policy if exists draftsman_jobs_owner_insert on public.draftsman_jobs;
drop policy if exists draftsman_jobs_owner_cancel on public.draftsman_jobs;
drop policy if exists draftsman_jobs_team_select on public.draftsman_jobs;
drop policy if exists draftsman_jobs_team_insert on public.draftsman_jobs;
drop policy if exists draftsman_jobs_team_cancel on public.draftsman_jobs;
create policy draftsman_jobs_team_select on public.draftsman_jobs for select to authenticated using (public.team_can_view(project_id));
create policy draftsman_jobs_team_insert on public.draftsman_jobs for insert to authenticated
  with check (status = 'queued' and public.team_can_write(project_id, 'dft'));
create policy draftsman_jobs_team_cancel on public.draftsman_jobs for update to authenticated
  using (status = 'queued' and public.team_can_write(project_id, 'dft')) with check (status = 'cancelled');

-- Sales targets are company-wide: commercial roles change them.
drop policy if exists sales_targets_role_write on public.sales_targets;
create policy sales_targets_role_write on public.sales_targets as restrictive for all to authenticated
  using (true)
  with check (public.team_role() in ('owner', 'admin', 'commercial') and public.team_ws_ok('commercial'));

-- 4. Drawing files ------------------------------------------------------------
drop policy if exists drawings_owner_select on storage.objects;
drop policy if exists drawings_owner_insert on storage.objects;
drop policy if exists drawings_owner_delete on storage.objects;
drop policy if exists drawings_team_select on storage.objects;
drop policy if exists drawings_team_insert on storage.objects;
drop policy if exists drawings_team_delete on storage.objects;
create policy drawings_team_select on storage.objects for select to authenticated
  using (bucket_id = 'drawings' and public.team_can_view_path(name));
create policy drawings_team_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'drawings' and public.team_can_write_path(name));
create policy drawings_team_delete on storage.objects for delete to authenticated
  using (bucket_id = 'drawings' and public.team_can_write_path(name));

-- 5. Seats ---------------------------------------------------------------------
create or replace function public.enforce_user_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_max integer; v_count integer;
begin
  if new.company_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.company_id is not distinct from new.company_id then return new; end if;
  select p.max_users + coalesce(c.extra_seats, 0) into v_max
    from companies c join plans p on p.id = c.plan where c.id = new.company_id;
  if v_max is null then return new; end if;
  select count(*) into v_count from profiles where company_id = new.company_id and id <> new.id;
  if v_count >= v_max then
    raise exception 'USER_LIMIT_REACHED: this company''s plan allows % user(s); % are already active on it.', v_max, v_count;
  end if;
  return new;
end $$;

-- An invite accepted by the existing billing flow arrives as role 'member';
-- this gives the new member the role, workspaces and projects the invite named.
create or replace function public.apply_invite_settings() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv record; em text;
begin
  if new.company_id is null or (tg_op = 'UPDATE' and old.company_id is not distinct from new.company_id and new.role is not distinct from old.role) then
    if new.role = 'member' then new.role := 'estimator'; end if;
    return new;
  end if;
  select lower(email) into em from auth.users where id = new.id;
  select * into inv from company_invites
   where company_id = new.company_id and lower(email) = em and accepted_at is null and expires_at > now()
   order by created_at desc limit 1;
  if inv.id is not null and coalesce(new.role, 'member') = 'member' then
    new.role := inv.role;
    new.workspace_access := inv.workspace_access;
    new.project_scope := coalesce(inv.project_scope, 'all');
    if inv.project_scope = 'selected' and inv.project_ids is not null then
      insert into member_projects (user_id, project_id)
        select new.id, x from unnest(inv.project_ids) x
         where exists (select 1 from projects where id = x and company_id = new.company_id)
      on conflict do nothing;
    end if;
    insert into team_audit (company_id, actor, target_user, target_email, action, detail)
      values (new.company_id, inv.invited_by, new.id, inv.email, 'joined', jsonb_build_object('role', inv.role));
  elsif exists (select 1 from companies where id = new.company_id and created_by_user_id = new.id) then
    new.role := 'owner';                     -- the person who signed up and made the company
  elsif new.role = 'member' then
    new.role := 'estimator';
  end if;
  return new;
end $$;
drop trigger if exists apply_invite_settings on public.profiles;
create trigger apply_invite_settings before insert or update on public.profiles
  for each row execute function public.apply_invite_settings();

-- 6. Team management (called from the Team page) -------------------------------
create or replace function public.team_require_manager() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c uuid;
begin
  if public.team_role() not in ('owner', 'admin') then raise exception 'Only the owner or an admin can manage the team.'; end if;
  c := public.team_company();
  if c is null then raise exception 'No company on this account.'; end if;
  return c;
end $$;

create or replace function public.team_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c uuid := public.team_company(); r jsonb;
begin
  if c is null then return jsonb_build_object('members', '[]'::jsonb); end if;
  select jsonb_build_object(
    'me', jsonb_build_object('id', (select auth.uid()), 'role', public.team_role()),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'email', u.email, 'role', p.role,
        'workspace_access', p.workspace_access, 'project_scope', p.project_scope,
        'project_ids', (select coalesce(jsonb_agg(m.project_id), '[]'::jsonb) from member_projects m where m.user_id = p.id),
        'last_seen', (select max(a.last_seen_at) from user_activity a where a.user_id = p.id),
        'joined', p.created_at) order by (p.role = 'owner') desc, p.created_at)
      from profiles p join auth.users u on u.id = p.id where p.company_id = c), '[]'::jsonb),
    'invites', case when public.team_role() in ('owner', 'admin') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'email', i.email, 'role', i.role, 'token', i.token, 'expires_at', i.expires_at, 'created_at', i.created_at)
        order by i.created_at desc)
      from company_invites i where i.company_id = c and i.accepted_at is null and i.expires_at > now()), '[]'::jsonb) else '[]'::jsonb end,
    'seats', (select jsonb_build_object('used', (select count(*) from profiles where company_id = c),
        'pending', (select count(*) from company_invites where company_id = c and accepted_at is null and expires_at > now()),
        'plan', pl.max_users, 'extra', co.extra_seats, 'max', pl.max_users + co.extra_seats, 'plan_name', pl.name)
      from companies co join plans pl on pl.id = co.plan where co.id = c),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', project_name, 'ref', project_ref) order by created_at desc)
      from projects where company_id = c), '[]'::jsonb),
    'activity', case when public.team_role() in ('owner', 'admin') then coalesce((select jsonb_agg(x order by x->>'at' desc) from (
        select jsonb_build_object('at', a.created_at, 'action', a.action, 'detail', a.detail, 'email', coalesce(a.target_email, tu.email),
          'by', (select coalesce(full_name, '') from profiles where id = a.actor)) x
          from team_audit a left join auth.users tu on tu.id = a.target_user
         where a.company_id = c order by a.created_at desc limit 30) s), '[]'::jsonb) else '[]'::jsonb end
  ) into r;
  return r;
end $$;

create or replace function public.team_invite(p_email text, p_role text, p_workspaces text[], p_scope text, p_projects uuid[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c uuid := public.team_require_manager(); em text := lower(trim(p_email)); v_max int; v_used int; tok text; inv record;
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if p_role not in ('admin', 'estimator', 'commercial', 'viewer') then raise exception 'Choose a role.'; end if;
  if p_role = 'admin' and public.team_role() <> 'owner' then raise exception 'Only the owner can invite another admin.'; end if;
  if exists (select 1 from profiles p join auth.users u on u.id = p.id where p.company_id = c and lower(u.email) = em) then
    raise exception 'That person is already on your team.'; end if;
  select pl.max_users + co.extra_seats into v_max from companies co join plans pl on pl.id = co.plan where co.id = c;
  select (select count(*) from profiles where company_id = c)
       + (select count(*) from company_invites where company_id = c and accepted_at is null and expires_at > now() and lower(email) <> em) into v_used;
  if v_max is not null and v_used >= v_max then
    raise exception 'All % seats are in use. Upgrade your plan or add a seat to invite someone else.', v_max; end if;
  delete from company_invites where company_id = c and lower(email) = em and accepted_at is null;
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into company_invites (company_id, email, token, invited_by, role, workspace_access, project_scope, project_ids)
    values (c, em, tok, (select auth.uid()), p_role, p_workspaces, coalesce(p_scope, 'all'),
            case when p_scope = 'selected' then p_projects end)
    returning * into inv;
  insert into team_audit (company_id, actor, target_email, action, detail)
    values (c, (select auth.uid()), em, 'invited', jsonb_build_object('role', p_role));
  return jsonb_build_object('token', tok, 'expires_at', inv.expires_at);
end $$;

create or replace function public.team_update_member(p_user uuid, p_role text, p_workspaces text[], p_scope text, p_projects uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare c uuid := public.team_require_manager(); t record; me text := public.team_role();
begin
  select * into t from profiles where id = p_user and company_id = c;
  if t.id is null then raise exception 'That person is not on your team.'; end if;
  if t.role = 'owner' and p_role <> 'owner' then raise exception 'The owner''s role cannot be changed here.'; end if;
  if p_role = 'owner' and t.role <> 'owner' then raise exception 'Ownership cannot be handed over here. Contact support.'; end if;
  if p_role not in ('owner', 'admin', 'estimator', 'commercial', 'viewer') then raise exception 'Choose a role.'; end if;
  if me = 'admin' and (t.role = 'admin' or p_role = 'admin') and p_user <> (select auth.uid()) then
    raise exception 'Only the owner can change an admin.'; end if;
  update profiles set role = p_role, workspace_access = p_workspaces, project_scope = coalesce(p_scope, 'all') where id = p_user;
  delete from member_projects where user_id = p_user;
  if p_scope = 'selected' and p_projects is not null then
    insert into member_projects (user_id, project_id)
      select p_user, x from unnest(p_projects) x where exists (select 1 from projects where id = x and company_id = c)
    on conflict do nothing;
  end if;
  insert into team_audit (company_id, actor, target_user, action, detail)
    values (c, (select auth.uid()), p_user, 'changed', jsonb_build_object('role', p_role, 'workspaces', p_workspaces, 'scope', p_scope));
end $$;

create or replace function public.team_remove_member(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c uuid := public.team_require_manager(); t record;
begin
  select * into t from profiles where id = p_user and company_id = c;
  if t.id is null then raise exception 'That person is not on your team.'; end if;
  if t.role = 'owner' then raise exception 'The owner cannot be removed.'; end if;
  if p_user = (select auth.uid()) then raise exception 'You cannot remove yourself.'; end if;
  if t.role = 'admin' and public.team_role() <> 'owner' then raise exception 'Only the owner can remove an admin.'; end if;
  delete from member_projects where user_id = p_user;
  update profiles set company_id = null, role = 'owner', workspace_access = null, project_scope = 'all' where id = p_user;
  insert into team_audit (company_id, actor, target_user, action) values (c, (select auth.uid()), p_user, 'removed');
end $$;

create or replace function public.team_cancel_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c uuid := public.team_require_manager(); em text;
begin
  delete from company_invites where id = p_invite and company_id = c and accepted_at is null returning email into em;
  if em is not null then
    insert into team_audit (company_id, actor, target_email, action) values (c, (select auth.uid()), em, 'invite_cancelled');
  end if;
end $$;

revoke execute on function public.team_require_manager(), public.team_list(),
  public.team_invite(text, text, text[], text, uuid[]), public.team_update_member(uuid, text, text[], text, uuid[]),
  public.team_remove_member(uuid), public.team_cancel_invite(uuid), public.apply_invite_settings() from public, anon;
grant execute on function public.team_list(), public.team_invite(text, text, text[], text, uuid[]),
  public.team_update_member(uuid, text, text[], text, uuid[]), public.team_remove_member(uuid),
  public.team_cancel_invite(uuid) to authenticated;
