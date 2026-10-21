-- Quantora: civil take-off, phase 1 (21 Oct 2026)
-- Adds the civil work sections to boq_items and the "civil" drawing type.
-- Only ADDS allowed values; every existing row stays valid. Safe to run again.

-- 1. BOQ sections: every existing value plus the civil ones
alter table public.boq_items drop constraint if exists boq_items_system_category_check;
alter table public.boq_items add constraint boq_items_system_category_check check (system_category = any (array[
  -- existing MEP / ELV / fire
  'cctv','access_control','structured_cabling','wifi','intercom','iptv','public_address','audio_visual',
  'parking_management','anpr','bms','grms','pabx','security_room','nurse_call','gate_barrier',
  'lighting','power_distribution','db_panels','cable_sizing','containment','earthing','lightning_protection',
  'ups','generator','transformer','lv_panel','bus_duct','solar_pv',
  'hvac','fcu','ahu','chillers','ducting','ventilation','smoke_management',
  'water_supply','drainage','pumps','fixtures','hot_water',
  'fire_alarm','fire_fighting','sprinkler','fire_pump','gas_suppression','other',
  -- new: civil works
  'site_works','earthworks','piling','ground_stabilisation','concrete','formwork','reinforcement','structural_steel',
  'masonry','waterproofing','insulation','plaster_render','screed',
  'floor_finishes','wall_finishes','ceiling_finishes','skirting','painting',
  'doors','windows','joinery','metalwork','external_works'
]::text[]));

-- 2. Drawing types: add 'civil' (architectural and structural already exist)
alter table public.drawings drop constraint if exists drawings_discipline_check;
alter table public.drawings add constraint drawings_discipline_check check (discipline = any (array[
  'architectural','electrical','mechanical','plumbing','elv','fire_protection','structural','civil',
  'specification','unspecified'
]::text[]));
