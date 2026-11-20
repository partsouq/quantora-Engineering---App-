-- 2026-11-20 Auto-management (apply after approval).
-- 1. Stuck take-offs are closed after 12 minutes instead of 20 (a sheet normally takes 1.5-3 minutes;
--    the engine's own hard limit is about 6.5 minutes).
create or replace function public.q_close_stuck_runs()
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare r record; n int := 0; c int; failed_n int := 0; who text := '';
begin
  for r in select ar.id, ar.summary, ar.project_id from analysis_runs ar
           where ar.status = 'processing' and ar.created_at < now() - interval '12 minutes'
             and ar.created_at > now() - interval '2 days'
           for update skip locked
  loop
    if exists (select 1 from civil_measure_jobs j where j.analysis_run_id = r.id and j.status in ('queued','running')) then
      continue;
    end if;
    select count(*) into c from boq_items where analysis_run_id = r.id;
    if c > 0 then
      update analysis_runs set status = 'completed', completed_at = now(),
        summary = coalesce(r.summary, '{}'::jsonb) || jsonb_build_object('item_count', c, 'closed_by', 'stuck-run watchdog')
      where id = r.id;
    else
      update analysis_runs set status = 'failed', completed_at = now(),
        error_message = 'The take-off timed out before it finished. Nothing was charged. Run the sheet again.'
      where id = r.id;
      failed_n := failed_n + 1;
      who := who || coalesce((select p.project_name from projects p where p.id = r.project_id), '?') || '; ';
    end if;
    n := n + 1;
  end loop;
  -- 2. tell the admin portal, so a stuck run is never silent
  if failed_n > 0 then
    insert into admin_alerts (fingerprint, service, title, error_text, occurrences, first_seen, last_seen, examples, status)
    values ('run:timed-out', 'ai-engine', 'Take-offs timed out and were closed by the watchdog',
            'Closed as failed (nothing charged). Projects: ' || left(who, 400), failed_n, now(), now(),
            jsonb_build_array(jsonb_build_object('at', now(), 'projects', left(who, 400))), 'open')
    on conflict (fingerprint) do update
      set occurrences = admin_alerts.occurrences + excluded.occurrences, last_seen = now(), updated_at = now(),
          error_text = excluded.error_text,
          status = case when admin_alerts.status in ('fixed','ignored') then 'open' else admin_alerts.status end;
  end if;
  return n;
end $function$;

-- 3. Sign-ups that have not confirmed their email 20 minutes after signing up: one alert per person,
--    so the admin can resend or use "Confirm now" in Customers -> Waiting for email confirmation.
create or replace function public.q_signup_watch()
 returns integer language plpgsql security definer set search_path to 'public', 'auth' as $function$
declare u record; n int := 0;
begin
  for u in select id, email, coalesce(raw_user_meta_data->>'full_name', '') fn, created_at
             from auth.users
            where email_confirmed_at is null and email is not null
              and created_at < now() - interval '20 minutes' and created_at > now() - interval '3 days'
              and email !~* '^quantoraengineering01\+'
  loop
    insert into admin_alerts (fingerprint, service, title, error_text, occurrences, first_seen, last_seen, examples, status)
    values ('signup:unconfirmed:' || u.id, 'signup',
            'New sign-up has not confirmed their email: ' || coalesce(nullif(u.fn, ''), u.email),
            u.email || ' signed up ' || to_char(u.created_at at time zone 'Asia/Dubai', 'DD Mon HH24:MI') ||
            ' (Dubai) and has not clicked the confirmation link. Customers -> Waiting for email confirmation: Resend, or Confirm now.',
            1, now(), now(), '[]'::jsonb, 'open')
    on conflict (fingerprint) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $function$;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'signup-watch') then
    perform cron.schedule('signup-watch', '*/10 * * * *', 'select public.q_signup_watch()');
  end if;
end $$;
