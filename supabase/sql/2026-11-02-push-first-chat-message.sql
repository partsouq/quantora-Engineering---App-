-- Quantora (2026-11-02): push alert for the FIRST message of a new live chat, and test cleanup.
-- A new chat's first message is saved on the ticket itself (support_tickets.message), not as a
-- support_messages row, so the 2026-11-01 trigger never saw it. This adds the same alert on the ticket.
-- Safe to run more than once.

create or replace function public.q_push_alert_ticket()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if coalesce(new.category, '') <> 'live_chat' or coalesce(new.opened_by_admin, false) then return new; end if;
  who := coalesce((select name from companies where id = new.company_id), new.contact_email, 'A customer');
  perform q_push_send('💬 New live chat · ' || who, coalesce(new.message, 'A customer started a live chat.'), 'q-live-' || new.id::text);
  return new;
exception when others then
  raise warning 'q_push_alert_ticket failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists q_push_alert_ticket on public.support_tickets;
create trigger q_push_alert_ticket after insert on public.support_tickets for each row execute function public.q_push_alert_ticket();

-- Remove the live chat test from 2026-11-01 (the "TEST" ticket and its 3 test messages, plus replies).
delete from public.support_messages where ticket_id = '35559d82-ddc0-4e41-9ea9-41df7d7be27d';
delete from public.support_tickets  where id        = '35559d82-ddc0-4e41-9ea9-41df7d7be27d' and message like 'TEST%';
