-- 2026-11-09  Each person can give the AI assistant their own name (default "Estima"). Approved by the owner.
-- Applied as migration assistant_name_2026_11_09.
alter table public.profiles add column if not exists assistant_name text;
alter table public.profiles add column if not exists assistant_named_at timestamptz;
alter table public.profiles drop constraint if exists profiles_assistant_name_ok;
alter table public.profiles add constraint profiles_assistant_name_ok
  check (assistant_name is null or (char_length(btrim(assistant_name)) between 2 and 20 and assistant_name !~ '[<>{}"`\\/;=|]'));
grant update (assistant_name, assistant_named_at) on public.profiles to authenticated;
