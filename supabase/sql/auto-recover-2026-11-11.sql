-- 2026-11-11 Auto-recover: the user is never left stuck when something fails.
-- 1. A drawing conversion that failed gets one more automatic round (3 tries again) 10 minutes later.
-- 2. When a problem on our side stops a user's work, a short note from the team appears in the user's
--    live chat ("our team is on it"); the chat opens on its own (index.html).
-- 3. q_autofix_notify: lets the test robot account push a note to the admins (used by autofix.yml).
-- Failed take-off runs are never charged (checked: 0 charged failed runs), so nothing to refund here.

alter table public.dwg_jobs add column if not exists auto_retries int not null default 0;

-- Post a team note in the customer's live chat (creates the chat if they have none).
-- Customers only: admins, staff and the test robot are skipped. The same note is not repeated within 6 hours.
create or replace function public.q_team_chat_note(p_user uuid, p_body text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_ticket uuid; v_admin uuid; v_company uuid; v_email text;
begin
  if p_user is null or coalesce(trim(p_body), '') = '' then return; end if;
  if exists (select 1 from platform_admins where user_id = p_user)
     or exists (select 1 from q_internal_users where user_id = p_user)
     or exists (select 1 from platform_staff where user_id = p_user) then return; end if;
  select user_id into v_admin from platform_admins order by created_at limit 1;
  if v_admin is null then return; end if;
  select id into v_ticket from support_tickets
   where user_id = p_user and kind = 'help' and category = 'live_chat' and status <> 'resolved'
   order by created_at desc limit 1;
  if v_ticket is null then
    select company_id into v_company from profiles where id = p_user;
    select email into v_email from auth.users where id = p_user;
    insert into support_tickets (user_id, company_id, contact_email, kind, category, message, status, opened_by_admin, page_context)
    values (p_user, v_company, v_email, 'help', 'live_chat', 'Note from the Quantora team (automatic).', 'in_progress', true, 'auto-team: auto-recover')
    returning id into v_ticket;
  elsif exists (select 1 from support_messages where ticket_id = v_ticket and from_admin and body = p_body
                 and created_at > now() - interval '6 hours') then
    return;
  end if;
  insert into support_messages (ticket_id, sender_user_id, from_admin, body) values (v_ticket, v_admin, true, p_body);
exception when others then
  raise warning 'q_team_chat_note failed: %', sqlerrm;
end $$;
revoke all on function public.q_team_chat_note(uuid, text) from public, anon, authenticated;

-- DWG watch: as before, plus one automatic second round for failed conversions.
create or replace function public.q_dwg_watch()
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  update dwg_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end,
    error = coalesce(error, 'The converter stopped before finishing.'),
    finished_at = case when attempts >= 3 then now() else null end
  where status = 'working' and started_at < now() - interval '20 minutes';
  -- 2026-11-11: one more automatic round, 10 minutes after a conversion failed
  update dwg_jobs set status = 'queued', attempts = 0, auto_retries = auto_retries + 1, error = null,
    started_at = null, finished_at = null, dispatched_at = null
  where status = 'failed' and auto_retries < 1
    and finished_at < now() - interval '10 minutes' and created_at > now() - interval '2 days';
  if exists (select 1 from dwg_jobs where status = 'queued' and coalesce(dispatched_at, created_at) < now() - interval '5 minutes') then
    perform q_dwg_dispatch();
  end if;
end $$;

-- When a conversion has failed for good (after the automatic round), tell the customer in the chat.
create or replace function public.q_dwg_failed_note()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare c record; v_file text;
begin
  if not (new.status = 'failed' and coalesce(old.status, '') <> 'failed' and new.auto_retries >= 1) then return new; end if;
  select * into c from q_project_customer(new.project_id);
  if not found then return new; end if;
  select file_name into v_file from drawings where id = new.drawing_id;
  perform q_team_chat_note(c.user_id,
    'Hi, your drawing ' || coalesce(v_file, '') || ' could not be converted automatically. Our team is already working on it and will reply here as soon as it is fixed. '
    || 'If you need it right away, export the sheet to PDF from AutoCAD and attach the PDF to the same drawing.');
  return new;
exception when others then
  raise warning 'q_dwg_failed_note failed: %', sqlerrm; return new;
end $$;
drop trigger if exists q_dwg_failed_note on public.dwg_jobs;
create trigger q_dwg_failed_note after update of status on public.dwg_jobs
  for each row execute function public.q_dwg_failed_note();

-- autofix.yml: the test robot account pushes a note to the admins' phones.
create or replace function public.q_autofix_notify(p_title text, p_body text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from q_internal_users where user_id = auth.uid()) then raise exception 'not allowed'; end if;
  perform q_push_send(left(p_title, 80), left(p_body, 140), 'q-autofix');
end $$;
revoke all on function public.q_autofix_notify(text, text) from public, anon;
grant execute on function public.q_autofix_notify(text, text) to authenticated;
