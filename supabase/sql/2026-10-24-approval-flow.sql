-- Quantora: approval requests by type, and a proper approval flow (24 Oct 2026)
--
-- What is sent:  project | boq | drawings | draftsman | takeoff | other,
--                with the exact items (item_refs) and a fingerprint of them
--                (sent_stamp), so the page can say "changed since it was sent".
-- How it moves:  the approver on the current step approves (next step, or
--                fully approved after the last), requests changes (back to the
--                sender, comment required) or rejects (closed, comment
--                required). The sender resubmits with a note: revision + 1,
--                and it returns to the approver who asked for the changes.
-- Who may act:   the named team member on that step, or the owner / an admin.
--                An approver outside the team (email only) is recorded by the
--                owner or an admin on their behalf.
-- All writes go through the functions below; the tables are read-only to users.
-- Additive: existing columns and rows are kept.

alter table public.approvals add column if not exists project_id uuid references public.projects(id) on delete cascade;
alter table public.approvals add column if not exists item_type  text not null default 'other';
alter table public.approvals add column if not exists item_refs  jsonb not null default '[]'::jsonb;
alter table public.approvals add column if not exists revision   integer not null default 1;
alter table public.approvals add column if not exists sent_stamp text;
alter table public.approvals add column if not exists sent_at    timestamptz;
alter table public.approvals add column if not exists note       text;
alter table public.approvals drop constraint if exists approvals_item_type_check;
alter table public.approvals add constraint approvals_item_type_check
  check (item_type in ('project', 'boq', 'drawings', 'draftsman', 'takeoff', 'other'));
create index if not exists approvals_project on public.approvals (project_id);

alter table public.approval_actions add column if not exists revision   integer not null default 1;
alter table public.approval_actions add column if not exists actor      uuid;
alter table public.approval_actions add column if not exists item_label text;
alter table public.approval_actions drop constraint if exists approval_actions_action_check;
alter table public.approval_actions add constraint approval_actions_action_check check (action in
  ('submitted', 'approved', 'rejected', 'changes_requested', 'commented', 'reminded', 'resubmitted', 'cancelled'));

update public.approvals a set project_id = t.project_id from public.tenders t
 where a.tender_id = t.id and a.project_id is null;

-- Fingerprint of what was sent. Same items, same quantities and rates = same stamp.
create or replace function public.approval_stamp(p_project uuid, p_type text, p_refs jsonb) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  with ids as (select r->>'id' as id from jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) r)
  select md5(case p_type
    when 'project' then concat_ws('|',
      (select updated_at::text from projects where id = p_project),
      (select count(*) || ':' || coalesce(md5(string_agg(id::text || ':' || coalesce(quantity::text, '') || ':' || coalesce(unit_cost_cents::text, '') || ':' || coalesce(description, ''), ',' order by id)), '')
         from boq_items where project_id = p_project),
      (select count(*) || ':' || coalesce(max(created_at)::text, '') from drawings where project_id = p_project),
      (select count(*) || ':' || coalesce(max(created_at)::text, '') from analysis_runs where project_id = p_project),
      (select count(*) || ':' || coalesce(max(created_at)::text, '') from draftsman_jobs where project_id = p_project))
    when 'boq' then (
      select count(*) || ':' || coalesce(md5(string_agg(b.id::text || ':' || coalesce(b.quantity::text, '') || ':' || coalesce(b.unit_cost_cents::text, '') || ':' || coalesce(b.description, ''), ',' order by b.id)), '')
        from boq_items b
       where b.project_id = p_project
         and (not exists (select 1 from ids) or b.system_category in (select id from ids)))
    when 'takeoff' then concat_ws('|',
      (select count(*) || ':' || coalesce(md5(string_agg(b.id::text || ':' || coalesce(b.quantity::text, '') || ':' || coalesce(b.unit_cost_cents::text, '') || ':' || coalesce(b.description, ''), ',' order by b.id)), '')
         from boq_items b where b.analysis_run_id::text in (select id from ids)),
      (select count(*) from analysis_runs n join analysis_runs o on o.drawing_id = n.drawing_id and n.created_at > o.created_at
        where o.id::text in (select id from ids)))
    when 'drawings' then concat_ws('|',
      (select count(*) from drawings where id::text in (select id from ids)),
      (select count(*) from drawings n join drawings o on o.project_id = n.project_id and lower(o.file_name) = lower(n.file_name) and n.created_at > o.created_at
        where o.id::text in (select id from ids)))
    when 'draftsman' then concat_ws('|',
      (select string_agg(id::text || ':' || status || ':' || coalesce(finished_at::text, ''), ',' order by id) from draftsman_jobs where id::text in (select id from ids)),
      (select count(*) from draftsman_jobs n join draftsman_jobs o on o.project_id = n.project_id and n.created_at > o.created_at and n.status = 'done'
        where o.id::text in (select id from ids)))
    else '' end);
