-- Mezzanine floors on a project (between the ground floor and Level 01). 0 = none.
alter table public.projects add column if not exists mezzanine_levels integer not null default 0
  check (mezzanine_levels between 0 and 3);
