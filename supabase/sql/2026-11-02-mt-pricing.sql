-- 2026-11-02 Manual Take-off pricing.
-- A "drawing" = a sheet a company starts marking in a calendar month (counted once per month).
-- Monthly allowance by plan: Free / Welcome 10, Individual 50, Professional 200, Team / Enterprise unlimited (null).
-- Packs: +30 drawings for $10, valid 30 days (credited by the Dodo webhook / checkout return).

alter table public.plans add column if not exists mt_drawings_month int;
update public.plans set mt_drawings_month = case id
  when 'trial' then 10 when 'free' then 10 when 'starter' then 50 when 'professional' then 200 else null end;

create table if not exists public.mt_sheet_usage (
  company_id uuid not null,
  month date not null,
  sheet_key text not null,
  project_id uuid,
  user_id uuid,
  created_at timestamptz not null default now(),
  primary key (company_id, month, sheet_key)
);
alter table public.mt_sheet_usage enable row level security;
drop policy if exists mt_sheet_usage_read on public.mt_sheet_usage;
create policy mt_sheet_usage_read on public.mt_sheet_usage for select to authenticated
  using (company_id = (select company_id from profiles where id = auth.uid()) or is_platform_admin());

create table if not exists public.mt_packs (
  payment_id text primary key,
  company_id uuid not null,
  drawings int not null default 30,
  purchased_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.mt_packs enable row level security;
drop policy if exists mt_packs_read on public.mt_packs;
create policy mt_packs_read on public.mt_packs for select to authenticated
  using (company_id = (select company_id from profiles where id = auth.uid()) or is_platform_admin());

-- What this company may still mark this month.
create or replace function public.q_mt_quota()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_co uuid; v_plan text; v_lim int; v_used int; v_pack int; v_unl boolean;
begin
  select company_id into v_co from profiles where id = auth.uid();
  if v_co is null then return jsonb_build_object('unlimited', false, 'limit', 0, 'used', 0, 'packs', 0, 'allowance', 0); end if;
  select c.plan into v_plan from companies c where c.id = v_co;
  select p.mt_drawings_month into v_lim from plans p where p.id = coalesce(v_plan, 'free');
  v_unl := is_platform_admin() or exists (select 1 from q_internal_users where user_id = auth.uid())
           or (v_plan is not null and exists (select 1 from plans p where p.id = v_plan) and v_lim is null);
  select count(*) into v_used from mt_sheet_usage where company_id = v_co and month = date_trunc('month', now())::date;
  select coalesce(sum(drawings), 0) into v_pack from mt_packs where company_id = v_co and expires_at > now();
  return jsonb_build_object('unlimited', v_unl, 'plan', v_plan, 'limit', coalesce(v_lim, 0), 'used', v_used, 'packs', v_pack,
                            'allowance', coalesce(v_lim, 0) + v_pack);
end $$;
revoke all on function public.q_mt_quota() from public, anon;
grant execute on function public.q_mt_quota() to authenticated;

-- Called when a sheet gets its first mark. A sheet already counted this month is always allowed.
create or replace function public.q_mt_use_sheet(p_project uuid, p_sheet text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_co uuid; q jsonb; v_key text := p_project::text || ':' || left(coalesce(p_sheet, ''), 80);
        v_month date := date_trunc('month', now())::date;
begin
  select company_id into v_co from profiles where id = auth.uid();
  if v_co is null or not exists (select 1 from projects where id = p_project and company_id = v_co) and not is_platform_admin() then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if exists (select 1 from mt_sheet_usage where company_id = v_co and month = v_month and sheet_key = v_key) then
    return jsonb_build_object('ok', true) || q_mt_quota();
  end if;
  q := q_mt_quota();
  if not (q->>'unlimited')::boolean and (q->>'used')::int >= (q->>'allowance')::int then
    return jsonb_build_object('ok', false, 'reason', 'limit') || q;
  end if;
  insert into mt_sheet_usage (company_id, month, sheet_key, project_id, user_id)
  values (v_co, v_month, v_key, p_project, auth.uid()) on conflict do nothing;
  return jsonb_build_object('ok', true) || q_mt_quota();
end $$;
revoke all on function public.q_mt_use_sheet(uuid, text) from public, anon;
grant execute on function public.q_mt_use_sheet(uuid, text) to authenticated;
