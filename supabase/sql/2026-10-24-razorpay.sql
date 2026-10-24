-- Quantora: Razorpay billing (24 Oct 2026)
--
-- Monthly plans and monthly storage add-ons are Razorpay Subscriptions.
-- Nothing is granted when a checkout opens: the plan or storage is switched on
-- only once Razorpay confirms the payment (checkout signature or webhook), and
-- it lapses at the end of the paid period when a subscription is cancelled or
-- stops being paid. Additive only; safe to run more than once.
--
-- Secrets live in app_secrets, entered by the owner, never in code:
--   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
--   RAZORPAY_CURRENCY ('USD' default, or 'INR').

-- Prices in rupees, used only when RAZORPAY_CURRENCY = 'INR'.
alter table public.plans add column if not exists price_inr numeric;

-- Storage add-ons on sale.
create table if not exists public.storage_addons (
  gb         integer primary key,
  price_usd  numeric(10,2) not null,
  price_inr  numeric(10,2),
  note       text,
  is_active  boolean not null default true
);
insert into public.storage_addons (gb, price_usd, note) values
  (25,  10, 'For a few more large projects'),
  (100, 30, 'Most popular for active teams'),
  (250, 60, 'For tender archives and big drawing sets')
on conflict (gb) do update set price_usd = excluded.price_usd, note = excluded.note;
alter table public.storage_addons enable row level security;
drop policy if exists "storage_addons: read" on public.storage_addons;
create policy "storage_addons: read" on public.storage_addons for select using (true);

-- Razorpay plan id for each thing we sell, per currency and amount, so a
-- price change makes a new Razorpay plan instead of silently repricing old ones.
create table if not exists public.razorpay_plans (
  item             text not null,          -- 'plan:starter', 'storage:25'
  currency         text not null,
  amount_minor     integer not null,       -- cents / paise
  razorpay_plan_id text not null unique,
  created_at       timestamptz not null default now(),
  primary key (item, currency, amount_minor)
);
alter table public.razorpay_plans enable row level security;   -- server only

alter table public.companies add column if not exists razorpay_customer_id     text;
alter table public.companies add column if not exists razorpay_subscription_id text;

-- One row per storage add-on subscription.
create table if not exists public.company_storage_subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  addon_gb                 integer not null,
  razorpay_subscription_id text not null unique,
  status                   text not null default 'created',
  current_end              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists company_storage_subscriptions_company on public.company_storage_subscriptions (company_id);
alter table public.company_storage_subscriptions enable row level security;
drop policy if exists "company_storage_subscriptions: read own" on public.company_storage_subscriptions;
create policy "company_storage_subscriptions: read own" on public.company_storage_subscriptions
  for select to authenticated using (public.user_in_company(company_id) or public.is_platform_admin());

-- Every webhook event once, so a retry never applies twice.
create table if not exists public.billing_events (
  event_id    text primary key,
  provider    text not null,
  event       text not null,
  received_at timestamptz not null default now(),
  payload     jsonb
);
alter table public.billing_events enable row level security;   -- server only

-- Paid storage = add-ons that are active, or paid up to a date still ahead.
create or replace function public.recompute_storage_addon(p_company uuid)
returns numeric language sql security definer set search_path = public, pg_temp as $$
  update companies c set storage_addon_gb = coalesce((
    select sum(s.addon_gb) from company_storage_subscriptions s
     where s.company_id = p_company
       and (s.status = 'active'
            or (s.status in ('pending', 'halted', 'cancelled', 'completed') and s.current_end > now()))
  ), 0)
  where c.id = p_company
  returning c.storage_addon_gb;
$$;
revoke execute on function public.recompute_storage_addon(uuid) from public, anon, authenticated;

-- Add-ons whose paid period has passed drop off.
create or replace function public.expire_storage_addons()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r record;
begin
  for r in select distinct company_id from company_storage_subscriptions
            where status <> 'active' and current_end is not null and current_end <= now()
              and status <> 'expired'
  loop
    update company_storage_subscriptions set status = 'expired', updated_at = now()
     where company_id = r.company_id and status <> 'active'
       and current_end is not null and current_end <= now();
    perform public.recompute_storage_addon(r.company_id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.expire_storage_addons() from public, anon, authenticated;

-- Lapsed plan subscriptions: Razorpay as well as Paddle.
create or replace function public.expire_lapsed_subscriptions()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare dropped int := 0; r record;
begin
  for r in
    select id, plan, subscription_status from public.companies
     where billing_provider in ('paddle', 'razorpay')
       and coalesce(subscription_status, '') in ('past_due', 'canceled', 'paused', 'halted', 'cancelled', 'completed', 'expired')
       and paid_until is not null and paid_until <= now()
       and coalesce(plan, 'free') <> 'free'
     for update skip locked
  loop
    update public.companies set plan = 'free' where id = r.id;
    insert into public.admin_quota_adjustments
      (company_id, admin_user_id, adjustment_type, amount, note, previous_value, new_value)
    values (r.id, null, 'plan_changed', 0,
       format('Subscription %s and the paid period ended, so access reverted to free.', r.subscription_status),
       r.plan, 'free');
    dropped := dropped + 1;
  end loop;
  perform public.expire_storage_addons();
  return dropped;
end $$;
