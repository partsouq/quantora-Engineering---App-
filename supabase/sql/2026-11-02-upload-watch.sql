-- 2026-11-02 Upload watch: a drawing file that reached storage but never got its drawings row
-- means the user's upload failed after the file was sent (exactly the 1-2 Nov page_count bug).
-- Checked on the server every 15 minutes, so it works even if the browser never reports the error.

create or replace function public.q_upload_watch()
returns void language plpgsql security definer set search_path = public, storage as $$
declare n int; who text; al record; ex jsonb;
begin
  select count(*), string_agg(distinct coalesce(u.email, '?'), ', ')
    into n, who
    from storage.objects o
    left join auth.users u on u.id = o.owner
   where o.bucket_id = 'drawings'
     and o.created_at >= now() - interval '20 minutes' and o.created_at < now() - interval '5 minutes'
     and split_part(o.name, '/', 2) ~ '^[0-9]{10,}_' and split_part(o.name, '/', 3) = ''
     and not exists (select 1 from drawings d where d.storage_path = o.name)
     and not exists (select 1 from platform_admins a where a.user_id = o.owner)
     and not exists (select 1 from q_internal_users i where i.user_id = o.owner);
  if coalesce(n, 0) = 0 then return; end if;
  ex := jsonb_build_object('at', now(), 'user_email', who, 'file', n || ' file(s)', 'source_kind', 'upload not saved');
  select * into al from admin_alerts where fingerprint = 'upload:not-saved';
  if found then
    update admin_alerts
       set occurrences = occurrences + n, last_seen = now(), updated_at = now(),
           error_text = 'Drawing files reached storage but were never saved as drawings. Latest users: ' || left(who, 400),
           examples = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(coalesce(al.examples, '[]'::jsonb) || jsonb_build_array(ex)) e offset greatest(0, jsonb_array_length(coalesce(al.examples, '[]'::jsonb)) + 1 - 10)) x),
           status = case when al.status in ('fixed', 'ignored') then 'open' else al.status end
     where id = al.id;
  else
    insert into admin_alerts (fingerprint, service, title, error_text, occurrences, first_seen, last_seen, examples, status)
    values ('upload:not-saved', 'upload', 'Drawing uploads are failing (file sent, drawing not saved)',
            'Drawing files reached storage but were never saved as drawings. Users: ' || left(who, 400), n, now(), now(), jsonb_build_array(ex), 'open');
  end if;
end $$;
revoke all on function public.q_upload_watch() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'upload-watch';
select cron.schedule('upload-watch', '*/15 * * * *', $cron$select public.q_upload_watch()$cron$);

create or replace function public.q_ops_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public, auth as $$
  with adm as (select user_id from platform_admins union select user_id from q_internal_users),
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
    'user_errors', (select count(*) from client_errors where created_at >= p_from and created_at < p_to and user_id not in (select user_id from adm)),
    'user_errors_users', (select count(distinct user_id) from client_errors where created_at >= p_from and created_at < p_to and user_id not in (select user_id from adm)),
    'uploads_not_saved', (select count(*) from storage.objects o
                where o.bucket_id = 'drawings' and o.created_at >= p_from and o.created_at < p_to
                  and split_part(o.name, '/', 2) ~ '^[0-9]{10,}_' and split_part(o.name, '/', 3) = ''
                  and coalesce(o.owner::text, '') not in (select user_id::text from adm)
                  and not exists (select 1 from drawings d where d.storage_path = o.name)),
    'robot', (select jsonb_build_object('runs', count(*), 'failed', count(*) filter (where not ok),
                'last_at', max(created_at), 'last_ok', (select ok from robot_runs order by created_at desc limit 1))
                from robot_runs where created_at >= p_from and created_at < p_to),
    'alerts_new',  (select count(*) from admin_alerts where first_seen >= p_from and first_seen < p_to),
    'alerts_open', (select count(*) from admin_alerts where status = 'open'),
    'stuck_runs',  (select count(*) from analysis_runs where status = 'processing' and created_at < now() - interval '30 minutes' and created_at > now() - interval '1 day'),
    'stuck_jobs',  (select count(*) from draftsman_jobs where status in ('queued', 'running') and created_at < now() - interval '60 minutes' and created_at > now() - interval '1 day')
  );
$$;
revoke all on function public.q_ops_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.q_ops_stats(timestamptz, timestamptz) to service_role;
