-- Quantora: compliance for every country (24 Oct 2026)
-- A country with no rules showed an empty Compliance tab (Azerbaijan, Ethiopia,
-- Germany ...), and the UK, US and Australia held only 4 systems each.
-- International baseline rows now fill any system the country itself does not
-- cover. They are labelled match_level = 'international' so the app shows them
-- as a baseline to confirm with the local authority, never as the country's
-- own rule. Country and city rules are untouched and always win.
-- Safe to run more than once.

-- 1. Baseline rows ------------------------------------------------------------
delete from public.compliance_rules where country = 'International' and source = 'baseline';

insert into public.compliance_rules
  (country, city, system_category, authority, requirement, required_approval, required_certificate,
   testing_requirement, required_documents, approval_process, reference_code, confidence, source)
values
('International', null, 'fire_alarm', 'Local fire authority having jurisdiction (confirm)',
 'Automatic fire detection and alarm sized to occupancy, height and area, with detector spacing, manual call points and alarm audibility to the adopted fire alarm standard.',
 'Fire authority approval of drawings before installation, and final inspection before occupancy', 'Fire alarm completion / commissioning certificate',
 'Functional test of every detector, call point, sounder and interface, witnessed by the authority where required.',
 'Fire alarm layout, cause-and-effect matrix, battery and cable calculations, product approvals', 'Drawing approval -> installation -> testing and commissioning -> authority inspection -> completion certificate',
 'NFPA 72 or EN 54 / BS 5839-1 (whichever the country adopts)', 'low', 'baseline'),
('International', null, 'fire_fighting', 'Local fire authority having jurisdiction (confirm)',
 'Hydrants, hose reels, fire extinguishers and dry/wet risers provided to the adopted fire code for the occupancy and building height.',
 'Fire authority approval of fire-fighting drawings', 'Fire-fighting system completion certificate',
 'Hydrostatic pressure test and flow test of hydrants and hose reels.',
 'Fire-fighting layout, hydraulic calculations, product approvals', 'Drawing approval -> installation -> pressure and flow tests -> authority inspection',
 'NFPA 14 / NFPA 10 or EN 671 / EN 3', 'low', 'baseline'),
('International', null, 'sprinkler', 'Local fire authority having jurisdiction (confirm)',
 'Automatic sprinklers where the adopted code requires them by occupancy, height or area, designed to the hazard classification.',
 'Fire authority approval of sprinkler drawings and hydraulic calculations', 'Sprinkler completion certificate',
 'Hydrostatic test of pipework and flow test at the most remote point.',
 'Sprinkler layout, hydraulic calculations, hazard classification, product approvals', 'Drawing approval -> installation -> pressure and flow tests -> authority inspection',
 'NFPA 13 or EN 12845', 'low', 'baseline'),
('International', null, 'fire_pump', 'Local fire authority having jurisdiction (confirm)',
 'Fire pump set (duty, standby and jockey) and fire water storage sized for the largest fire-fighting demand and duration.',
 'Fire authority approval of pump room and tank design', 'Fire pump acceptance test certificate',
 'Pump acceptance test at churn, rated and 150% flow; controller and changeover test.',
 'Pump curves, tank sizing, pump room layout, controller data', 'Design approval -> installation -> acceptance test witnessed by the authority',
 'NFPA 20 or EN 12845', 'low', 'baseline'),
('International', null, 'power_distribution', 'Local electricity authority / utility and electrical inspectorate (confirm)',
 'Low-voltage installation designed, installed and certified to the adopted wiring rules, with the utility connection approved before energisation.',
 'Utility connection approval and electrical inspection before energisation', 'Electrical installation certificate',
 'Insulation resistance, continuity, earth fault loop impedance and RCD tests.',
 'Single line diagram, load schedule, cable sizing and voltage drop calculations', 'Load approval -> installation -> testing -> inspection -> energisation',
 'IEC 60364 (or the national wiring rules based on it)', 'low', 'baseline'),
