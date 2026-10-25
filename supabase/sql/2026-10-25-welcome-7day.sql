-- 2026-10-25: Welcome Pack 7-day rule.
-- A Welcome Pack (plan 'trial') company has 7 days to choose a paid plan.
-- If it does not, the daily welcome-cleanup engine deletes its projects
-- (everything under them cascades) and their files. The login and company stay.

alter table public.companies
  add column if not exists welcome_delete_at timestamptz,
  add column if not exists welcome_cleared_at timestamptz;

comment on column public.companies.welcome_delete_at is
  'Welcome Pack only: projects and files are deleted after this moment unless a paid plan is active. Null = never.';
comment on column public.companies.welcome_cleared_at is
  'Last time welcome-cleanup deleted this company''s Welcome Pack work.';

-- The clock: starts when a company lands on the Welcome Pack, stops (null)
-- the moment it moves to any other plan.
create or replace function public.welcome_clock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.plan = 'trial' then
    if tg_op = 'INSERT' or old.plan is distinct from 'trial' or new.welcome_delete_at is null then
      new.welcome_delete_at := coalesce(
        case when tg_op = 'UPDATE' and old.plan = 'trial' then old.welcome_delete_at end,
        now() + interval '7 days');
    end if;
  else
    new.welcome_delete_at := null;
  end if;
  return new;
end $$;

drop trigger if exists companies_welcome_clock on public.companies;
create trigger companies_welcome_clock before insert or update of plan on public.companies
  for each row execute function public.welcome_clock();

create table if not exists public.welcome_cleanup_log (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  company_id uuid,
  company_name text,
  projects_deleted int not null default 0,
  files_deleted int not null default 0,
  bytes_freed bigint not null default 0,
  dry_run boolean not null default false,
  note text
);
alter table public.welcome_cleanup_log enable row level security;
-- No client policies: only the service role (the engine) reads and writes it.

-- Every file under a set of folder prefixes (project ids), for the engine.
create or replace function public.admin_storage_under(prefixes text[])
returns table (name text, size bigint)
language sql stable security definer set search_path = '' as $$
  select o.name, coalesce((o.metadata->>'size')::bigint, 0)
  from storage.objects o
  where o.bucket_id = 'drawings' and split_part(o.name, '/', 1) = any(prefixes);
$$;

-- Files whose top folder is neither a project nor a company and that no
-- drawing row points at: left behind by projects deleted long ago.
create or replace function public.admin_storage_orphans()
returns table (name text, size bigint)
language sql stable security definer set search_path = '' as $$
  select o.name, coalesce((o.metadata->>'size')::bigint, 0)
  from storage.objects o
  where o.bucket_id = 'drawings'
    and not exists (select 1 from public.projects p where p.id::text = split_part(o.name, '/', 1))
    and not exists (select 1 from public.companies c where c.id::text = split_part(o.name, '/', 1))
    and not exists (select 1 from public.drawings d where d.storage_path = o.name);
$$;

revoke all on function public.admin_storage_under(text[]) from public, anon, authenticated;
revoke all on function public.admin_storage_orphans() from public, anon, authenticated;
grant execute on function public.admin_storage_under(text[]) to service_role;
grant execute on function public.admin_storage_orphans() to service_role;

-- Is the daily job switched on? (read by the engine's status action)
create or replace function public.welcome_cleanup_schedule()
returns table (jobname text, schedule text, active boolean)
language sql stable security definer set search_path = '' as $$
  select j.jobname::text, j.schedule::text, j.active from cron.job j where j.jobname = 'welcome-cleanup-daily';
$$;
revoke all on function public.welcome_cleanup_schedule() from public, anon, authenticated;
grant execute on function public.welcome_cleanup_schedule() to service_role;
