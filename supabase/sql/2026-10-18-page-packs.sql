-- Quantora: page packs (pay per page), 18 Oct 2026
-- BOQ page $1.00 · Draftsman page $1.90 · Specification page $0.10
-- Every BOQ or draftsman page bought also adds 4 specification pages.
-- Pack pages are used only after a plan's own pages run out (or straight away
-- for users with no plan). They do not expire and do not reset monthly.
-- Safe to run more than once.

-- 1. Balances on the company -------------------------------------------------
alter table public.companies
  add column if not exists boq_pack_pages       integer not null default 0,
  add column if not exists draftsman_pack_pages integer not null default 0,
  add column if not exists spec_pack_pages      integer not null default 0;

-- 2. What can be bought --------------------------------------------------------
create table if not exists public.page_products (
  id                   text primary key,
  name                 text not null,
  price_usd            numeric(10,2) not null,
  spec_pages_per_unit  integer not null default 0,
  paddle_price_id      text,
  is_active            boolean not null default true,
  sort_order           integer not null default 0
);
insert into public.page_products (id, name, price_usd, spec_pages_per_unit, sort_order) values
  ('boq_page',       'Take-off BOQ page',  1.00, 4, 10),
  ('draftsman_page', 'Draftsman page',     1.90, 4, 20),
  ('spec_page',      'Specification page', 0.10, 0, 30)
on conflict (id) do update
  set name = excluded.name, price_usd = excluded.price_usd,
      spec_pages_per_unit = excluded.spec_pages_per_unit, sort_order = excluded.sort_order;

alter table public.page_products enable row level security;
drop policy if exists "page_products: read" on public.page_products;
create policy "page_products: read" on public.page_products for select using (true);

-- 3. Ledger: every page added or used ---------------------------------------
create table if not exists public.page_pack_ledger (
  id                     bigserial primary key,
  company_id             uuid not null references public.companies(id) on delete cascade,
  kind                   text not null check (kind in ('boq', 'draftsman', 'spec')),
  delta                  integer not null,
  balance_after          integer not null,
  reason                 text,
  paddle_transaction_id  text,
  ref                    text,
  created_at             timestamptz not null default now()
);
create unique index if not exists page_pack_ledger_txn_kind
  on public.page_pack_ledger (paddle_transaction_id, kind) where paddle_transaction_id is not null;
create unique index if not exists page_pack_ledger_ref_kind
  on public.page_pack_ledger (ref, kind) where ref is not null;
create index if not exists page_pack_ledger_company on public.page_pack_ledger (company_id, created_at desc);

alter table public.page_pack_ledger enable row level security;
drop policy if exists "page_pack_ledger: read own or admin" on public.page_pack_ledger;
create policy "page_pack_ledger: read own or admin" on public.page_pack_ledger for select using (
  company_id in (select company_id from public.profiles where id = auth.uid())
  or public.is_platform_admin()
);

