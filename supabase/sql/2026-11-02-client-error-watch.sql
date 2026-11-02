-- Quantora (2026-11-02): the agent sees every error a user hits.
-- The app records an unexpected failure (upload, project creation, AI request, page crash) in
-- client_errors. For each new kind of error this:
--   1. raises / re-opens an admin alert  -> pushed instantly as "Alert" (q_alert_push trigger),
--   2. opens a live chat for the user with "it's on our side, we're on it" (once per user per error per day),
--   3. when the alert is marked Fixed, tells every affected user in that chat: "Fixed, please try again".
-- Repeats of the same error are counted on the one alert (no flood). Safe to run more than once.

create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  context text not null,          -- what the user was doing, e.g. "upload a drawing"
  message text,                   -- the error text
  fingerprint text not null,      -- context + normalised message
  page text,
  details jsonb
);
create index if not exists client_errors_fp on public.client_errors (fingerprint, created_at desc);
create index if not exists client_errors_user on public.client_errors (user_id, created_at desc);
alter table public.client_errors enable row level security;
drop policy if exists client_errors_insert_own on public.client_errors;
create policy client_errors_insert_own on public.client_errors for insert to authenticated with check (user_id = auth.uid());
drop policy if exists client_errors_admin_read on public.client_errors;
create policy client_errors_admin_read on public.client_errors for select to authenticated using (is_platform_admin());

create or replace function public.q_client_error_ingest()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fp text := 'app:' || left(new.fingerprint, 300);
  al record; v_email text; v_company uuid; v_admin uuid; v_ticket uuid; recent int; ex jsonb;
begin
  -- platform admins testing do not raise alerts; a runaway browser cannot flood (30 per user per hour)
  if exists (select 1 from platform_admins where user_id = new.user_id) then return new; end if;
  select count(*) into recent from client_errors where user_id = new.user_id and created_at > now() - interval '1 hour';
  if recent > 30 then return new; end if;

  select email into v_email from auth.users where id = new.user_id;
  select company_id into v_company from profiles where id = new.user_id;
  ex := jsonb_build_object('at', now(), 'user_email', v_email, 'file', new.context, 'source_kind', 'user error', 'page', new.page);

  select * into al from admin_alerts where fingerprint = fp;
  if found then
    update admin_alerts
       set occurrences = occurrences + 1, last_seen = now(), updated_at = now(),
           examples = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(coalesce(al.examples, '[]'::jsonb) || jsonb_build_array(ex)) e offset greatest(0, jsonb_array_length(coalesce(al.examples, '[]'::jsonb)) + 1 - 10)) x),
           status = case when al.status in ('fixed', 'ignored') then 'open' else al.status end
     where id = al.id;
  else
    insert into admin_alerts (fingerprint, service, title, error_text, occurrences, first_seen, last_seen, examples, status)
    values (fp, 'app', 'Users hitting an error: ' || left(new.context, 80), left(coalesce(new.message, ''), 4000), 1, now(), now(), jsonb_build_array(ex), 'open');
  end if;

  -- live chat for the user, once per user per error per day
  if not exists (select 1 from support_tickets where user_id = new.user_id and page_context = 'auto-error:' || left(new.fingerprint, 300)
                 and created_at > now() - interval '1 day') then
    select user_id into v_admin from platform_admins limit 1;
    insert into support_tickets (user_id, company_id, contact_email, kind, category, message, page_context, status, opened_by_admin)
    values (new.user_id, v_company, v_email, 'help', 'live_chat',
            'Automatic: "' || left(new.context, 80) || '" did not work for this user. ' || left(coalesce(new.message, ''), 300),
            'auto-error:' || left(new.fingerprint, 300), 'in_progress', true)
    returning id into v_ticket;
    if v_admin is not null then
      insert into support_messages (ticket_id, sender_user_id, from_admin, body)
      values (v_ticket, v_admin, true,
        'Hi, this is the Quantora team. We saw that "' || left(new.context, 80) || '" did not work for you just now. It is a problem on our side, not something you did, and we are fixing it. We will message you right here as soon as it works again. Sorry for the trouble!');
    end if;
  end if;
  return new;
exception when others then
  raise warning 'q_client_error_ingest failed: %', sqlerrm;
  return new;
end $$;
revoke all on function public.q_client_error_ingest() from public, anon, authenticated;
drop trigger if exists q_client_error_ingest on public.client_errors;
create trigger q_client_error_ingest after insert on public.client_errors for each row execute function public.q_client_error_ingest();

-- When an app alert is marked Fixed, tell the affected users in their chat.
create or replace function public.q_client_error_fixed()
returns trigger language plpgsql security definer set search_path = public as $$
declare t record; v_admin uuid;
begin
  if new.service <> 'app' or new.status <> 'fixed' or coalesce(old.status, '') = 'fixed' then return new; end if;
  select user_id into v_admin from platform_admins limit 1;
  if v_admin is null then return new; end if;
  for t in select distinct on (user_id) id from support_tickets
            where page_context = 'auto-error:' || substr(new.fingerprint, 5) and status <> 'resolved'
            order by user_id, created_at desc loop
    insert into support_messages (ticket_id, sender_user_id, from_admin, body)
    values (t.id, v_admin, true, 'Good news: this is fixed now. Please try again, and reply here if anything still does not work.');
  end loop;
  return new;
