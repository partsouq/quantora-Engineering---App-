-- Quantora (2026-11-02): hourly report agent + instant alert notifications, kept separate.
--   * admin_reports       one row per hourly report (Admin -> Hourly Reports)
--   * q_ops_stats()       what happened between two times (used by the ops-report engine)
--   * q_alert_push        every NEW admin alert (or a fixed one coming back) -> its own push "Alert"
--   * cron ops-report-hourly  at :00 every hour (UTC = Dubai on the hour)
-- Safe to run more than once.

create table if not exists public.admin_reports (
  id uuid primary key default gen_random_uuid(),
  period_start timestamptz not null,
  period_end timestamptz not null,
  manual boolean not null default false,
  summary text,
  alerts_count int not null default 0,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_reports_created on public.admin_reports (created_at desc);
alter table public.admin_reports enable row level security;
drop policy if exists admin_reports_admin_read on public.admin_reports;
create policy admin_reports_admin_read on public.admin_reports for select to authenticated using (is_platform_admin());

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
    'alerts_new',  (select count(*) from admin_alerts where first_seen >= p_from and first_seen < p_to),
    'alerts_open', (select count(*) from admin_alerts where status = 'open'),
    'stuck_runs',  (select count(*) from analysis_runs where status = 'processing' and created_at < now() - interval '30 minutes' and created_at > now() - interval '1 day'),
    'stuck_jobs',  (select count(*) from draftsman_jobs where status in ('queued', 'running') and created_at < now() - interval '60 minutes' and created_at > now() - interval '1 day')
  );
$$;
revoke all on function public.q_ops_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.q_ops_stats(timestamptz, timestamptz) to service_role;

-- Alerts: their own notification, instantly, never inside the hourly report.
create or replace function public.q_alert_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and not (coalesce(old.status, '') <> 'open' and new.status = 'open') then return new; end if;
  perform q_push_send('⚠️ Alert · ' || coalesce(new.service, 'platform'), coalesce(new.title, 'Platform alert'), 'q-alert-' || new.id::text);
  return new;
exception when others then
  raise warning 'q_alert_push failed: %', sqlerrm;
  return new;
end $$;
revoke all on function public.q_alert_push() from public, anon, authenticated;
drop trigger if exists q_alert_push on public.admin_alerts;
create trigger q_alert_push after insert or update of status on public.admin_alerts for each row execute function public.q_alert_push();

-- The hourly run.
select cron.unschedule('ops-report-hourly') where exists (select 1 from cron.job where jobname = 'ops-report-hourly');
select cron.schedule('ops-report-hourly', '0 * * * *', $cron$
  select net.http_post(
    url := 'https://mcwcvyuvlkmqsivnzvjy.supabase.co/functions/v1/ops-report',
    body := '{"action":"hourly"}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-push-secret', (select value from public.app_secrets where key = 'PUSH_INTERNAL_SECRET'),
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jd2N2eXV2bGttcXNpdm56dmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ5OTksImV4cCI6MjEwMDc0MDk5OX0.YhwsYhxZOyNjCKqeycQorP88TDqCSYRsZutwWnvoRY0'),
    timeout_milliseconds := 60000);
$cron$);
