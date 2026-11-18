-- ===========================================================================
-- Launch promotion: first 50 users (18 Nov 2026)
-- Each of the first 50 new accounts that confirm their email and use a promo
-- code gets, for 30 days:
--   100 Manual Take-off drawings   (an mt_packs row that expires by itself)
--    10 Draftsman pages            (companies.bonus_draftsman_pages)
--     2 AI take-off pages          (companies.bonus_drawing_pages)
-- Codes: LINKEDIN50, TIKTOK50, WEB50. One pack per person, per company and per
-- work email domain. Stops by itself at 50. Safe to run more than once.
-- ===========================================================================

create table if not exists promo_campaigns (
  id          text primary key,
  cap         int  not null,
  mt_drawings int  not null,
  draftsman   int  not null,
  ai_pages    int  not null,
  days        int  not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create table if not exists promo_codes (
  code        text primary key,
  campaign_id text not null references promo_campaigns(id),
  source      text not null,
  active      boolean not null default true
);
create table if not exists promo_claims (
  id          bigserial primary key,
  campaign_id text not null references promo_campaigns(id),
  code        text not null references promo_codes(code),
  user_id     uuid not null unique,
  company_id  uuid not null unique,
  email_norm  text not null unique,
  work_domain text,
  claimed_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  expired_at  timestamptz,
  granted     jsonb not null
);
create unique index if not exists promo_claims_work_domain on promo_claims (campaign_id, work_domain) where work_domain is not null;
alter table promo_campaigns enable row level security;
alter table promo_codes     enable row level security;
alter table promo_claims    enable row level security;
revoke all on promo_campaigns, promo_codes, promo_claims from anon, authenticated;

insert into promo_campaigns (id, cap, mt_drawings, draftsman, ai_pages, days)
values ('first50', 50, 100, 10, 2, 30) on conflict (id) do nothing;
insert into promo_codes (code, campaign_id, source) values
  ('LINKEDIN50', 'first50', 'LinkedIn'),
  ('TIKTOK50',   'first50', 'TikTok'),
  ('WEB50',      'first50', 'Website')
on conflict (code) do nothing;

-- Public: how many packs are left (for the pop-up). No personal data.
create or replace function q_promo_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'active', c.active and (select count(*) from promo_claims p where p.campaign_id = c.id) < c.cap,
    'cap', c.cap,
    'left', greatest(0, c.cap - (select count(*) from promo_claims p where p.campaign_id = c.id)),
    'mt', c.mt_drawings, 'draftsman', c.draftsman, 'ai', c.ai_pages, 'days', c.days)
  from promo_campaigns c where c.id = 'first50';
$$;
revoke all on function q_promo_status() from public;
grant execute on function q_promo_status() to anon, authenticated;

