-- No silent failures for drawings (approved 17 Nov 2026, zero cost).
-- On 16 Nov a customer's DWG waited for hours: the converter key was a placeholder and the dispatcher gave
-- up quietly. Now:
--   * a missing key, or GitHub refusing to start the converter, raises an alert (pushed at once);
--   * any DWG still waiting 10 minutes after upload raises an alert naming the customer and is retried;
--   * every dispatch is logged so its answer can be checked.
-- Alerts are pushed once when raised (q_alert_push); repeats only update the same alert.

create table if not exists public.dwg_dispatch_log (
  req_id bigint primary key,
  at timestamptz not null default now(),
  checked boolean not null default false
);
alter table public.dwg_dispatch_log enable row level security;
revoke all on public.dwg_dispatch_log from anon, authenticated;

create or replace function public.q_dwg_dispatch()
returns bigint language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare tok text; rid bigint;
begin
  select value into tok from app_secrets where key = 'GITHUB_ROBOT_TOKEN';
  if coalesce(tok, '') !~ '^(github_pat_|ghp_)' then
    perform q_raise_alert('dwg', 'dwg:no-key', 'DWG uploads cannot start converting',
      'The GitHub key for the DWG converter (GITHUB_ROBOT_TOKEN) is missing, so DWG drawings wait. Add a GitHub token with Actions: read and write.',
      jsonb_build_object('at', now(), 'source_kind', 'dwg', 'file', 'converter key'));
    return null;
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/partsouq/quantora-Engineering---App-/actions/workflows/dwg-convert.yml/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'quantora-dwg-dispatch', 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main')) into rid;
  insert into dwg_dispatch_log (req_id) values (rid) on conflict do nothing;
  update dwg_jobs set dispatched_at = now() where status = 'queued';
  return rid;
end $function$;

create or replace function public.q_dwg_watch()
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare r record; c record; v_file text;
begin
  update dwg_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end,
    error = coalesce(error, 'The converter stopped before finishing.'),
    finished_at = case when attempts >= 3 then now() else null end
  where status = 'working' and started_at < now() - interval '20 minutes';
  update dwg_jobs set status = 'queued', attempts = 0, auto_retries = auto_retries + 1, error = null,
    started_at = null, finished_at = null, dispatched_at = null
  where status = 'failed' and auto_retries < 1
    and finished_at < now() - interval '10 minutes' and created_at > now() - interval '2 days';
  if exists (select 1 from dwg_jobs where status = 'queued' and coalesce(dispatched_at, created_at) < now() - interval '5 minutes') then
    perform q_dwg_dispatch();
  end if;

  -- did GitHub accept the start request? (204 = yes)
  for r in select l.req_id, h.status_code, left(coalesce(h.content::text, h.error_msg, ''), 200) body
             from dwg_dispatch_log l join net._http_response h on h.id = l.req_id
            where not l.checked loop
    update dwg_dispatch_log set checked = true where req_id = r.req_id;
    if r.status_code is distinct from 204 then
      perform q_raise_alert('dwg', 'dwg:dispatch-refused', 'DWG converter could not be started',
        'GitHub answered ' || coalesce(r.status_code::text, 'nothing') || ' when asked to start the DWG converter'
        || case when r.status_code in (401, 403) then ' (the GitHub key is wrong or expired: make a new one and update GITHUB_ROBOT_TOKEN). ' else '. ' end
        || r.body, jsonb_build_object('at', now(), 'source_kind', 'dwg', 'file', 'dispatch ' || coalesce(r.status_code::text, '?')));
    else
      update admin_alerts set status = 'fixed', updated_at = now()
       where fingerprint in ('dwg:dispatch-refused', 'dwg:no-key') and status in ('open', 'investigating');
    end if;
  end loop;
  delete from dwg_dispatch_log where at < now() - interval '2 days';

  -- a customer's DWG still waiting 10 minutes after upload: one alert per drawing, naming the customer
  for r in select j.id, j.project_id, j.drawing_id, j.created_at from dwg_jobs j
            where j.status in ('queued', 'working') and j.created_at < now() - interval '10 minutes'
              and j.created_at > now() - interval '2 days'
              and not exists (select 1 from admin_alerts a where a.fingerprint = 'dwg:slow:' || j.id::text) loop
    select * into c from q_project_customer(r.project_id);
    select file_name into v_file from drawings where id = r.drawing_id;
    perform q_raise_alert('dwg', 'dwg:slow:' || r.id::text,
      'DWG still converting after 10 min · ' || coalesce(c.email, 'internal user'),
      coalesce(v_file, 'A DWG') || ' was uploaded ' || to_char(r.created_at at time zone 'Asia/Dubai', 'HH24:MI') ||
      ' (Dubai) and is not ready yet. The converter is being started again automatically.',
      jsonb_build_object('at', now(), 'user_email', c.email, 'file', v_file, 'source_kind', 'dwg', 'project_id', r.project_id));
  end loop;
  -- a drawing that got ready closes its own "still converting" alert
  update admin_alerts a set status = 'fixed', updated_at = now()
    from dwg_jobs j
   where a.fingerprint = 'dwg:slow:' || j.id::text and j.status = 'done' and a.status in ('open', 'investigating');
end $function$;
