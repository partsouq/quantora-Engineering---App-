-- ===========================================================================
-- Welcome Pack v2 (25 Oct 2026)
-- Smaller free pack for NEW sign-ups:
--   2 drawing pages, 2 documents (tender / specification), 1 draftsman page,
--   1 rework, 10 AI chat messages, 1 system design request.
-- Welcome Packs that already exist keep what they had, through per-company
-- extras (bonus_* columns) that are cleared when the company changes plan.
-- ===========================================================================

-- 1. new limit and extras columns
alter table plans add column if not exists max_documents integer;
alter table companies add column if not exists bonus_chat_requests integer not null default 0;
alter table companies add column if not exists bonus_rework integer not null default 0;
alter table companies add column if not exists bonus_documents integer not null default 0;
alter table companies add column if not exists bonus_design_requests integer not null default 0;

-- 2. existing Welcome Packs keep their old allowance (old: 5 pages, 20 chats,
--    3 reworks, 2 draftsman pages, 3 designs, documents not limited).
--    RUN ONCE: running this file again would add the extras twice.
update companies set
  bonus_drawing_pages   = coalesce(bonus_drawing_pages, 0) + 3,
  bonus_chat_requests   = bonus_chat_requests + 10,
  bonus_rework          = bonus_rework + 2,
  bonus_draftsman_pages = coalesce(bonus_draftsman_pages, 0) + 1,
  bonus_design_requests = bonus_design_requests + 2,
  bonus_documents       = bonus_documents + 100
where plan = 'trial';

-- 3. the new Welcome Pack
update plans set
  max_drawing_pages      = 2,
  max_documents          = 2,
  max_draftsman_pages    = 1,
  max_rework_per_project = 1,
  max_chat_requests      = 10,
  max_design_requests    = 1
where id = 'trial';

-- 4. documents limit, enforced when a document is added
create or replace function enforce_document_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_max int; v_bonus int; v_used int;
begin
  select t.company_id into v_company from tenders t where t.id = new.tender_id;
  if v_company is null then return new; end if;
  select p.max_documents, coalesce(c.bonus_documents, 0) into v_max, v_bonus
    from companies c join plans p on p.id = coalesce(c.plan, 'free') where c.id = v_company;
  if v_max is null then return new; end if;
  if exists (select 1 from platform_admins pa where pa.user_id = auth.uid()) then return new; end if;
  select count(*) into v_used from tender_documents d join tenders t on t.id = d.tender_id where t.company_id = v_company;
  if v_used >= v_max + v_bonus then
    raise exception 'Your plan includes % document%. Choose a plan to add more tender or specification documents.',
      v_max + v_bonus, case when v_max + v_bonus = 1 then '' else 's' end
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists tender_documents_limit on tender_documents;
create trigger tender_documents_limit before insert on tender_documents
  for each row execute function enforce_document_limit();

-- 5. extras end when the plan changes (bonus_drawing_pages already does)
create or replace function reset_bonus_on_plan_change()
returns trigger language plpgsql security definer set search_path = public as $function$
begin
  if (new.plan is distinct from old.plan) then
    if coalesce(old.bonus_drawing_pages, 0) <> 0 then
      new.bonus_drawing_pages := 0;
      insert into admin_quota_adjustments (company_id, admin_user_id, adjustment_type, amount, note, previous_value, new_value)
      values (new.id, null, 'bonus_pages_granted', -coalesce(old.bonus_drawing_pages, 0),
        format('Bonus pages cleared automatically because the plan changed from %s to %s.', coalesce(old.plan, 'none'), coalesce(new.plan, 'none')),
        coalesce(old.bonus_drawing_pages, 0)::text, '0');
    end if;
    new.bonus_chat_requests := 0;
    new.bonus_rework := 0;
    new.bonus_documents := 0;
    new.bonus_design_requests := 0;
  end if;
  return new;
end;
$function$;

-- 6. the Free plan (where a repeat sign-up lands) has no documents or designs
update plans set max_documents = 0, max_design_requests = 0 where id = 'free';

-- 7. sample project: a ready-made project every new Welcome Pack gets, which
--    does not count towards the project limit and cannot run AI
alter table projects add column if not exists is_sample boolean not null default false;
create or replace function public.enforce_project_limit()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare v_plan_id text; v_max_projects integer; v_current_count integer;
begin
  if new.company_id is null or coalesce(new.is_sample, false) then return new; end if;
  select plan into v_plan_id from public.companies where id = new.company_id;
  if v_plan_id is null then return new; end if;
  select max_projects into v_max_projects from public.plans where id = v_plan_id;
  if v_max_projects is null then return new; end if;
  select count(*) into v_current_count from public.projects where company_id = new.company_id and not coalesce(is_sample, false);
  if v_current_count >= v_max_projects then
    raise exception 'PROJECT_LIMIT_REACHED: Your % plan allows a maximum of % project(s). Upgrade to create more.', v_plan_id, v_max_projects;
  end if;
  return new;
end;
$function$;

-- New sign-ups are checked from this moment (older accounts are not).
insert into app_secrets (key, value) values ('WELCOME_V2_FROM', now()::text)
  on conflict (key) do nothing;

-- 8. sign-up checks: one row per new company, written by welcome-guard
create table if not exists signup_checks (
  company_id uuid primary key,          -- no foreign key: the record outlives a deleted account,
  user_id uuid,                         -- so deleting and signing up again is still recognised
  email text,
  email_norm text,
  email_domain text,
  device_id text,
  ip text,
  flags text[] not null default '{}',
  outcome text not null,              -- welcome | welcome_work_email | free_repeat | pending_email
  created_at timestamptz not null default now()
);
create index if not exists signup_checks_email_norm on signup_checks(email_norm);
create index if not exists signup_checks_device on signup_checks(device_id);
create index if not exists signup_checks_ip on signup_checks(ip, created_at);
alter table signup_checks enable row level security;   -- service role only

-- 9. "Need more? Ask us" requests
create table if not exists allowance_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  user_id uuid,
  what text,
  message text,
  status text not null default 'open',   -- open | granted | declined
  granted_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table allowance_requests enable row level security;   -- service role only
