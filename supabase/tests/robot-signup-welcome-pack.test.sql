-- Test for 2026-11-07-robot-signup-welcome-pack.sql. Run after applying it:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/robot-signup-welcome-pack.test.sql
-- Everything runs inside a transaction and is rolled back; nothing is kept.
begin;

do $$
declare
  robot_id uuid := gen_random_uuid();
  repeat_id uuid := gen_random_uuid();
  c record;
begin
  -- a repeat-trial log entry for the same Gmail base address already exists
  insert into trial_signup_log (company_id, normalized_email, signup_ip)
    values (null, 'qtestbase@gmail.com', '10.0.0.1');

  -- 1. the sign-up robot gets a normal Welcome Pack even though its base address is logged
  insert into auth.users (id, email) values (robot_id, 'quantoraengineering01+signuptest1@gmail.com');
  insert into trial_signup_log (company_id, normalized_email, signup_ip)
    values (null, 'quantoraengineering01@gmail.com', '10.0.0.1')
    on conflict do nothing;
  perform public.bootstrap_company_for_user(robot_id, 'quantoraengineering01+signuptest1@gmail.com', 'Robot', '10.0.0.1');
  select co.plan, co.trial_end_date into c from profiles p join companies co on co.id = p.company_id where p.id = robot_id;
  if c.plan <> 'trial' or c.trial_end_date <= now() then
    raise exception 'FAIL: robot sign-up did not get a Welcome Pack (plan %, ends %)', c.plan, c.trial_end_date;
  end if;
  if exists (select 1 from trial_signup_log l join profiles p on p.company_id = l.company_id where p.id = robot_id) then
    raise exception 'FAIL: robot sign-up was written to trial_signup_log';
  end if;

  -- 2. a real repeat trial (same Gmail base, "+tag" added) is still closed at once
  insert into auth.users (id, email) values (repeat_id, 'q.test.base+again@gmail.com');
  perform public.bootstrap_company_for_user(repeat_id, 'q.test.base+again@gmail.com', 'Repeat', '10.0.0.2');
  select co.trial_end_date into c from profiles p join companies co on co.id = p.company_id where p.id = repeat_id;
  if c.trial_end_date > now() then
    raise exception 'FAIL: repeat trial was not caught';
  end if;

  raise notice 'PASS: robot gets a Welcome Pack; real repeat trials still caught';
end $$;

rollback;
