-- Push notifications for customers (2026-11-05). Until now only platform admins got pushes (live chat);
-- a customer who had closed Quantora heard nothing. Now each customer's own phone / laptop gets:
--   "Your BOQ is ready"          when a take-off run completes with lines
--   "Quantora Team replied"      when the team answers in chat
--   the title of a "fixed for you" / action message from run-doctor
-- Sent through push-notify (action send_user) with the database's internal secret, exactly like q_push_send.
create or replace function public.q_push_user(p_user uuid, p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_secret text;
begin
  if p_user is null then return; end if;
  if not exists (select 1 from push_subscriptions where user_id = p_user) then return; end if;   -- no device registered
  select value into v_secret from app_secrets where key = 'PUSH_INTERNAL_SECRET';
  if coalesce(v_secret, '') = '' then return; end if;
  perform net.http_post(
    url := 'https://mcwcvyuvlkmqsivnzvjy.supabase.co/functions/v1/push-notify',
    body := jsonb_build_object('action', 'send_user', 'user_ids', jsonb_build_array(p_user), 'title', p_title,
                               'body', left(coalesce(p_body, ''), 160), 'tag', p_tag, 'url', '/'),
    headers := jsonb_build_object('content-type', 'application/json', 'x-push-secret', v_secret,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jd2N2eXV2bGttcXNpdm56dmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ5OTksImV4cCI6MjEwMDc0MDk5OX0.YhwsYhxZOyNjCKqeycQorP88TDqCSYRsZutwWnvoRY0'),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'q_push_user failed: %', sqlerrm;
end $$;
revoke all on function public.q_push_user(uuid, text, text, text) from public, anon, authenticated;

-- team reply in chat
create or replace function public.q_push_customer_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not new.from_admin then return new; end if;
  select user_id into t from support_tickets where id = new.ticket_id;
  perform q_push_user(t.user_id, '💬 Quantora Team replied', new.body, 'q-reply-' || new.ticket_id::text);
  return new;
exception when others then return new;
end $$;
drop trigger if exists q_push_customer_reply_msg on public.support_messages;
create trigger q_push_customer_reply_msg after insert on public.support_messages for each row execute function public.q_push_customer_reply();

-- BOQ ready (the final completion: a run held for the measuring worker completes later, and is pushed then)
create or replace function public.q_push_boq_ready() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; who uuid; n int;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  n := coalesce((new.summary->>'item_count')::int, 0);
  if n <= 0 then return new; end if;
  select file_name, uploaded_by into d from drawings where id = new.drawing_id;
  who := case when new.is_admin_assisted then d.uploaded_by else new.triggered_by end;
  if exists (select 1 from platform_admins where user_id = who) then return new; end if;
  perform q_push_user(who, '✅ Your BOQ is ready', coalesce(d.file_name, 'Your drawing') || ': ' || n || ' BOQ lines.', 'q-boq-' || new.id::text);
  return new;
exception when others then return new;
end $$;
drop trigger if exists q_push_boq_ready_run on public.analysis_runs;
create trigger q_push_boq_ready_run after update of status on public.analysis_runs for each row execute function public.q_push_boq_ready();

-- run-doctor messages ("Fixed for you", "Attach a PDF export" ...)
create or replace function public.q_push_user_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform q_push_user(new.user_id, new.title, new.what_happened, 'q-msg-' || new.id::text);
  return new;
exception when others then return new;
end $$;
drop trigger if exists q_push_user_message_ins on public.user_messages;
create trigger q_push_user_message_ins after insert on public.user_messages for each row execute function public.q_push_user_message();