-- 4. Add pages after a confirmed Paddle payment (idempotent per transaction) -
create or replace function public.apply_page_purchase(
  p_company_id uuid, p_paddle_transaction_id text,
  p_boq integer, p_draftsman integer, p_spec integer, p_description text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_bal integer;
begin
  if exists (select 1 from page_pack_ledger where paddle_transaction_id = p_paddle_transaction_id) then
    return;                                          -- Paddle retried the same event
  end if;
  if coalesce(p_boq, 0) > 0 then
    update companies set boq_pack_pages = boq_pack_pages + p_boq where id = p_company_id returning boq_pack_pages into v_bal;
    if v_bal is null then raise exception 'apply_page_purchase: company % not found', p_company_id; end if;
    insert into page_pack_ledger (company_id, kind, delta, balance_after, reason, paddle_transaction_id)
      values (p_company_id, 'boq', p_boq, v_bal, coalesce(p_description, 'Page pack'), p_paddle_transaction_id);
  end if;
  if coalesce(p_draftsman, 0) > 0 then
    update companies set draftsman_pack_pages = draftsman_pack_pages + p_draftsman where id = p_company_id returning draftsman_pack_pages into v_bal;
    if v_bal is null then raise exception 'apply_page_purchase: company % not found', p_company_id; end if;
    insert into page_pack_ledger (company_id, kind, delta, balance_after, reason, paddle_transaction_id)
      values (p_company_id, 'draftsman', p_draftsman, v_bal, coalesce(p_description, 'Page pack'), p_paddle_transaction_id);
  end if;
  if coalesce(p_spec, 0) > 0 then
    update companies set spec_pack_pages = spec_pack_pages + p_spec where id = p_company_id returning spec_pack_pages into v_bal;
    if v_bal is null then raise exception 'apply_page_purchase: company % not found', p_company_id; end if;
    insert into page_pack_ledger (company_id, kind, delta, balance_after, reason, paddle_transaction_id)
      values (p_company_id, 'spec', p_spec, v_bal, coalesce(p_description, 'Page pack'), p_paddle_transaction_id);
  end if;
end $$;

-- 5. Use pages (never below zero; idempotent per ref) -------------------------
create or replace function public.consume_page_pack(
  p_company_id uuid, p_kind text, p_units integer, p_ref text default null, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_bal integer;
begin
  if p_units is null or p_units <= 0 then return true; end if;
  if p_ref is not null and exists (select 1 from page_pack_ledger where ref = p_ref and kind = p_kind) then
    return true;                                     -- already charged for this job / run
  end if;
  if p_kind = 'boq' then
    update companies set boq_pack_pages = boq_pack_pages - p_units
      where id = p_company_id and boq_pack_pages >= p_units returning boq_pack_pages into v_bal;
  elsif p_kind = 'draftsman' then
    update companies set draftsman_pack_pages = draftsman_pack_pages - p_units
      where id = p_company_id and draftsman_pack_pages >= p_units returning draftsman_pack_pages into v_bal;
  elsif p_kind = 'spec' then
    update companies set spec_pack_pages = spec_pack_pages - p_units
      where id = p_company_id and spec_pack_pages >= p_units returning spec_pack_pages into v_bal;
  else
    raise exception 'consume_page_pack: unknown kind %', p_kind;
  end if;
  if v_bal is null then return false; end if;        -- not enough pages
  insert into page_pack_ledger (company_id, kind, delta, balance_after, reason, ref)
    values (p_company_id, p_kind, -p_units, v_bal, coalesce(p_reason, 'Used'), p_ref);
  return true;
end $$;

-- 6. Give pages back when a job fails (idempotent) ----------------------------
create or replace function public.refund_page_pack(p_ref text)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_bal integer;
begin
  for r in select * from page_pack_ledger where ref = p_ref and delta < 0 loop
    if exists (select 1 from page_pack_ledger where ref = p_ref || ':refund' and kind = r.kind) then continue; end if;
    if r.kind = 'boq' then
      update companies set boq_pack_pages = boq_pack_pages - r.delta where id = r.company_id returning boq_pack_pages into v_bal;
    elsif r.kind = 'draftsman' then
      update companies set draftsman_pack_pages = draftsman_pack_pages - r.delta where id = r.company_id returning draftsman_pack_pages into v_bal;
    else
      update companies set spec_pack_pages = spec_pack_pages - r.delta where id = r.company_id returning spec_pack_pages into v_bal;
    end if;
    insert into page_pack_ledger (company_id, kind, delta, balance_after, reason, ref)
      values (r.company_id, r.kind, -r.delta, v_bal, 'Returned: job did not finish', p_ref || ':refund');
  end loop;
end $$;

-- Only the server (edge functions, worker) may add or use pages.
revoke all on function public.apply_page_purchase(uuid, text, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.consume_page_pack(uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.refund_page_pack(text) from public, anon, authenticated;
grant execute on function public.apply_page_purchase(uuid, text, integer, integer, integer, text) to service_role;
grant execute on function public.consume_page_pack(uuid, text, integer, text, text) to service_role;
grant execute on function public.refund_page_pack(text) to service_role;

-- 7. Usage log may record "pack" as how a run was paid -----------------------
alter table public.ai_usage drop constraint if exists ai_usage_billed_from_check;
alter table public.ai_usage add constraint ai_usage_billed_from_check
  check (billed_from is null or billed_from = any (array['free_quota', 'wallet', 'pack', 'admin_comp']));

-- 8. Draftsman: allow a new job when plan pages are used but pack pages remain
create or replace function public.enforce_draftsman_pages()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_company uuid; q record; v_pack integer; uid uuid := coalesce(new.created_by, auth.uid());
begin
  if new.created_by is null then new.created_by := uid; end if;
  if uid is not null and exists (select 1 from platform_admins where user_id = uid) then return new; end if;
  if new.options ? 'rework_of' then return new; end if;
  select company_id into v_company from projects where id = new.project_id;
  if v_company is null then return new; end if;
  select * into q from draftsman_quota(v_company);
  if q.lim is not null and q.used >= q.lim then
    select coalesce(draftsman_pack_pages, 0) into v_pack from companies where id = v_company;
    if v_pack > 0 then return new; end if;           -- the worker takes the pages from the pack
    if q.plan_id in ('trial', 'free') then
      raise exception 'DRAFTSMAN_LIMIT_REACHED: your free welcome pack is used. Choose a plan or buy draftsman pages to keep generating drawings.';
    end if;
    raise exception 'DRAFTSMAN_LIMIT_REACHED: all % drawing page(s) of your plan are used this month. Buy draftsman pages, upgrade the plan, or ask the administrator for more pages.', q.lim;
  end if;
  return new;
end $$;