$$;
revoke execute on function public.approval_stamp(uuid, text, jsonb) from public, anon, authenticated;

-- What can be sent from this project, for the request form.
create or replace function public.approval_options(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.team_can_view(p_project) then raise exception 'Project not found or access denied.'; end if;
  return jsonb_build_object(
    'project', (select jsonb_build_object('id', id, 'name', project_name, 'ref', project_ref,
        'cents', (select coalesce(sum(round(coalesce(quantity, 0) * unit_cost_cents)), 0) from boq_items where project_id = p_project and unit_cost_cents is not null),
        'items', (select count(*) from boq_items where project_id = p_project),
        'drawings', (select count(*) from drawings where project_id = p_project))
      from projects where id = p_project),
    'boq', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('id', coalesce(system_category, 'General'), 'name', coalesce(system_category, 'General'),
               'items', count(*), 'cents', coalesce(sum(round(coalesce(quantity, 0) * unit_cost_cents)) filter (where unit_cost_cents is not null), 0)) x
          from boq_items where project_id = p_project group by system_category) s), '[]'::jsonb),
    'drawings', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', file_name, 'discipline', discipline,
        'sheet', sheet_type, 'floor', floor_label, 'at', coalesce(uploaded_at, created_at)) order by coalesce(uploaded_at, created_at) desc)
      from drawings where project_id = p_project), '[]'::jsonb),
    'takeoff', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', coalesce(d.file_name, 'Take-off'), 'revision', r.revision_number,
        'at', r.created_at, 'items', (select count(*) from boq_items b where b.analysis_run_id = r.id),
        'cents', (select coalesce(sum(round(coalesce(quantity, 0) * unit_cost_cents)), 0) from boq_items b where b.analysis_run_id = r.id and unit_cost_cents is not null))
        order by r.created_at desc)
      from analysis_runs r left join drawings d on d.id = r.drawing_id
     where r.project_id = p_project and r.status = 'completed'
       and exists (select 1 from boq_items b where b.analysis_run_id = r.id)), '[]'::jsonb),
    'draftsman', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', coalesce(ifc_name, 'Draftsman design'),
        'systems', systems, 'status', status, 'at', coalesce(finished_at, created_at)) order by created_at desc)
      from draftsman_jobs where project_id = p_project and status = 'done'), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(p.full_name, ''), u.email), 'email', u.email, 'role', p.role)
        order by p.full_name)
      from profiles p join auth.users u on u.id = p.id
     where p.company_id = (select company_id from projects where id = p_project) and p.company_id is not null), '[]'::jsonb));
end $$;

create or replace function public.approval_can_act(a public.approvals) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select a.status = 'pending'
     and public.team_can_view(a.project_id)
     and coalesce((
       select case when nullif(s->>'user_id', '') is not null
                   then (s->>'user_id')::uuid = (select auth.uid()) or public.team_role() in ('owner', 'admin')
                   else public.team_role() in ('owner', 'admin') end
         from jsonb_array_elements(a.chain) s where (s->>'step')::int = a.current_step limit 1), false);
$$;

