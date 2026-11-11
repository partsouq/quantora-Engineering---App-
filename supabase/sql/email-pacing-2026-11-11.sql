-- Lead email pacing (approved by the owner 11 Nov 2026).
-- "Send" in Admin -> Email Center -> Leads now puts leads in this queue. The scheduler calls the
-- email-center function every 2 minutes; it sends at most one email per call, 25 an hour, and stops
-- at the daily limit (50 in the first week of sending, 75 in the second, then 100).

create table if not exists public.email_lead_queue (
  lead_id   uuid primary key references public.email_leads(id) on delete cascade,
  queued_by uuid,
  queued_at timestamptz not null default now()
);
alter table public.email_lead_queue enable row level security;
drop policy if exists email_lead_queue_read on public.email_lead_queue;
create policy email_lead_queue_read on public.email_lead_queue for select to authenticated using (q_staff_level('email') >= 1);
revoke insert, update, delete on public.email_lead_queue from anon, authenticated;

-- the scheduler's secret (only the database and the email-center function read it)
insert into public.app_secrets (key, value)
select 'EMAIL_QUEUE_SECRET', encode(gen_random_bytes(24), 'hex')
where not exists (select 1 from public.app_secrets where key = 'EMAIL_QUEUE_SECRET');

create or replace function public.q_email_queue_tick()
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare v_secret text;
begin
  if not exists (select 1 from email_lead_queue) then return; end if;
  select value into v_secret from app_secrets where key = 'EMAIL_QUEUE_SECRET';
  if coalesce(v_secret, '') = '' then return; end if;
  perform net.http_post(
    url := 'https://mcwcvyuvlkmqsivnzvjy.supabase.co/functions/v1/email-center',
    body := '{"action":"drain"}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jd2N2eXV2bGttcXNpdm56dmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ5OTksImV4cCI6MjEwMDc0MDk5OX0.YhwsYhxZOyNjCKqeycQorP88TDqCSYRsZutwWnvoRY0'),
    timeout_milliseconds := 60000);
end $$;
revoke all on function public.q_email_queue_tick() from public, anon, authenticated;

select cron.unschedule('email-lead-queue') where exists (select 1 from cron.job where jobname = 'email-lead-queue');
select cron.schedule('email-lead-queue', '*/2 * * * *', 'select public.q_email_queue_tick()');
