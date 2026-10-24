-- Quantora: take-off scope chosen on upload (24 Oct 2026). Applied. Additive.
alter table public.drawings add column if not exists takeoff_systems text[] not null default '{}';
alter table public.drawings add column if not exists takeoff_custom  text[] not null default '{}';
alter table public.drawings add column if not exists sheet_type      text;
alter table public.drawings drop constraint if exists drawings_sheet_type_check;
alter table public.drawings add constraint drawings_sheet_type_check check (sheet_type is null or sheet_type in
  ('floor_plan', 'riser_schematic', 'single_line', 'schedule', 'legend', 'section_detail', 'mixed'));