create or replace function public.approval_create(p_project uuid, p_type text, p_refs jsonb, p_title text,
  p_amount_cents bigint, p_currency text, p_chain jsonb, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr record; t uuid; chain jsonb; n int; aid uuid; s jsonb; uid uuid;
begin
  select * into pr from projects where id = p_project;
  if pr.id is null or not public.team_can_view(p_project) then raise exception 'Project not found or access denied.'; end if;
  if public.team_role() = 'viewer' then raise exception 'Viewers cannot send items for approval.'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Give the approval a title.'; end if;
  if p_type not in ('project', 'boq', 'drawings', 'draftsman', 'takeoff', 'other') then raise exception 'Choose what is being sent.'; end if;
  if p_type in ('drawings', 'draftsman', 'takeoff') and jsonb_array_length(coalesce(p_refs, '[]'::jsonb)) = 0 then
    raise exception 'Tick at least one item to send.'; end if;

  chain := '[]'::jsonb; n := 0;
  for s in select * from jsonb_array_elements(coalesce(p_chain, '[]'::jsonb)) loop
    if coalesce(s->>'name', '') = '' and coalesce(s->>'email', '') = '' and coalesce(s->>'user_id', '') = '' then continue; end if;
    uid := nullif(s->>'user_id', '')::uuid;
    if uid is not null and not exists (select 1 from profiles where id = uid and company_id = pr.company_id) then
      raise exception 'Approver % is not on this team.', coalesce(s->>'name', s->>'email'); end if;
    n := n + 1;
    chain := chain || jsonb_build_object('step', n, 'role', coalesce(nullif(s->>'role', ''), 'Approver'),
      'name', coalesce(s->>'name', ''), 'email', coalesce(s->>'email', ''), 'user_id', uid);
  end loop;
  if n = 0 then raise exception 'Add at least one approver.'; end if;

  select id into t from tenders where project_id = p_project order by created_at limit 1;
  if t is null then
    insert into tenders (company_id, project_id, tender_name, client_name, consultant_name, main_contractor, country, city, building_type, status, created_by)
      values (pr.company_id, pr.id, pr.project_name, pr.client_name, pr.consultant_name, pr.contractor_name, pr.country, pr.city, pr.building_type, 'draft', (select auth.uid()))
      returning id into t;
  end if;

  insert into approvals (tender_id, project_id, title, amount_cents, currency, status, current_step, chain, requested_by,
                         item_type, item_refs, revision, sent_stamp, sent_at, note)
    values (t, p_project, trim(p_title), coalesce(p_amount_cents, 0), coalesce(nullif(p_currency, ''), 'AED'), 'pending', 1, chain,
            (select auth.uid()), p_type, coalesce(p_refs, '[]'::jsonb), 1, public.approval_stamp(p_project, p_type, p_refs), now(), nullif(trim(p_note), ''))
    returning id into aid;
  insert into approval_actions (approval_id, step, approver_name, action, comment, acted_at, revision, actor)
    values (aid, 0, (select coalesce(nullif(full_name, ''), 'Sender') from profiles where id = (select auth.uid())), 'submitted',
            nullif(trim(p_note), ''), now(), 1, (select auth.uid()));
  return aid;
end $$;

create or replace function public.approval_act(p_approval uuid, p_action text, p_comment text, p_item text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a approvals; s jsonb; last boolean;
begin
  select * into a from approvals where id = p_approval for update;
  if a.id is null or not public.team_can_view(a.project_id) then raise exception 'Approval not found.'; end if;
  if a.status <> 'pending' then raise exception 'This request is not waiting for a decision.'; end if;
  if not public.approval_can_act(a) then raise exception 'Only the approver named on this step, the owner or an admin can decide it.'; end if;
  if p_action not in ('approved', 'changes_requested', 'rejected') then raise exception 'Unknown action.'; end if;
  if p_action <> 'approved' and coalesce(trim(p_comment), '') = '' then
    raise exception 'Add a comment saying what needs to change or why it is rejected.'; end if;
  select x into s from jsonb_array_elements(a.chain) x where (x->>'step')::int = a.current_step limit 1;
  insert into approval_actions (approval_id, step, approver_name, approver_email, action, comment, acted_at, revision, actor, item_label)
    values (a.id, a.current_step,
            coalesce(nullif(s->>'name', ''), s->>'role') ||
              case when nullif(s->>'user_id', '') is not null and (s->>'user_id')::uuid <> (select auth.uid())
                   then ' (recorded by ' || coalesce((select nullif(full_name, '') from profiles where id = (select auth.uid())), 'an admin') || ')'
                   when nullif(s->>'user_id', '') is null
                   then ' (recorded by ' || coalesce((select nullif(full_name, '') from profiles where id = (select auth.uid())), 'an admin') || ')'
                   else '' end,
            nullif(s->>'email', ''), p_action, nullif(trim(p_comment), ''), now(), a.revision, (select auth.uid()), nullif(trim(p_item), ''));
  last := a.current_step >= jsonb_array_length(a.chain);
  if p_action = 'approved' then
    if last then update approvals set status = 'approved', completed_at = now() where id = a.id;
    else update approvals set current_step = a.current_step + 1 where id = a.id; end if;
  elsif p_action = 'changes_requested' then
    update approvals set status = 'changes_requested' where id = a.id;
  else
    update approvals set status = 'rejected', completed_at = now() where id = a.id;
  end if;
end $$;

create or replace function public.approval_resubmit(p_approval uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a approvals;
begin
  select * into a from approvals where id = p_approval for update;
  if a.id is null or not public.team_can_view(a.project_id) then raise exception 'Approval not found.'; end if;
  if a.status <> 'changes_requested' then raise exception 'Only a request sent back for changes can be resubmitted.'; end if;
  if a.requested_by <> (select auth.uid()) and public.team_role() not in ('owner', 'admin') then
    raise exception 'Only the sender, the owner or an admin can resubmit.'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Say what you changed.'; end if;
  update approvals set status = 'pending', revision = a.revision + 1,
         sent_stamp = public.approval_stamp(a.project_id, a.item_type, a.item_refs), sent_at = now()
   where id = a.id;
  insert into approval_actions (approval_id, step, approver_name, action, comment, acted_at, revision, actor)
    values (a.id, a.current_step, (select coalesce(nullif(full_name, ''), 'Sender') from profiles where id = (select auth.uid())),
            'resubmitted', trim(p_note), now(), a.revision + 1, (select auth.uid()));
end $$;

create or replace function public.approval_cancel(p_approval uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a approvals;
begin
  select * into a from approvals where id = p_approval for update;
  if a.id is null or not public.team_can_view(a.project_id) then raise exception 'Approval not found.'; end if;
  if a.status not in ('pending', 'changes_requested') then raise exception 'This request is already closed.'; end if;
  if a.requested_by <> (select auth.uid()) and public.team_role() not in ('owner', 'admin') then
    raise exception 'Only the sender, the owner or an admin can withdraw it.'; end if;
  update approvals set status = 'cancelled', completed_at = now() where id = a.id;
  insert into approval_actions (approval_id, step, approver_name, action, acted_at, revision, actor)
    values (a.id, a.current_step, (select coalesce(nullif(full_name, ''), 'Sender') from profiles where id = (select auth.uid())),
            'cancelled', now(), a.revision, (select auth.uid()));
end $$;

-- Every request the user can see (one project, or all), with its history and
-- what the user may do with it.
create or replace function public.approval_list(p_project uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'project_id', a.project_id, 'project_name', p.project_name, 'project_ref', p.project_ref,
      'title', a.title, 'amount_cents', a.amount_cents, 'currency', a.currency, 'status', a.status,
      'current_step', a.current_step, 'chain', a.chain, 'item_type', a.item_type, 'item_refs', a.item_refs,
      'revision', a.revision, 'note', a.note, 'created_at', a.created_at, 'sent_at', a.sent_at, 'completed_at', a.completed_at,
      'requested_by', a.requested_by,
      'requested_by_name', (select coalesce(nullif(full_name, ''), 'Someone') from profiles where id = a.requested_by),
      'is_mine', a.requested_by = (select auth.uid()),
      'can_act', public.approval_can_act(a),
      'waiting_for_me', a.status = 'pending' and exists (select 1 from jsonb_array_elements(a.chain) s
          where (s->>'step')::int = a.current_step and s->>'user_id' = (select auth.uid())::text),
      'can_resubmit', a.status = 'changes_requested' and (a.requested_by = (select auth.uid()) or public.team_role() in ('owner', 'admin')),
      'changed', a.status in ('pending', 'changes_requested') and a.sent_stamp is not null
                 and a.sent_stamp <> public.approval_stamp(a.project_id, a.item_type, a.item_refs),
      'actions', (select coalesce(jsonb_agg(jsonb_build_object('step', x.step, 'name', x.approver_name, 'action', x.action,
          'comment', x.comment, 'item', x.item_label, 'at', x.acted_at, 'revision', x.revision) order by x.acted_at), '[]'::jsonb)
          from approval_actions x where x.approval_id = a.id)
    ) order by (a.status = 'pending') desc, a.created_at desc), '[]'::jsonb)
    from approvals a join projects p on p.id = a.project_id
   where (p_project is null or a.project_id = p_project)
     and public.team_can_view(a.project_id);
$$;

-- Read-only tables; every change goes through the functions above.
drop policy if exists approvals_all on public.approvals;
drop policy if exists approvals_team_read on public.approvals;
create policy approvals_team_read on public.approvals for select to authenticated
  using (public.user_can_see_tender(tender_id) and (project_id is null or public.team_can_view(project_id)));
drop policy if exists approval_actions_all on public.approval_actions;
drop policy if exists approval_actions_team_read on public.approval_actions;
create policy approval_actions_team_read on public.approval_actions for select to authenticated
  using (exists (select 1 from approvals a where a.id = approval_actions.approval_id
                  and public.user_can_see_tender(a.tender_id) and (a.project_id is null or public.team_can_view(a.project_id))));

revoke execute on function public.approval_can_act(public.approvals) from public, anon;
revoke execute on function public.approval_options(uuid), public.approval_create(uuid, text, jsonb, text, bigint, text, jsonb, text),
  public.approval_act(uuid, text, text, text), public.approval_resubmit(uuid, text), public.approval_cancel(uuid),
  public.approval_list(uuid) from public, anon;
grant execute on function public.approval_options(uuid), public.approval_create(uuid, text, jsonb, text, bigint, text, jsonb, text),
  public.approval_act(uuid, text, text, text), public.approval_resubmit(uuid, text), public.approval_cancel(uuid),
  public.approval_list(uuid), public.approval_can_act(public.approvals) to authenticated;
