-- Quantora: real push notifications for Live Chat (2026-11-01)
-- Each browser/phone that turns on chat alerts stores its push address here. When a customer writes in
-- Live Chat, the database asks the push-notify function to send a notification to every platform
-- admin's devices -- it arrives even when the Quantora app or Chrome window is closed.
-- Safe to run more than once.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subs_own_select on public.push_subscriptions;
create policy push_subs_own_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists push_subs_own_insert on public.push_subscriptions;
create policy push_subs_own_insert on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists push_subs_own_update on public.push_subscriptions;
create policy push_subs_own_update on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists push_subs_own_delete on public.push_subscriptions;
create policy push_subs_own_delete on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- The database's own key for calling push-notify. Random, generated here, never shown to anyone.
insert into public.app_secrets (key, value, updated_at)
values ('PUSH_INTERNAL_SECRET', encode(extensions.gen_random_bytes(24), 'hex'), now())
on conflict (key) do nothing;

create or replace function public.q_push_send(p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_secret text;
begin
  select value into v_secret from app_secrets where key = 'PUSH_INTERNAL_SECRET';
  if coalesce(v_secret, '') = '' then return; end if;
  perform net.http_post(
    url := 'https://mcwcvyuvlkmqsivnzvjy.supabase.co/functions/v1/push-notify',
    body := jsonb_build_object('action', 'send', 'title', p_title, 'body', left(coalesce(p_body, ''), 300), 'tag', p_tag, 'url', '/'),
    -- the public (anon) key only gets past the gateway; the real check is the internal secret
    headers := jsonb_build_object('content-type', 'application/json', 'x-push-secret', v_secret,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jd2N2eXV2bGttcXNpdm56dmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ5OTksImV4cCI6MjEwMDc0MDk5OX0.YhwsYhxZOyNjCKqeycQorP88TDqCSYRsZutwWnvoRY0'),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'q_push_send failed: %', sqlerrm;    -- a notification must never block the customer's message
end $$;
revoke all on function public.q_push_send(text, text, text) from public, anon, authenticated;

create or replace function public.q_push_alert()
returns trigger language plpgsql security definer set search_path = public as $$
declare t record; who text;
begin
  if new.from_admin then return new; end if;
  select * into t from support_tickets where id = new.ticket_id;
  if t is null or coalesce(t.category, '') <> 'live_chat' then return new; end if;
  who := coalesce((select name from companies where id = t.company_id), t.contact_email, 'A customer');
  perform q_push_send('💬 ' || who, new.body, 'q-live-' || t.id::text);
  return new;
exception when others then
  raise warning 'q_push_alert failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists q_push_alert_msg on public.support_messages;
create trigger q_push_alert_msg after insert on public.support_messages for each row execute function public.q_push_alert();
