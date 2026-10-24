-- Quantora: security hardening (24 Oct 2026)
-- No data is changed. Only permissions and function settings.

-- 1. A user could set their own profiles.company_id from the browser and so
--    join another company: read its tenders and credit history, and spend its
--    AI credit. company_id is set only by the server (sign-up, invites), so the
--    browser loses the right to write it. Every other profile field still works.
revoke insert, update on public.profiles from anon, authenticated;
grant insert (id, full_name, first_name, last_name, country, city, role, created_at)
  on public.profiles to authenticated;
grant update (full_name, first_name, last_name, country, city, role)
  on public.profiles to authenticated;

-- 2. build_comparison had no access check and was callable by anyone, even
--    signed out. Only the procurement engine (service role) calls it.
revoke execute on function public.build_comparison(uuid) from public, anon, authenticated;

-- 3. Trigger functions are never meant to be called as API endpoints.
--    (Triggers still fire: EXECUTE is not checked when a trigger runs.)
revoke execute on function public.enforce_draftsman_pages()     from public, anon, authenticated;
revoke execute on function public.platform_feedback_fill()      from public, anon, authenticated;
revoke execute on function public.reset_bonus_on_plan_change()  from public, anon, authenticated;

-- 4. Fixed search_path on the three functions that lacked one.
alter function public.touch_system_brief()      set search_path = public, pg_temp;
alter function public.protect_project_ref()     set search_path = public, pg_temp;
alter function public.default_bid_probability() set search_path = public, pg_temp;

-- 5. Applied after this app change is live (the profile repair no longer
--    writes role): role is set only by the server too.
--    revoke insert, update on public.profiles from authenticated;
--    grant insert (id, full_name, first_name, last_name, country, city, created_at) on public.profiles to authenticated;
--    grant update (full_name, first_name, last_name, country, city) on public.profiles to authenticated;
