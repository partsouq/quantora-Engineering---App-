-- Quantora: Civil & Architectural Estimator, stage 1 (24 Oct 2026)
-- Additive only: new nullable columns, one new table, a wider category list.
-- No existing row or column is changed. Safe to run more than once.

-- 1. The contract's method of measurement, held once on the project ---------
--    Null = not stated; the engine then uses the country's usual method and says
--    on every line that it was assumed, so it is never presented as contractual.
alter table public.projects add column if not exists measurement_standard text;
alter table public.projects add column if not exists measurement_edition  text;
alter table public.projects add column if not exists region               text;   -- state / province / emirate
alter table public.projects add column if not exists boq_preambles        text;   -- BOQ preambles / measurement notes

-- 2. Traceable quantities on every BOQ line ----------------------------------
--    quantity stays the net measured quantity, so every existing screen, total
--    and export keeps working; the new columns sit beside it.
alter table public.boq_items add column if not exists gross_quantity       numeric;
alter table public.boq_items add column if not exists deduction_quantity   numeric;
alter table public.boq_items add column if not exists deductions           jsonb;   -- [{description, formula, qty, applied, reason}]
alter table public.boq_items add column if not exists material_quantity    numeric;
alter table public.boq_items add column if not exists procurement_quantity numeric;
alter table public.boq_items add column if not exists waste_percent        numeric;
alter table public.boq_items add column if not exists dimensions           jsonb;   -- {length_m, width_m, height_m, thickness_mm, ...}
alter table public.boq_items add column if not exists calc_formula         text;
alter table public.boq_items add column if not exists measurement_standard text;
alter table public.boq_items add column if not exists measurement_rule_code text;
alter table public.boq_items add column if not exists drawing_revision     text;
alter table public.boq_items add column if not exists validation_status    text;
alter table public.boq_items add column if not exists validation_notes     text;

alter table public.boq_items drop constraint if exists boq_items_validation_status_check;
alter table public.boq_items add constraint boq_items_validation_status_check check (
  validation_status is null or validation_status = any (array[
    'verified', 'calculated_review_required', 'assumption_based',
    'information_required', 'rule_not_configured', 'drawing_discrepancy']));

-- 3. Civil categories the client asked for -----------------------------------
alter table public.boq_items drop constraint if exists boq_items_system_category_check;
alter table public.boq_items add constraint boq_items_system_category_check check (system_category = any (array[
  'cctv','access_control','structured_cabling','wifi','intercom','iptv','public_address','audio_visual',
  'parking_management','anpr','bms','grms','pabx','security_room','nurse_call','gate_barrier','lighting',
  'power_distribution','db_panels','cable_sizing','containment','earthing','lightning_protection','ups',
  'generator','transformer','lv_panel','bus_duct','solar_pv','hvac','fcu','ahu','chillers','ducting',
  'ventilation','smoke_management','water_supply','drainage','pumps','fixtures','hot_water','fire_alarm',
  'fire_fighting','sprinkler','fire_pump','gas_suppression','other',
  'site_works','earthworks','piling','ground_stabilisation','concrete','formwork','reinforcement',
  'structural_steel','masonry','waterproofing','insulation','plaster_render','screed','floor_finishes',
  'wall_finishes','ceiling_finishes','skirting','painting','doors','windows','joinery','metalwork','external_works',
  'partitions','glazing','cladding','mouldings_trims','roofing','stairs_ramps','pools_water_features']));

-- 4. Measurement rule library ------------------------------------------------
create table if not exists public.civil_measurement_rules (
  id                  uuid primary key default gen_random_uuid(),
  standard            text not null,              -- BASE, POMI, NRM2, IS1200, ...
  edition             text,                       -- null = any edition
  rule_code           text not null,              -- e.g. POMI-MAS-01
  work_category       text not null,              -- boq_items.system_category
  item_type           text,                       -- optional narrower match (regex on the description)
  unit                text not null,
  measurement_basis   text not null,
  formula_hint        text,
  deduct_openings     boolean not null default false,
  deduction_threshold numeric,                    -- an opening is deducted only when larger than this
  deduction_unit      text,                       -- 'm2' for areas, 'm' for lengths (doorway widths)
  junction_rules      text,
  inclusions          text,
  exclusions          text,
  rounding_dp         integer not null default 2,
  waste_percent       numeric,                    -- material allowance only, never added to the BOQ quantity
  jurisdiction        text,
  effective_from      date,
  version             integer not null default 1,
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified', 'withdrawn')),
  verified_by         text,
  verified_at         timestamptz,
  source_note         text not null,
  test_cases          jsonb,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (standard, rule_code, version)
);
create index if not exists civil_measurement_rules_lookup
  on public.civil_measurement_rules (standard, work_category, unit) where active;

alter table public.civil_measurement_rules enable row level security;
drop policy if exists "civil_measurement_rules: read" on public.civil_measurement_rules;
create policy "civil_measurement_rules: read" on public.civil_measurement_rules for select using (auth.uid() is not null);
drop policy if exists "civil_measurement_rules: admin write" on public.civil_measurement_rules;
create policy "civil_measurement_rules: admin write" on public.civil_measurement_rules for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