-- Signed-in user: claim the pack with a code.
create or replace function q_promo_claim(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_code promo_codes; v_camp promo_campaigns; v_co companies;
  v_email text; v_conf timestamptz; v_local text; v_domain text; v_norm text; v_work text;
  v_exp timestamptz; v_id bigint;
begin
  if me is null then return jsonb_build_object('status', 'not_signed_in'); end if;
  select * into v_code from promo_codes where code = upper(trim(coalesce(p_code, '')));
  if not found or not v_code.active then return jsonb_build_object('status', 'bad_code'); end if;

  select u.email, u.email_confirmed_at into v_email, v_conf from auth.users u where u.id = me;
  if v_conf is null then return jsonb_build_object('status', 'confirm_email'); end if;
  if exists (select 1 from platform_admins where user_id = me) then return jsonb_build_object('status', 'not_eligible'); end if;

  select c.* into v_co from companies c join profiles p on p.company_id = c.id where p.id = me;
  if not found then return jsonb_build_object('status', 'no_company'); end if;
  if v_co.plan is distinct from 'trial' then return jsonb_build_object('status', 'not_eligible'); end if;

  -- same person / same company check (Gmail dots and +tags count as one address)
  v_email  := lower(trim(v_email));
  v_local  := split_part(split_part(v_email, '@', 1), '+', 1);
  v_domain := split_part(v_email, '@', 2);
  if v_domain = 'googlemail.com' then v_domain := 'gmail.com'; end if;
  if v_domain = 'gmail.com' then v_local := replace(v_local, '.', ''); end if;
  v_norm := v_local || '@' || v_domain;
  v_work := case when v_domain in ('gmail.com','yahoo.com','yahoo.co.in','yahoo.co.uk','ymail.com','rocketmail.com',
      'outlook.com','hotmail.com','hotmail.co.uk','live.com','msn.com','icloud.com','me.com','mac.com','aol.com',
      'proton.me','protonmail.com','zoho.com','zohomail.com','gmx.com','gmx.net','mail.com','yandex.com','yandex.ru',
      'rediffmail.com','qq.com','163.com','126.com','naver.com','tutanota.com','fastmail.com','hey.com')
    then null else v_domain end;

  -- one at a time, so the 50 limit is exact
  select * into v_camp from promo_campaigns where id = v_code.campaign_id for update;
  if exists (select 1 from promo_claims where user_id = me or company_id = v_co.id or email_norm = v_norm
             or (v_work is not null and campaign_id = v_camp.id and work_domain = v_work)) then
    return jsonb_build_object('status', 'already');
  end if;
  if not v_camp.active or (select count(*) from promo_claims where campaign_id = v_camp.id) >= v_camp.cap then
    return jsonb_build_object('status', 'sold_out');
  end if;

  v_exp := now() + make_interval(days => v_camp.days);
  insert into promo_claims (campaign_id, code, user_id, company_id, email_norm, work_domain, expires_at, granted)
  values (v_camp.id, v_code.code, me, v_co.id, v_norm, v_work, v_exp,
          jsonb_build_object('mt', v_camp.mt_drawings, 'draftsman', v_camp.draftsman, 'ai', v_camp.ai_pages))
  returning id into v_id;

  insert into mt_packs (payment_id, company_id, drawings, expires_at)
  values ('promo:' || v_id, v_co.id, v_camp.mt_drawings, v_exp);

  -- the projects stay for the whole promo (the Welcome Pack clock is 7 days)
  update companies set
    bonus_draftsman_pages = coalesce(bonus_draftsman_pages, 0) + v_camp.draftsman,
    bonus_drawing_pages   = coalesce(bonus_drawing_pages, 0) + v_camp.ai_pages,
    welcome_delete_at     = greatest(coalesce(welcome_delete_at, v_exp), v_exp)
  where id = v_co.id;

  return jsonb_build_object('status', 'claimed', 'mt', v_camp.mt_drawings, 'draftsman', v_camp.draftsman,
                            'ai', v_camp.ai_pages, 'expires_at', v_exp);
end $$;
revoke all on function q_promo_claim(text) from public, anon;
grant execute on function q_promo_claim(text) to authenticated;

-- Daily: take back the Draftsman and AI pages of packs older than 30 days.
-- (The Manual Take-off pack ends by itself through mt_packs.expires_at.)
create or replace function q_promo_expire()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select * from promo_claims where expired_at is null and expires_at <= now() for update loop
    update companies set
      bonus_draftsman_pages = greatest(0, coalesce(bonus_draftsman_pages, 0) - coalesce((r.granted->>'draftsman')::int, 0)),
      bonus_drawing_pages   = greatest(0, coalesce(bonus_drawing_pages, 0)   - coalesce((r.granted->>'ai')::int, 0))
    where id = r.company_id;
    update promo_claims set expired_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function q_promo_expire() from public, anon, authenticated;
select cron.unschedule('promo-expire') where exists (select 1 from cron.job where jobname = 'promo-expire');
select cron.schedule('promo-expire', '23 2 * * *', 'select public.q_promo_expire()');

-- Admin: claims per code and the AI money spent by promo accounts.
create or replace function q_promo_admin()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Platform admin access only.'; end if;
  return jsonb_build_object(
    'status', q_promo_status(),
    'codes', (select coalesce(jsonb_agg(x order by x->>'code'), '[]') from (
      select jsonb_build_object('code', pc.code, 'source', pc.source, 'active', pc.active,
        'claims', (select count(*) from promo_claims p where p.code = pc.code),
        'ai_cost_usd', round(coalesce((select sum(u.actual_cost_cents) from ai_usage u join promo_claims p
             on p.company_id = u.company_id and u.created_at >= p.claimed_at where p.code = pc.code), 0) / 100.0, 2)) x
      from promo_codes pc) s),
    'claims', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'company', c.name, 'email', u.email,
        'plan', c.plan, 'claimed_at', p.claimed_at, 'expires_at', p.expires_at, 'expired', p.expired_at is not null,
        'ai_cost_usd', round(coalesce((select sum(a.actual_cost_cents) from ai_usage a
             where a.company_id = p.company_id and a.created_at >= p.claimed_at), 0) / 100.0, 2))
        order by p.claimed_at desc), '[]')
      from promo_claims p left join companies c on c.id = p.company_id left join auth.users u on u.id = p.user_id));
end $$;
revoke all on function q_promo_admin() from public, anon;
grant execute on function q_promo_admin() to authenticated;
