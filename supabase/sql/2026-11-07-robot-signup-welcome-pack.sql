-- Quantora (2026-11-07): sign-up robot always failed "Company and Welcome Pack created".
--
-- Cause: the robot signs up as quantoraengineering01+signup<id>@gmail.com. The repeat-trial
-- check normalises Gmail addresses (drops "+tag" and dots), so every robot address becomes
-- quantoraengineering01@gmail.com, which is already in trial_signup_log from the robot's own
-- main account (3 Nov). The robot was treated as a repeat trial and its Welcome Pack closed at
-- once (trial_end_date = now()).
--
-- Fix: robot test addresses (public.q_is_robot_signup) skip the repeat-trial check and are not
-- written to trial_signup_log. Real customers are unchanged: the check still runs for every
-- other address. Same function body as live otherwise.

create or replace function public.bootstrap_company_for_user(p_user_id uuid, p_email text default null::text, p_full_name text default null::text, p_signup_ip text default null::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_norm       text;
  v_trial_days int;
  v_abuse      boolean := false;
  v_now        timestamptz := now();
  v_name       text;
  v_robot      boolean := public.q_is_robot_signup(p_email);
begin
  if p_user_id is null then
    raise exception 'bootstrap_company_for_user: p_user_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select company_id into v_company_id from profiles where id = p_user_id;
  if v_company_id is not null then
    return v_company_id;
  end if;

  select id into v_company_id from companies where created_by_user_id = p_user_id limit 1;
  if v_company_id is null then
    v_norm := normalize_email_for_abuse(p_email);

    -- The sign-up robot is not a repeat trial: skip the check for its test addresses.
    if not v_robot then
      if v_norm <> '' then
        select exists (select 1 from trial_signup_log where normalized_email = v_norm)
          into v_abuse;
      end if;
      if not v_abuse and p_signup_ip is not null then
        select count(*) >= 2 into v_abuse
        from trial_signup_log
        where signup_ip = p_signup_ip
          and created_at >= v_now - interval '30 days';
      end if;
    end if;

    select coalesce(trial_duration_days, 2) into v_trial_days from plans where id = 'trial';
    v_trial_days := coalesce(v_trial_days, 2);

    v_name := coalesce(
      nullif(btrim(p_full_name), ''),
      case when p_email is not null and p_email <> ''
           then split_part(p_email, '@', 1) || '''s Company'
           else 'My Company' end
    );

    insert into companies (name, plan, trial_start_date, trial_end_date, created_by_user_id)
    values (
      v_name,
      'trial',
      v_now,
      case when v_abuse then v_now else v_now + (v_trial_days || ' days')::interval end,
      p_user_id
    )
    returning id into v_company_id;

    -- Robot sign-ups are removed after each run; keep them out of the repeat-trial log.
    if not v_robot then
      insert into trial_signup_log (company_id, normalized_email, signup_ip)
      values (v_company_id, coalesce(nullif(v_norm, ''), p_user_id::text), p_signup_ip);
    end if;
  end if;

  insert into profiles (id, company_id, role)
  values (p_user_id, v_company_id, 'admin')
  on conflict (id) do update set company_id = excluded.company_id;

  return v_company_id;
end;
$function$;
