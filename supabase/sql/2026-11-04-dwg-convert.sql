-- 2026-11-04 DWG files are converted automatically, so a DWG upload can be analysed like a PDF.
-- Before this, 26 DWG uploads from 2 users sat as "needs a PDF export" and none got a BOQ.
--
-- Flow: a DWG drawing row is inserted -> a job is queued here -> GitHub is asked to run the
-- "Convert DWG" workflow (same GitHub token as the test robot, app_secrets GITHUB_ROBOT_TOKEN) ->
-- the workflow claims the job from the dwg-worker function, converts, uploads the PDF -> q_dwg_finish
-- sets drawings.analysis_source_path, and the app's Analyze button appears.
-- Without the token, the workflow's own 5-minute schedule still picks the job up (slower).

create table if not exists public.dwg_jobs (
  id uuid primary key default gen_random_uuid(),
  drawing_id uuid not null references public.drawings(id) on delete cascade,
  project_id uuid not null,
  storage_path text not null,
  status text not null default 'queued' check (status in ('queued', 'working', 'done', 'failed')),
  attempts int not null default 0,
  error text,
  pages int,
  report jsonb,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists dwg_jobs_open on public.dwg_jobs (status, created_at) where status in ('queued', 'working');
create index if not exists dwg_jobs_drawing on public.dwg_jobs (drawing_id, created_at desc);

alter table public.dwg_jobs enable row level security;
drop policy if exists dwg_jobs_team_select on public.dwg_jobs;
create policy dwg_jobs_team_select on public.dwg_jobs for select to authenticated using (public.team_can_view(project_id));
-- writes only through the functions below (service role / security definer)

-- Ask GitHub to run the converter now. Does nothing without a real token.
create or replace function public.q_dwg_dispatch() returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text; rid bigint;
begin
  select value into tok from app_secrets where key = 'GITHUB_ROBOT_TOKEN';
  if coalesce(tok, '') !~ '^(github_pat_|ghp_)' then return null; end if;
  select net.http_post(
    url := 'https://api.github.com/repos/partsouq/quantora-Engineering---App-/actions/workflows/dwg-convert.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'quantora-dwg-dispatch', 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main')) into rid;
  update dwg_jobs set dispatched_at = now() where status = 'queued';
  return rid;
end $$;
revoke all on function public.q_dwg_dispatch() from public, anon, authenticated;

-- A new DWG drawing queues a job and starts the converter.
create or replace function public.q_dwg_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if lower(coalesce(new.file_type, '')) = 'dwg' and new.analysis_source_path is null and coalesce(new.storage_path, '') <> '' then
    insert into dwg_jobs (drawing_id, project_id, storage_path) values (new.id, new.project_id, new.storage_path);
    perform q_dwg_dispatch();
  end if;
  return new;
end $$;
drop trigger if exists drawings_dwg_enqueue on public.drawings;
create trigger drawings_dwg_enqueue after insert on public.drawings for each row execute function public.q_dwg_enqueue();

-- Worker takes jobs (oldest first; two workers never get the same job).
create or replace function public.q_dwg_claim(p_limit int) returns table (job_id uuid, drawing_id uuid, project_id uuid, storage_path text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with picked as (
    select j.id from dwg_jobs j where j.status = 'queued' order by j.created_at limit greatest(1, least(p_limit, 4))
    for update skip locked)
  update dwg_jobs j set status = 'working', started_at = now(), attempts = j.attempts + 1
  from picked where j.id = picked.id
  returning j.id, j.drawing_id, j.project_id, j.storage_path;
end $$;
revoke all on function public.q_dwg_claim(int) from public, anon, authenticated;

-- Worker reports back. Success attaches the PDF to the drawing; failure retries up to 3 times.
create or replace function public.q_dwg_finish(p_job uuid, p_ok boolean, p_error text, p_path text, p_pages int, p_report jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare j dwg_jobs;
begin
  select * into j from dwg_jobs where id = p_job for update;
  if not found then return; end if;
  if p_ok then
    update dwg_jobs set status = 'done', finished_at = now(), error = null, pages = p_pages, report = p_report where id = p_job;
    update drawings set analysis_source_path = p_path, analysis_source_type = 'pdf',
      total_pages_detected = coalesce(p_pages, total_pages_detected)   -- page_count follows (generated column)
    where id = j.drawing_id and analysis_source_path is null;   -- never replaces an export the user attached
  elsif j.attempts < 3 then
    update dwg_jobs set status = 'queued', error = p_error where id = p_job;
  else
    update dwg_jobs set status = 'failed', finished_at = now(), error = p_error where id = p_job;
  end if;
end $$;
revoke all on function public.q_dwg_finish(uuid, boolean, text, text, int, jsonb) from public, anon, authenticated;

-- Every 2 minutes: a job stuck "working" for 20 minutes goes back in the queue (or fails after 3 tries),
-- and queued jobs that GitHub has not picked up within 5 minutes are dispatched again.
create or replace function public.q_dwg_watch() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update dwg_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end,
    error = coalesce(error, 'The converter stopped before finishing.'),
    finished_at = case when attempts >= 3 then now() else null end
  where status = 'working' and started_at < now() - interval '20 minutes';
  if exists (select 1 from dwg_jobs where status = 'queued' and coalesce(dispatched_at, created_at) < now() - interval '5 minutes') then
    perform q_dwg_dispatch();
  end if;
end $$;
revoke all on function public.q_dwg_watch() from public, anon, authenticated;
select cron.unschedule('dwg-watch') where exists (select 1 from cron.job where jobname = 'dwg-watch');
select cron.schedule('dwg-watch', '*/2 * * * *', 'select public.q_dwg_watch()');
