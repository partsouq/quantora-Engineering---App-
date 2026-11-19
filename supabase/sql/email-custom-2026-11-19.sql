-- 19 Nov: the Sent log accepts one-off emails from Email Center > Send one email (run by the owner).
alter table public.email_sends drop constraint if exists email_sends_list_check;
alter table public.email_sends add constraint email_sends_list_check
  check (list = any (array['welcome','updates','leads','custom']));
