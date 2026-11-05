-- Feedback reaches the team at once (2026-11-05). Customers could already rate a BOQ ("Does this BOQ match
-- your drawings? Yes / No"), answer the one-line pulse, report a problem or suggest an improvement, but it
-- only sat in Admin until someone looked. Now each one sends a push to the platform admins' devices
-- (same channel as live chat), so a "No" can be followed up while the customer is still interested.
create or replace function public.q_push_feedback() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text; sheet text; t text; b text;
begin
  if coalesce(new.opened_by_admin, false) or new.kind not in ('rating', 'pulse', 'issue', 'improvement') then return new; end if;
  if exists (select 1 from platform_admins where user_id = new.user_id) then return new; end if;
  who := coalesce((select name from companies where id = new.company_id), new.contact_email, 'A customer');
  sheet := (select file_name from drawings where id = new.drawing_id);
  if new.kind = 'rating' then
    t := case when new.category = 'accurate' then '👍 ' || who || ': BOQ looks right' else '👎 ' || who || ': BOQ not right, follow up' end;
  elsif new.kind = 'pulse' then
    t := case when new.category = 'bad' then '😕 ' || who || ': not happy' else '🙂 ' || who || ': feedback "' || coalesce(new.category, '') || '"' end;
  elsif new.kind = 'issue' then
    t := '⚠️ ' || who || ' reported a problem';
  else
    t := '💡 ' || who || ' suggested an improvement';
  end if;
  b := coalesce(nullif(new.message, ''), sheet, 'Open Admin → Messages to see it.');
  perform q_push_send(t, b, 'q-fb-' || new.id::text);
  return new;
exception when others then
  raise warning 'q_push_feedback failed: %', sqlerrm;
  return new;
end $$;
revoke all on function public.q_push_feedback() from public, anon, authenticated;
drop trigger if exists q_push_feedback_ticket on public.support_tickets;
create trigger q_push_feedback_ticket after insert on public.support_tickets for each row execute function public.q_push_feedback();
