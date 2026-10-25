-- Run ONCE when the Welcome Pack 7-day rule goes live (after welcome-cleanup
-- is deployed and the app update is merged).

-- 1. Secret the daily schedule uses to call the engine.
insert into public.app_secrets (key, value)
values ('WELCOME_CLEANUP_SECRET', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- 2. Existing Welcome Pack companies get the full 7 days from today.
update public.companies set welcome_delete_at = now() + interval '7 days'
where plan = 'trial' and welcome_delete_at is null;

-- 3. Run every day at 02:30 Dubai time (22:30 UTC).
select cron.schedule('welcome-cleanup-daily', '30 22 * * *', $job$
  select net.http_post(
    url := 'https://mcwcvyuvlkmqsivnzvjy.supabase.co/functions/v1/welcome-cleanup',
    body := '{"action":"run"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select value from public.app_secrets where key = 'WELCOME_CLEANUP_SECRET')));
$job$);