('International', null, 'db_panels', 'Local electricity authority / electrical inspectorate (confirm)',
 'Switchboards and distribution boards type-tested to the low-voltage assembly standard, with protective devices coordinated to the load schedule.',
 'Panel shop drawings approved by the consultant / authority where required', 'Factory test certificates for each assembly',
 'Factory routine tests, then site insulation resistance and functional tests.',
 'Panel schedules, shop drawings, type-test certificates', 'Shop drawing approval -> factory test -> site installation -> testing',
 'IEC 61439', 'low', 'baseline'),
('International', null, 'earthing', 'Local electricity authority / electrical inspectorate (confirm)',
 'Earthing system and protective bonding to the adopted wiring rules, with earth resistance within the utility''s limit.',
 'Electrical inspection', 'Earth resistance test certificate',
 'Earth electrode resistance and bonding continuity tests.',
 'Earthing layout and test results', 'Installation -> testing -> inspection',
 'IEC 60364-5-54 / IEEE 80', 'low', 'baseline'),
('International', null, 'lightning_protection', 'Local building / electrical authority (confirm)',
 'Lightning protection where the risk assessment requires it, with air terminals, down conductors and earth termination to the adopted standard.',
 'Building authority approval where required', 'Lightning protection test certificate',
 'Continuity and earth resistance tests of the lightning protection system.',
 'Risk assessment, LPS layout, test results', 'Risk assessment -> design -> installation -> testing',
 'IEC 62305 or NFPA 780', 'low', 'baseline'),
('International', null, 'cctv', 'Local police / security regulator where one exists (confirm)',
 'CCTV coverage, recording and retention to the client brief; some countries and occupancies have a security regulator that sets mandatory coverage and retention.',
 'Security regulator approval only where the country or occupancy mandates it', null,
 'Coverage, image quality and recording verification.',
 'Camera layout, storage calculation, retention period', 'Design -> installation -> commissioning; regulator inspection where mandated',
 'IEC 62676', 'low', 'baseline'),
('International', null, 'access_control', 'Local fire authority (for door release) / security regulator where one exists (confirm)',
 'Access-controlled doors on escape routes must fail safe and release on fire alarm.',
 'Fire authority acceptance of fire alarm interface', null,
 'Fire alarm release test on every controlled escape door.',
 'Door schedule, interface details', 'Design -> installation -> interface testing with fire alarm',
 'IEC 60839 / EN 60839-11', 'low', 'baseline'),
('International', null, 'structured_cabling', 'No statutory authority in most countries; telecom regulator for the service entry (confirm)',
 'Structured cabling to the specified category and standard, with the telecom service entry and building riser to the national telecom regulator''s or provider''s guideline.',
 'Telecom provider / regulator approval of the service entry where required', 'Manufacturer warranty certificate',
 'Permanent link testing of every outlet; fibre OTDR / loss testing.',
 'Cabling layout, containment, test results', 'Design -> installation -> testing -> warranty registration',
 'ISO/IEC 11801, TIA-568 or EN 50173', 'low', 'baseline'),
('International', null, 'wifi', 'National telecom / spectrum regulator for equipment type approval (confirm)',
 'Wireless access points type-approved for use in the country, laid out from a coverage survey.',
 'Equipment type approval by the national telecom regulator', null,
 'Post-installation coverage survey.',
 'Predictive or site survey, access point layout', 'Survey -> design -> installation -> validation survey',
 'IEEE 802.11', 'low', 'baseline'),
('International', null, 'audio_visual', 'Local fire authority where AV is used for voice alarm (confirm)',
 'AV and public address to the client brief; any system used for emergency voice messages must meet the voice alarm standard and interface with the fire alarm.',
 'Fire authority approval where it serves as a voice alarm', null,
 'Speech intelligibility test where used for voice alarm.',
 'System schematic, speaker layout', 'Design -> installation -> commissioning',
 'IEC 60849 / EN 54-16 / NFPA 72 Chapter 24 (voice alarm)', 'low', 'baseline'),
