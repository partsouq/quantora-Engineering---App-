-- 2026-11-03 Bid board + targets.
-- 1) Who is estimating each tender (pre-sales). Bid progress itself is worked out from the project
--    (drawings, specification, BOQ, pricing, stage), so nothing else is stored.
alter table public.tenders add column if not exists estimator_id uuid;

-- 2) Targets: a sales target and a revenue target per month, for the company and for each person.
alter table public.sales_targets add column if not exists kind text not null default 'sales';
alter table public.sales_targets drop constraint if exists sales_targets_kind_check;
alter table public.sales_targets add constraint sales_targets_kind_check check (kind in ('sales', 'revenue'));
-- One row per company / person / month / kind. NULL person = the company target; the old rule let
-- the company target be saved twice (NULLs never clash), so duplicates are removed first.
delete from public.sales_targets a using public.sales_targets b
 where a.company_id = b.company_id and a.user_id is not distinct from b.user_id
   and a.period_month = b.period_month and a.kind = b.kind and a.created_at < b.created_at;
alter table public.sales_targets drop constraint if exists sales_targets_company_id_user_id_period_month_key;
alter table public.sales_targets drop constraint if exists sales_targets_one_per_month;
alter table public.sales_targets add constraint sales_targets_one_per_month unique nulls not distinct (company_id, user_id, period_month, kind);

-- 3) Security fix: this rule let any logged-in user read, change or delete every company's sales
--    targets (its USING was "true"). It now only covers the user's own company.
drop policy if exists sales_targets_role_write on public.sales_targets;
create policy sales_targets_role_write on public.sales_targets for all to authenticated
  using (user_in_company(company_id))
  with check (user_in_company(company_id) and team_role() = any (array['owner','admin','commercial']) and team_ws_ok('commercial'));
