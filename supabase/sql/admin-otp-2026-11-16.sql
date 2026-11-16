-- Admin sign-in code (approved 16 Nov 2026).
-- Admin powers (owner and Admin Team) need the sign-in session to be confirmed with a 6-digit code
-- sent to the admin's own email. A confirmed session stays confirmed for 12 hours; a new device or
-- browser is a new session and asks again. Normal users are not affected.
-- Backup if the code email cannot arrive (owner only, in the SQL Editor), turns the check off for 1 hour:
--   insert into app_secrets(key,value,updated_at) values('ADMIN_OTP_OFF_UNTIL', (now() + interval '1 hour')::text, now())
--   on conflict (key) do update set value = excluded.value, updated_at = now();

create table if not exists public.admin_otp_codes (
  user_id uuid primary key,
  code_hash text,
  expires_at timestamptz,
  attempts int not null default 0,
  locked_until timestamptz,
  sent_at timestamptz,
  sends_hour int not null default 0,
  hour_start timestamptz
);
alter table public.admin_otp_codes enable row level security;
revoke all on public.admin_otp_codes from anon, authenticated;

create table if not exists public.admin_verified_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  verified_until timestamptz not null,
  created_at timestamptz not null default now(),
  user_agent text
);
alter table public.admin_verified_sessions enable row level security;
revoke all on public.admin_verified_sessions from anon, authenticated;

-- Is this sign-in session confirmed with a code (or is the backup switch on)?
create or replace function public.q_admin_session_ok(p_uid uuid, p_sid uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_uid is not null and (
    exists (select 1 from app_secrets where key = 'ADMIN_OTP_OFF_UNTIL'
             and value ~ '^\d{4}-\d{2}-\d{2}' and value::timestamptz > now())
    or exists (select 1 from admin_verified_sessions s
                where s.session_id = p_sid and s.user_id = p_uid and s.verified_until > now()));
$$;
revoke execute on function public.q_admin_session_ok(uuid, uuid) from public, anon, authenticated;
grant execute on function public.q_admin_session_ok(uuid, uuid) to service_role;

-- Store a new code (only its hash). One code a minute, at most 10 an hour; refused while locked.
create or replace function public.q_admin_otp_store(p_uid uuid, p_hash text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare r admin_otp_codes;
begin
  select * into r from admin_otp_codes where user_id = p_uid for update;
  if r.user_id is not null then
    if r.locked_until is not null and r.locked_until > now() then return 'locked'; end if;
    if r.sent_at is not null and r.sent_at > now() - interval '60 seconds' then return 'wait'; end if;
    if r.hour_start is not null and r.hour_start > now() - interval '1 hour' and r.sends_hour >= 10 then return 'too_many'; end if;
  end if;
  insert into admin_otp_codes (user_id, code_hash, expires_at, attempts, sent_at, sends_hour, hour_start)
  values (p_uid, p_hash, now() + interval '10 minutes', 0, now(), 1, now())
  on conflict (user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
    attempts = 0, sent_at = now(),
    sends_hour = case when admin_otp_codes.hour_start > now() - interval '1 hour' then admin_otp_codes.sends_hour + 1 else 1 end,
    hour_start = case when admin_otp_codes.hour_start > now() - interval '1 hour' then admin_otp_codes.hour_start else now() end;
  return 'ok';
end $$;
revoke execute on function public.q_admin_otp_store(uuid, text) from public, anon, authenticated;
grant execute on function public.q_admin_otp_store(uuid, text) to service_role;

-- Check a code. 5 wrong tries lock it for 15 minutes. A right code confirms this session for 12 hours.
create or replace function public.q_admin_otp_check(p_uid uuid, p_hash text, p_sid uuid, p_ua text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare r admin_otp_codes;
begin
  if p_sid is null then return 'no_session'; end if;
  select * into r from admin_otp_codes where user_id = p_uid for update;
  if r.user_id is null or r.code_hash is null then return 'none'; end if;
  if r.locked_until is not null and r.locked_until > now() then return 'locked'; end if;
  if r.expires_at < now() then return 'expired'; end if;
  if r.code_hash <> p_hash then
    if r.attempts + 1 >= 5 then
      update admin_otp_codes set attempts = 0, code_hash = null, locked_until = now() + interval '15 minutes' where user_id = p_uid;
      return 'locked';
    end if;
    update admin_otp_codes set attempts = r.attempts + 1 where user_id = p_uid;
    return 'wrong';
  end if;
  update admin_otp_codes set code_hash = null, attempts = 0 where user_id = p_uid;
  insert into admin_verified_sessions (session_id, user_id, verified_until, user_agent)
  values (p_sid, p_uid, now() + interval '12 hours', left(p_ua, 300))
  on conflict (session_id) do update set verified_until = excluded.verified_until, user_agent = excluded.user_agent
   where admin_verified_sessions.user_id = p_uid;
  return 'ok';
end $$;
revoke execute on function public.q_admin_otp_check(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.q_admin_otp_check(uuid, text, uuid, text) to service_role;

-- Admin rights in the database (row rules, admin functions) now also need a confirmed session.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from platform_admins pa where pa.user_id = (select auth.uid()))
     and public.q_admin_session_ok((select auth.uid()),
           nullif((select auth.jwt()) ->> 'session_id', '')::uuid);
$$;
