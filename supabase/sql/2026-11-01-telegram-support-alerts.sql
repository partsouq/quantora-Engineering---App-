-- Quantora: Telegram alert to the team when a customer writes (2026-11-01)
-- Live chat messages and new support tickets send a short Telegram message to the team, straight from
-- the database (pg_net), so it arrives even when every browser is closed.
-- Needs app_secrets TELEGRAM_BOT_TOKEN (set by the owner) and TELEGRAM_CHAT_ID (the chat the bot
-- writes to). Without them the trigger does nothing. Safe to run more than once.

create or replace function public.q_telegram_send(p_text text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_chat text;
begin
  select value into v_token from app_secrets where key = 'TELEGRAM_BOT_TOKEN';
  select value into v_chat  from app_secrets where key = 'TELEGRAM_CHAT_ID';
  if coalesce(v_token, '') = '' or coalesce(v_chat, '') = '' then return; end if;
  perform net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body := jsonb_build_object('chat_id', v_chat, 'text', left(p_text, 3500), 'disable_web_page_preview', true),
    headers := '{"content-type":"application/json"}'::jsonb,
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'q_telegram_send failed: %', sqlerrm;     -- an alert must never block the customer's message
end $$;
revoke all on function public.q_telegram_send(text) from public, anon, authenticated;

create or replace function public.q_support_alert()
returns trigger language plpgsql security definer set search_path = public as $$
declare t record; who text; recent int;
begin
  if tg_table_name = 'support_tickets' then
    if new.kind in ('rating', 'pulse', 'outreach') or coalesce(new.opened_by_admin, false) then return new; end if;
    who := coalesce((select name from companies where id = new.company_id), new.contact_email, 'A customer');
    perform q_telegram_send(
      case when new.category = 'live_chat' then '💬 New live chat — ' else '🛠 New support ticket (' || new.kind || ') — ' end
      || who || coalesce(' <' || new.contact_email || '>', '') || E'\n\n' || left(coalesce(new.message, ''), 600)
      || E'\n\nReply: https://quantoraengineering.com → Admin → '
      || case when new.category = 'live_chat' then 'Live Chat' else 'Support & Feedback' end);
  else
    if new.from_admin then return new; end if;
    select * into t from support_tickets where id = new.ticket_id;
    if t is null then return new; end if;
    -- one alert per burst: not again while the same customer keeps typing (2 minutes)
    select count(*) into recent from support_messages
      where ticket_id = new.ticket_id and from_admin = false and id <> new.id and created_at > now() - interval '2 minutes';
    if recent > 0 then return new; end if;
    who := coalesce((select name from companies where id = t.company_id), t.contact_email, 'A customer');
    perform q_telegram_send('💬 ' || who || coalesce(' <' || t.contact_email || '>', '') || ' wrote:' || E'\n\n'
      || left(coalesce(new.body, ''), 600) || E'\n\nReply: https://quantoraengineering.com → Admin → '
      || case when t.category = 'live_chat' then 'Live Chat' else 'Support & Feedback' end);
  end if;
  return new;
exception when others then
  raise warning 'q_support_alert failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists q_support_alert_ticket on public.support_tickets;
create trigger q_support_alert_ticket after insert on public.support_tickets for each row execute function public.q_support_alert();
drop trigger if exists q_support_alert_msg on public.support_messages;
create trigger q_support_alert_msg after insert on public.support_messages for each row execute function public.q_support_alert();
