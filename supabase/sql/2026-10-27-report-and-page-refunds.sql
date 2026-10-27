-- 2026-10-27: Report a problem + give pages back.
--
-- 1. ai_usage.run_id links a charge to the analysis run that caused it, so a
--    report about a run can show (and return) exactly what that run cost.
-- 2. A refund is one more ai_usage row: action 'page_refund', page_count = -N.
--    ai-engine's plan check and billing's usage_summary both sum page_count,
--    so a refund simply lowers "pages used". One refund per run, enforced by
--    a unique index, so nothing can be paid back twice.
-- 3. Runs billed from the wallet get the money back instead of pages.
-- 4. support_tickets gets the fields the report form and admin screen need.
--
-- Safe to run more than once.

alter table public.ai_usage
  add column if not exists run_id uuid references public.analysis_runs(id) on delete set null;
create index if not exists ai_usage_run_id_idx on public.ai_usage(run_id);
create unique index if not exists ai_usage_one_refund_per_run
  on public.ai_usage(run_id) where action = 'page_refund' and run_id is not null;

alter table public.support_tickets
  add column if not exists refund_requested boolean not null default false,
  add column if not exists error_text text,
  add column if not exists pages_refunded integer not null default 0,
  add column if not exists credit_refunded_cents integer not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references auth.users(id) on delete set null;

-- What a run was charged. Uses ai_usage.run_id when present; for runs made
-- before that column existed, falls back to the usage row written for the same
-- project within two minutes of the run completing.
create or replace function public.run_charge(p_run_id uuid)
returns table (usage_id uuid, pages integer, billed_from text, cost_cents integer, already_refunded boolean, run_status text)
language plpgsql security definer set search_path = public
as $$
declare r record;
begin
  select ar.* into r from analysis_runs ar where ar.id = p_run_id;
  if r.id is null then return; end if;
  if not (is_platform_admin() or team_can_view(r.project_id)) then
    raise exception 'Not allowed';
  end if;
  return query
  select u.id, coalesce(u.page_count, 0), u.billed_from, coalesce(u.cost_cents, 0),
         exists (select 1 from ai_usage x where x.run_id = p_run_id and x.action = 'page_refund'),
         r.status
  from ai_usage u
  where u.action in ('analyze_drawing','analyze_drawing_tiled','analyze_drawings_combined','rework')
    and coalesce(u.is_admin_assisted, false) = false
    and (u.run_id = p_run_id
         or (u.run_id is null and u.project_id = r.project_id and r.completed_at is not null
             and u.created_at between r.completed_at - interval '2 minutes' and r.completed_at + interval '2 minutes'))
  order by (u.run_id = p_run_id) desc nulls last, abs(extract(epoch from (u.created_at - coalesce(r.completed_at, u.created_at))))
  limit 1;
  -- A run with no charge (failed, admin-assisted) still reports its status.
  if not found then
    return query select null::uuid, 0, null::text, 0,
      exists (select 1 from ai_usage x where x.run_id = p_run_id and x.action = 'page_refund'), r.status;
  end if;
end $$;
grant execute on function public.run_charge(uuid) to authenticated;

-- Platform admin only. Returns pages (or wallet money) for the run on a
-- report, records it on the report, and refuses a second refund for the run.
create or replace function public.admin_refund_ticket(p_ticket_id uuid, p_pages integer, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  t record; c record; v_company uuid; v_bal integer;
begin
  if not is_platform_admin() then raise exception 'Only a platform admin can return pages.'; end if;
  select * into t from support_tickets where id = p_ticket_id for update;
  if t.id is null then raise exception 'Report not found.'; end if;
  if t.refunded_at is not null then raise exception 'Pages were already returned for this report.'; end if;
  v_company := t.company_id;
  if v_company is null then raise exception 'This report has no company, so there is nothing to credit.'; end if;

  select null::uuid as usage_id, 0 as pages, null::text as billed_from, 0 as cost_cents,
         false as already_refunded, null::text as run_status into c;
  if t.run_id is not null then
    select * into c from run_charge(t.run_id);
    if c.already_refunded then raise exception 'This analysis run has already been refunded on another report.'; end if;
  end if;

  if c.billed_from = 'wallet' and coalesce(c.cost_cents, 0) > 0 then
    update companies set credit_balance_cents = credit_balance_cents + c.cost_cents
      where id = v_company returning credit_balance_cents into v_bal;
    insert into credit_transactions (company_id, type, amount_cents, balance_after_cents, description, ai_usage_id)
      values (v_company, 'adjustment', c.cost_cents, v_bal, coalesce('Refund: ' || p_note, 'Refund for reported analysis'), c.usage_id);
    insert into ai_usage (company_id, user_id, project_id, action, page_count, cost_cents, actual_cost_cents,
                          input_tokens, output_tokens, is_admin_assisted, run_id)
      values (v_company, t.user_id, t.project_id, 'page_refund', 0, 0, 0, 0, 0, false, t.run_id);
    update support_tickets set credit_refunded_cents = c.cost_cents, refunded_at = now(), refunded_by = auth.uid()
      where id = p_ticket_id;
    return jsonb_build_object('pages', 0, 'credit_cents', c.cost_cents);
  end if;

  if p_pages is null or p_pages <= 0 then raise exception 'Enter how many pages to return.'; end if;
  if p_pages > 500 then raise exception 'That is more pages than any single run uses. Check the number.'; end if;
  insert into ai_usage (company_id, user_id, project_id, action, page_count, cost_cents, actual_cost_cents,
                        input_tokens, output_tokens, is_admin_assisted, run_id)
    values (v_company, t.user_id, t.project_id, 'page_refund', -p_pages, 0, 0, 0, 0, false, t.run_id);
  update support_tickets set pages_refunded = p_pages, refunded_at = now(), refunded_by = auth.uid()
    where id = p_ticket_id;
  return jsonb_build_object('pages', p_pages, 'credit_cents', 0);
end $$;
revoke all on function public.admin_refund_ticket(uuid, integer, text) from public;
grant execute on function public.admin_refund_ticket(uuid, integer, text) to authenticated;
