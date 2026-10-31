-- Dodo Payments replaces Razorpay (2026-10-31). Applied with "Approved SQL".

-- 1. Where a company's Dodo subscription is kept.
alter table public.companies
  add column if not exists dodo_subscription_id text,
  add column if not exists dodo_customer_id text;

-- 2. Storage add-ons bought through Dodo.
alter table public.company_storage_subscriptions
  alter column razorpay_subscription_id drop not null,
  add column if not exists dodo_subscription_id text;
create unique index if not exists company_storage_subscriptions_dodo_sub_key
  on public.company_storage_subscriptions (dodo_subscription_id);

-- 3. Our map of Dodo product ids: which plan or add-on each product is.
create table if not exists public.dodo_products (
  item         text not null,               -- 'plan:<id>' or 'storage:<gb>'
  mode         text not null default 'live',
  currency     text not null default 'USD',
  amount_minor integer not null,
  product_id   text not null unique,
  created_at   timestamptz not null default now(),
  primary key (item, mode, currency, amount_minor)
);
alter table public.dodo_products enable row level security;   -- service role only, no policies

-- 4. Company for a customer email (fallback when Dodo metadata is missing). Service role only.
create or replace function public.company_id_for_email(p_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select p.company_id from public.profiles p join auth.users u on u.id = p.id
   where lower(u.email) = lower(p_email) and p.company_id is not null
   order by u.created_at limit 1
$$;
revoke all on function public.company_id_for_email(text) from public, anon, authenticated;

-- 5. A lapsed Dodo plan drops to free at the end of the paid month, like Razorpay did.
create or replace function public.expire_lapsed_subscriptions()
returns integer language plpgsql security definer set search_path = public as $$
declare dropped int := 0; r record;
begin
  for r in
    select id, plan, subscription_status from public.companies
     where billing_provider in ('paddle', 'razorpay', 'dodo')
       and coalesce(subscription_status, '') in ('past_due', 'canceled', 'paused', 'halted', 'cancelled', 'completed', 'expired', 'on_hold', 'failed')
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

-- 6. Storage add-ons keep working to the end of the paid month for Dodo's statuses too.
create or replace function public.recompute_storage_addon(p_company uuid)
returns numeric language sql security definer set search_path = public as $$
  update companies c set storage_addon_gb = coalesce((
    select sum(s.addon_gb) from company_storage_subscriptions s
     where s.company_id = p_company
       and (s.status = 'active'
            or (s.status in ('pending', 'halted', 'cancelled', 'completed', 'on_hold', 'past_due', 'paused') and s.current_end > now()))
  ), 0)
  where c.id = p_company
  returning c.storage_addon_gb;
$$;