('International', null, 'hvac', 'Local building / civil defence authority (confirm)',
 'HVAC sized to the load calculation, with smoke control, fire dampers and fire alarm shutdown to the adopted fire code, and energy performance to the adopted energy code.',
 'Building authority approval; fire authority approval of smoke control', 'Testing, adjusting and balancing report',
 'Air and water balancing, smoke control and damper tests.',
 'Load calculations, duct and pipe layouts, equipment schedules', 'Design approval -> installation -> TAB -> smoke control test',
 'ASHRAE 62.1 / 90.1, NFPA 90A / 92', 'low', 'baseline'),
('International', null, 'ventilation', 'Local building authority (confirm)',
 'Mechanical ventilation rates per occupancy, toilet and kitchen extract, and car park ventilation to the adopted code.',
 'Building authority approval', 'Ventilation commissioning report',
 'Airflow measurement at each terminal.',
 'Ventilation calculations and layouts', 'Design approval -> installation -> commissioning',
 'ASHRAE 62.1 or EN 16798', 'low', 'baseline'),
('International', null, 'water_supply', 'Local water authority / utility (confirm)',
 'Domestic water supply, storage and distribution sized to demand, with backflow prevention and the utility connection approved.',
 'Water utility connection approval', 'Pressure test and disinfection certificate',
 'Hydrostatic pressure test, flushing, disinfection and water quality test.',
 'Water demand calculation, layout, tank sizing', 'Connection application -> installation -> testing -> utility inspection',
 'International Plumbing Code or EN 806', 'low', 'baseline'),
('International', null, 'drainage', 'Local municipality / sewerage authority (confirm)',
 'Soil, waste and storm drainage sized to the adopted plumbing code, with the public sewer connection approved.',
 'Municipality / sewerage authority connection approval', 'Drainage test certificate',
 'Water or air test of drainage pipework and CCTV survey of buried drains where required.',
 'Drainage layout and calculations', 'Connection application -> installation -> testing -> authority inspection',
 'International Plumbing Code or EN 12056', 'low', 'baseline');

-- 2. Fill gaps from the baseline ---------------------------------------------
create or replace function public.get_compliance_rules(p_country text, p_city text)
 returns table(id uuid, country text, city text, system_category text, authority text, requirement text,
               required_approval text, required_certificate text, testing_requirement text, required_documents text,
               approval_process text, reference_code text, confidence text, match_level text)
 language plpgsql stable set search_path to 'public'
as $function$
declare
  v_country text;
  v_city    text;
begin
  select r.country, r.city into v_country, v_city from resolve_location(p_country, p_city) r;

  -- No country at all: nothing to say. A country we hold no rules for still gets the baseline.
  if v_country is null and nullif(btrim(coalesce(p_country, '')), '') is null then
    return;
  end if;

  return query
  with city_rules as (
    select cr.* from compliance_rules cr
    where v_country is not null and lower(cr.country) = lower(v_country)
      and v_city is not null and cr.city is not null and lower(cr.city) = lower(v_city)
  ),
  country_rules as (
    select cr.* from compliance_rules cr
    where v_country is not null and lower(cr.country) = lower(v_country)
      and cr.city is null
      and cr.system_category not in (select c.system_category from city_rules c)
  ),
  baseline as (
    select cr.* from compliance_rules cr
    where cr.country = 'International' and cr.city is null
      and coalesce(lower(v_country), '') <> 'international'
      and cr.system_category not in (select c.system_category from city_rules c)
      and cr.system_category not in (select n.system_category from country_rules n)
  )
  select x.id, x.country, x.city, x.system_category, x.authority, x.requirement,
         x.required_approval, x.required_certificate, x.testing_requirement,
         x.required_documents, x.approval_process, x.reference_code, x.confidence, x.match_level
  from (
    select c.*, 'city'::text as match_level from city_rules c
    union all
    select n.*, 'country'::text from country_rules n
    union all
    select b.*, 'international'::text from baseline b
  ) x
  order by x.system_category, x.match_level;
end $function$;