exception when others then
  raise warning 'q_client_error_fixed failed: %', sqlerrm;
  return new;
end $$;
revoke all on function public.q_client_error_fixed() from public, anon, authenticated;
drop trigger if exists q_client_error_fixed on public.admin_alerts;
create trigger q_client_error_fixed after update of status on public.admin_alerts for each row execute function public.q_client_error_fixed();

-- Hourly report: errors users hit this hour.
create or replace function public.q_ops_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public, auth as $$
  with adm as (select user_id from platform_admins),
  admin_projects as (select p.id from projects p where p.owner_id in (select user_id from adm)),
  runs as (select * from analysis_runs r where r.created_at >= p_from and r.created_at < p_to
             and r.project_id not in (select id from admin_projects) and coalesce(r.is_admin_assisted, false) = false)
  select jsonb_build_object(
    'users', jsonb_build_object(
      'signups', (select count(*) from auth.users u where u.created_at >= p_from and u.created_at < p_to and u.id not in (select user_id from adm)),
      'logins',  (select count(*) from auth.users u where u.last_sign_in_at >= p_from and u.last_sign_in_at < p_to and u.id not in (select user_id from adm))),
    'runs', jsonb_build_object(
      'completed', (select count(*) from runs where status = 'completed'),
      'failed',    (select count(*) from runs where status = 'failed'),
      'empty',     (select count(*) from runs where status = 'completed' and coalesce(run_kind,'') <> 'quotation_compliance'
                      and coalesce(run_kind,'') <> 'design_ifc' and coalesce((summary->>'item_count')::int, 0) = 0)),
    'drawings', jsonb_build_object(
      'done',   (select count(*) from draftsman_jobs where coalesce(finished_at, created_at) >= p_from and coalesce(finished_at, created_at) < p_to and status = 'done'
                   and project_id not in (select id from admin_projects)),
      'failed', (select count(*) from draftsman_jobs where coalesce(finished_at, created_at) >= p_from and coalesce(finished_at, created_at) < p_to and status = 'failed'
                   and project_id not in (select id from admin_projects))),
    'pages', (select coalesce(sum(page_count), 0) from ai_usage where created_at >= p_from and created_at < p_to and coalesce(is_admin_assisted, false) = false
                and coalesce(user_id::text, '') not in (select user_id::text from adm)),
    'chats', jsonb_build_object(
      'new_chats', (select count(*) from support_tickets where category = 'live_chat' and created_at >= p_from and created_at < p_to and coalesce(opened_by_admin, false) = false
                      and user_id not in (select user_id from adm)),
      'customer_messages', (select count(*) from support_messages m join support_tickets t on t.id = m.ticket_id
                      where t.category = 'live_chat' and m.from_admin = false and m.created_at >= p_from and m.created_at < p_to and t.user_id not in (select user_id from adm)),
      'waiting', (select count(*) from support_tickets t where t.category = 'live_chat' and t.status <> 'resolved' and t.user_id not in (select user_id from adm)
                    and coalesce((select max(m.created_at) from support_messages m where m.ticket_id = t.id and m.from_admin), 'epoch'::timestamptz)
                      < greatest(t.created_at, coalesce((select max(m.created_at) from support_messages m where m.ticket_id = t.id and not m.from_admin), t.created_at)))),
    'ratings', (select jsonb_build_object('count', count(*), 'avg', round(avg(rating)::numeric, 1)) from platform_feedback
                  where created_at >= p_from and created_at < p_to and coalesce(user_id::text, '') not in (select user_id::text from adm)),
    'payments', (select count(*) from billing_events where received_at >= p_from and received_at < p_to),
    'user_errors', (select count(*) from client_errors where created_at >= p_from and created_at < p_to and user_id not in (select user_id from adm)),
    'user_errors_users', (select count(distinct user_id) from client_errors where created_at >= p_from and created_at < p_to and user_id not in (select user_id from adm)),
    'alerts_new',  (select count(*) from admin_alerts where first_seen >= p_from and first_seen < p_to),
    'alerts_open', (select count(*) from admin_alerts where status = 'open'),
    'stuck_runs',  (select count(*) from analysis_runs where status = 'processing' and created_at < now() - interval '30 minutes' and created_at > now() - interval '1 day'),
    'stuck_jobs',  (select count(*) from draftsman_jobs where status in ('queued', 'running') and created_at < now() - interval '60 minutes' and created_at > now() - interval '1 day')
  );
$$;
revoke all on function public.q_ops_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.q_ops_stats(timestamptz, timestamptz) to service_role;
