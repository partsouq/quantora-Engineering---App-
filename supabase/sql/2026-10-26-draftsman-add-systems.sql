-- ===========================================================================
-- Draftsman: "Add systems" to an issued package (26 Oct 2026)
-- A system the user forgot can be added later on the same plans. It is not a
-- new generation: the worker charges 0 pages for it and refuses systems that
-- are already drawn. This lets such a job through the page limit, like a
-- rework, but only when it points at a finished package of the same project.
-- ===========================================================================
create or replace function public.enforce_draftsman_pages()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v_company uuid; q record; uid uuid := coalesce(new.created_by, auth.uid());
begin
  if new.created_by is null then new.created_by := uid; end if;
  if uid is not null and exists (select 1 from platform_admins where user_id = uid) then return new; end if;
  if new.options ? 'rework_of' then return new; end if;
  if new.options ? 'add_to' and exists (
       select 1 from draftsman_jobs b
        where b.id::text = new.options->>'add_to' and b.project_id = new.project_id and b.status = 'done') then
    return new;
  end if;
  select company_id into v_company from projects where id = new.project_id;
  if v_company is null then return new; end if;
  select * into q from draftsman_quota(v_company);
  if q.lim is not null and q.used >= q.lim then
    if q.plan_id in ('trial', 'free') then
      raise exception 'DRAFTSMAN_LIMIT_REACHED: your free welcome pack is used. Choose a plan to keep generating drawings.';
    end if;
    raise exception 'DRAFTSMAN_LIMIT_REACHED: all % drawing page(s) of your plan are used this month. Upgrade the plan or ask the administrator for more pages.', q.lim;
  end if;
  return new;
end $function$;
