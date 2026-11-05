-- Plain notification titles (2026-11-05). Chrome on Android flagged quantoraengineering.com as
-- "possible spam": its on-device checker reads notification text, and emoji titles in bursts look like
-- marketing. Titles now say plainly what happened, with no emoji, and one conversation keeps one tag so
-- its messages replace each other instead of stacking.

-- admins: customer message in live chat
create or replace function public.q_push_alert() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record; who text;
begin
  if new.from_admin then return new; end if;
  select * into t from support_tickets where id = new.ticket_id;
  if t is null or coalesce(t.category, '') <> 'live_chat' then return new; end if;
  who := coalesce((select name from companies where id = t.company_id), t.contact_email, 'A customer');
  perform q_push_send('New chat message: ' || who, new.body, 'q-live-' || t.id::text);
  return new;
exception when others then
  raise warning 'q_push_alert failed: %', sqlerrm;
  return new;
end $$;

-- admins: customer opens a live chat
create or replace function public.q_push_alert_ticket() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if coalesce(new.category, '') <> 'live_chat' or coalesce(new.opened_by_admin, false) then return new; end if;
  who := coalesce((select name from companies where id = new.company_id), new.contact_email, 'A customer');
  perform q_push_send('New chat: ' || who, coalesce(new.message, 'A customer started a live chat.'), 'q-live-' || new.id::text);
  return new;
exception when others then
  raise warning 'q_push_alert_ticket failed: %', sqlerrm;
  return new;
end $$;

-- customer: team reply
create or replace function public.q_push_customer_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not new.from_admin then return new; end if;
  select user_id into t from support_tickets where id = new.ticket_id;
  perform q_push_user(t.user_id, 'Reply from Quantora Team', new.body, 'q-reply-' || new.ticket_id::text);
  return new;
exception when others then return new;
end $$;

-- customer: BOQ ready
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
  perform q_push_user(who, 'Your BOQ is ready', coalesce(d.file_name, 'Your drawing') || ': ' || n || ' BOQ lines.', 'q-boq-' || new.drawing_id::text);
  return new;
exception when others then return new;
end $$;

-- admins: feedback, one stacked notification
create or replace function public.q_push_feedback() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text; sheet text; t text; b text;
begin
  if coalesce(new.opened_by_admin, false) or new.kind not in ('rating', 'pulse', 'issue', 'improvement') then return new; end if;
  if exists (select 1 from platform_admins where user_id = new.user_id) then return new; end if;
  who := coalesce((select name from companies where id = new.company_id), new.contact_email, 'A customer');
  sheet := (select file_name from drawings where id = new.drawing_id);
  if new.kind = 'rating' then
    t := 'Feedback from ' || who;
    b := case when new.category = 'accurate' then 'Says the BOQ looks right.' else 'Says the BOQ is not right. Please follow up.' end;
  elsif new.kind = 'pulse' then
    t := 'Feedback from ' || who;
    b := case when new.category = 'bad' then 'Not happy. Please follow up.' else 'Answered: ' || coalesce(new.category, '') end;
  elsif new.kind = 'issue' then
    t := 'Problem reported by ' || who;
    b := coalesce(nullif(new.message, ''), sheet, 'Open Admin to see it.');
  else
    t := 'Improvement idea from ' || who;
    b := coalesce(nullif(new.message, ''), 'Open Admin to see it.');
  end if;
  perform q_push_send(t, b, 'q-feedback');
  return new;
exception when others then
  raise warning 'q_push_feedback failed: %', sqlerrm;
  return new;
end $$;
