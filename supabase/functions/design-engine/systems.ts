// ===========================================================================
// Per-system design rules. Keys are boq_items.system_category values exactly,
// so every line this produces lands in the BOQ the customer already has.
// ===========================================================================
import type { FloorSpec, BuildingSpec, Line } from "./rules.ts";
import { ceil, round1, COOLING_W_M2, LPD_W_M2, ACH, M2_PER_PERSON,
         M2_PER_LUMINAIRE, LUMINAIRE_W } from "./rules.ts";

export interface SystemDef {
  key: string;            // system_category
  label: string;
  colour: string;
  family: "ELV" | "Mechanical" | "Electrical" | "Plumbing" | "Fire";
  build: (b: BuildingSpec, f: FloorSpec) => Line[];      // per floor
  buildingWide?: (b: BuildingSpec, floorLines: Line[]) => Line[];
}

const L = (f: FloorSpec, system: string, device: string, label: string, qty: number,
           unit: string, basis: string, mountingMm: number | null = null,
           source: "client" | "code" = "code"): Line =>
  ({ floor: f.name, level: f.level, system, device, label, qty, unit, mountingMm, source, basis });

const area = (f: FloorSpec, ...types: string[]) =>
  types.reduce((s, t) => s + (f.spaces[t] || 0), 0);

const totalArea = (f: FloorSpec) => Object.values(f.spaces).reduce((s, v) => s + v, 0);

/** Cooling load for one floor, in kW. Used by HVAC and chilled water alike. */
export function coolingKw(f: FloorSpec): number {
  let w = 0;
  for (const [sp, a] of Object.entries(f.spaces)) w += a * (COOLING_W_M2[sp] ?? 100);
  return w / 1000;
}

/** Client override, if the client stated a number for this device. */
function override(f: FloorSpec, key: string): number | null {
  const v = f.overrides?.[key];
  return (v === undefined || v === null) ? null : Number(v);
}

function withOverride(f: FloorSpec, system: string, device: string, label: string,
                      computed: number, unit: string, basis: string,
                      mountingMm: number | null = null): Line | null {
  const ov = override(f, device);
  if (ov !== null) {
    return L(f, system, device, label, ov, unit,
      `Client instruction: ${ov} ${unit} on ${f.name}. The code minimum of ${computed} was not applied, because a stated client requirement governs the design.`,
      mountingMm, "client");
  }
  return computed > 0 ? L(f, system, device, label, computed, unit, basis, mountingMm) : null;
}

const push = (out: Line[], l: Line | null) => { if (l) out.push(l); };

// ===========================================================================
// ELV
// ===========================================================================
export const CCTV: SystemDef = {
  key: "cctv", label: "CCTV", colour: "#1d6fe0", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const openArea = area(f, "office", "retail", "lobby", "warehouse", "kitchen");
    push(out, withOverride(f, "cctv", "dome_camera",
      "Dome camera, 4MP, IR 30 m, PoE, IP66 vandal-resistant", ceil(openArea / 150), "no",
      `${Math.round(openArea)} m² of occupied area at one camera per 150 m². Detection-grade coverage of open areas; identification grade is applied at entrances separately.`, 2800));

    const corrLen = area(f, "corridor") / 2;         // ~2 m wide corridor
    push(out, withOverride(f, "cctv", "corridor_camera",
      "Dome camera, corridor view, 4MP, IR, PoE", ceil(corrLen / 22), "no",
      `About ${Math.round(corrLen)} m of corridor at one camera per 22 m, giving overlapping identification-grade cover to each end.`, 2800));

    push(out, withOverride(f, "cctv", "carpark_camera",
      "Bullet camera, 4MP, IR, PoE, IP66, car park", ceil(area(f, "car_park") / 400), "no",
      `${Math.round(area(f, "car_park"))} m² of parking deck at one camera per 400 m², positioned down the aisles.`, 3000));

    if (f.lifts) push(out, withOverride(f, "cctv", "lift_car_camera",
      "Lift car camera, vandal dome, 4MP", f.lifts, "no",
      `${f.lifts} lift car(s), one camera each — mandatory at every regulated authority.`, 2200));
    return out;
  },
  buildingWide: (b, lines) => {
    const out: Line[] = [];
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const cams = lines.filter(l => l.system === "cctv").reduce((s, l) => s + l.qty, 0);
    const ent = (b.mainEntrances ?? 1) * 2;
    out.push(L(f0, "cctv", "entrance_camera", "Dome camera, identification grade, main entrance",
      ent, "no", `2 cameras per entrance x ${b.mainEntrances ?? 1} entrance(s), set to identification grade at the door line.`, 2400));
    if (b.carParkLanes) out.push(L(f0, "anpr", "anpr_camera", "ANPR camera, vehicle entry/exit",
      b.carParkLanes * 2, "no", `${b.carParkLanes} vehicle lane(s), one camera at entry and one at exit.`, 1400));
    const total = cams + ent;
    out.push(L(f0, "cctv", "nvr", "Network video recorder, 31-day retention, RAID",
      Math.max(1, ceil(total / 64)), "no",
      `${total} cameras at 64 channels per recorder. 31-day retention is the authority minimum and sets the storage, not the channel count.`));
    out.push(L(f0, "cctv", "monitor", "Control room monitor, 32 inch", 2, "no", "Two monitors at the security desk."));
    return out;
  },
};

export const ACCESS: SystemDef = {
  key: "access_control", label: "Access Control", colour: "#d63b3b", family: "ELV",
  build: (b, f) => {
    const doors = override(f, "doors") ?? f.doors ?? 0;
    if (!doors) return [];
    const src: "client" | "code" = override(f, "doors") !== null ? "client" : "code";
    const note = src === "client" ? `Client stated ${doors} controlled doors on ${f.name}. ` : `${doors} controlled doors on this floor. `;
    const set = [
      ["reader", "Card reader, MIFARE DESFire, unsecured side", 1200, "Reader on the unsecured side at 1200 mm AFF."],
      ["rex", "Request-to-exit push button, secured side", 1200, "Egress device on the secured side at 1200 mm AFF."],
      ["maglock", "Electromagnetic lock, 600 lbf, with L/Z bracket", null, "At the head of the door leaf, fail-safe so it releases on fire alarm."],
      ["door_contact", "Door position switch, flush mounted", null, "Monitors door state for forced-entry and held-open alarms."],
      ["ebg", "Emergency break-glass unit, resettable", 1200, "Mandatory on every maglocked door on an escape route."],
    ] as [string, string, number | null, string][];
    const out: Line[] = set.map(([k, lab, mm, why]) =>
      L(f, "access_control", k, lab, doors, "no", note + why, mm, src));
    out.push(L(f, "access_control", "controller", "Door controller panel, 4 door, with PSU and battery",
      ceil(doors / 4), "no", `${doors} doors at one 4-door controller per group of four, mounted in the floor IDF.`));
    return out;
  },
};

export const FIRE_ALARM: SystemDef = {
  key: "fire_alarm", label: "Fire Alarm", colour: "#e07a1d", family: "Fire",
  build: (b, f) => {
    const out: Line[] = [];
    const smokeArea = area(f, "office", "corridor", "lobby", "apartment", "retail", "warehouse", "stair");
    push(out, withOverride(f, "fire_alarm", "smoke_detector",
      "Addressable optical smoke detector with base", ceil(smokeArea / 80), "no",
      `${Math.round(smokeArea)} m² at one detector per 80 m². NFPA 72 allows 9.1 m maximum spacing on a smooth flat ceiling; 80 m² is that spacing squared, de-rated.`, null));
    const heatArea = area(f, "kitchen", "car_park", "plant_room");
    push(out, withOverride(f, "fire_alarm", "heat_detector",
      "Addressable heat detector with base", ceil(heatArea / 40), "no",
      `${Math.round(heatArea)} m² of kitchen, parking and plant at one per 40 m². Heat rather than smoke where cooking fumes or vehicle exhaust would cause false alarms.`, null));
    push(out, withOverride(f, "fire_alarm", "manual_call_point",
      "Addressable manual call point, resettable", 2, "no",
      "One at each exit and stair door; 30 m maximum travel distance to the nearest call point.", 1400));
    push(out, withOverride(f, "fire_alarm", "sounder_beacon",
      "Addressable sounder-beacon, wall mounted", ceil(totalArea(f) / 150), "no",
      `${Math.round(totalArea(f))} m² at one per 150 m², to hold 65 dB(A) at every point or 5 dB above ambient.`, 2250));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const dev = lines.filter(l => l.system === "fire_alarm").reduce((s, l) => s + l.qty, 0);
    return [
      L(f0, "fire_alarm", "panel", "Addressable fire alarm control panel, with batteries",
        Math.max(1, ceil(dev / 250)), "no",
        `${dev} addressable devices. One loop carries 125 devices; the panel is sized at two loops per 250 devices.`),
      L(f0, "fire_alarm", "repeater", "Repeater panel at the fire-fighting access point", 1, "no",
        "Repeater at the fire-fighting access point so the attending officer sees the panel without entering the building."),
    ];
  },
};

export const SPRINKLER: SystemDef = {
  key: "sprinkler", label: "Sprinkler", colour: "#1a9e6a", family: "Fire",
  build: (b, f) => {
    const out: Line[] = [];
    const light = area(f, "office", "corridor", "lobby", "apartment");
    const ordinary = area(f, "retail", "kitchen", "car_park", "plant_room", "warehouse");
    push(out, withOverride(f, "sprinkler", "pendent_head",
      "Pendent sprinkler head, 68 °C, quick response, chrome", ceil(light / 20.9), "no",
      `${Math.round(light)} m² of light hazard at 20.9 m² maximum coverage per head and 4.6 m maximum spacing (NFPA 13).`));
    push(out, withOverride(f, "sprinkler", "upright_head",
      "Upright sprinkler head, 68 °C, brass", ceil(ordinary / 12.1), "no",
      `${Math.round(ordinary)} m² of ordinary hazard group 2 at 12.1 m² per head (NFPA 13).`));
    push(out, withOverride(f, "sprinkler", "flow_switch",
      "Flow switch with isolation valve, test and drain", 1, "no",
      "One flow switch per floor zone, with an isolating valve and a test drain at the riser."));
    const heads = out.filter(l => l.device.includes("head")).reduce((s, l) => s + l.qty, 0);
    if (heads) out.push(L(f, "sprinkler", "branch_pipe",
      "Sprinkler branch pipework, 25–50 mm, black steel, grooved",
      Math.round(heads * 3.2), "m",
      `${heads} heads at 3.2 m of branch pipe each — the distance between heads at 4.6 m centres, halved for a two-sided range pipe, plus drops.`));
    return out;
  },
};

export const FIRE_FIGHTING: SystemDef = {
  key: "fire_fighting", label: "Fire Fighting", colour: "#b3281f", family: "Fire",
  build: (b, f) => {
    const out: Line[] = [];
    const a = totalArea(f);
    push(out, withOverride(f, "fire_fighting", "hose_reel",
      "Fire hose reel, 30 m x 19 mm, with cabinet", ceil(a / 800), "no",
      `${Math.round(a)} m² at one hose reel per 800 m², so that no point is more than 30 m from a reel.`, 1200));
    push(out, withOverride(f, "fire_fighting", "extinguisher",
      "Portable extinguisher, 6 kg dry powder / CO₂, with bracket", ceil(a / 200), "no",
      `${Math.round(a)} m² at one extinguisher per 200 m², to a 20 m maximum travel distance.`, 1000));
    push(out, withOverride(f, "fire_fighting", "landing_valve",
      "Wet riser landing valve, 65 mm, with cabinet", 1, "no",
      "One landing valve per floor in the fire-fighting stair.", 750));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const levels = b.floors.length;
    return [
      L(f0, "fire_pump", "fire_pump_set", "Fire pump set — electric duty, diesel standby, jockey pump",
        1, "set", "One pump set per riser system, sized on the hydraulically most demanding area and the highest landing valve."),
      L(f0, "fire_fighting", "wet_riser", "Wet riser, 150 mm dia, black steel, with air release",
        Math.round(levels * ((b.floorToFloorMm ?? 3600) / 1000) * 1.15), "m",
        `${levels} levels at ${(b.floorToFloorMm ?? 3600) / 1000} m floor to floor, plus 15% for offsets, the pump room run and the roof air release.`),
      L(f0, "fire_fighting", "breeching", "Two-way breeching inlet with cabinet", 1, "no",
        "At the fire-fighting access point, within the hard-standing the civil defence vehicle uses."),
    ];
  },
};

// ===========================================================================
// MECHANICAL
// ===========================================================================
const TR_KW = 3.517;                  // 1 ton of refrigeration
const FCU_KW = 7.03;                  // a 2 TR fan coil, the common unit
const CLEAR_HEIGHT_M = 3.0;

export const HVAC: SystemDef = {
  key: "hvac", label: "HVAC", colour: "#0ea5a5", family: "Mechanical",
  build: (b, f) => {
    const out: Line[] = [];
    const kw = coolingKw(f);
    const conditioned = area(f, "office", "apartment", "retail", "lobby", "corridor", "kitchen", "warehouse");

    if (kw > 0) {
      push(out, withOverride(f, "fcu", "fcu",
        "Fan coil unit, ceiling concealed, 2 TR, with filter and drain pan", ceil(kw / FCU_KW), "no",
        `Floor cooling load ${round1(kw)} kW (${round1(kw / TR_KW)} TR) from the space densities above, divided by a 2 TR unit. Load is the sum of each space type at its own W/m².`));
      push(out, withOverride(f, "ducting", "supply_diffuser",
        "Supply air diffuser, 4-way, aluminium, with damper", ceil(conditioned / 25), "no",
        `${Math.round(conditioned)} m² conditioned at one diffuser per 25 m², which keeps throw and face velocity within range for a 2.8 m ceiling.`));
      push(out, withOverride(f, "ducting", "return_grille",
        "Return air grille with filter, aluminium", ceil(conditioned / 45), "no",
        `${Math.round(conditioned)} m² at one return grille per 45 m², sized on a return face velocity of about 2 m/s.`));
      push(out, withOverride(f, "ducting", "duct",
        "Ductwork, GI sheet to DW/144, insulated, including supports",
        Math.round(conditioned * 0.22), "m²",
        `An allowance of 0.22 m² of duct surface per m² of conditioned floor area, covering supply, return and fresh air at typical GCC apartment and office layouts. This is an allowance, not a measured take-off — it changes once a real ceiling layout exists.`));
    }

    // Fresh air
    let people = 0;
    for (const [sp, a] of Object.entries(f.spaces)) {
      const d = M2_PER_PERSON[sp];
      if (d) people += a / d;
    }
    if (people > 0) {
      const ls = people * 10;                    // ASHRAE 62.1, 10 L/s per person
      push(out, withOverride(f, "ahu", "fahu_share",
        `Fresh air handling unit share, ${Math.round(ls)} L/s, with cooling coil and filter`, 1, "no",
        `${Math.round(people)} occupants at 10 L/s each gives ${Math.round(ls)} L/s of outside air (ASHRAE 62.1). Occupancy derived from the space mix at standard densities.`));
    }

    // Ventilation where the space is not cooled
    for (const [sp, ach] of Object.entries(ACH)) {
      const a = f.spaces[sp] || 0;
      if (a <= 0) continue;
      const m3h = a * CLEAR_HEIGHT_M * ach;
      const label = sp === "car_park"
        ? `Car park extract fan, ${Math.round(m3h)} m³/h, 2 h at 250 °C rated`
        : `Extract fan, ${Math.round(m3h)} m³/h, inline`;
      push(out, withOverride(f, "ventilation", `extract_${sp}`, label, 1, "no",
        `${Math.round(a)} m² of ${sp.replace("_", " ")} at ${CLEAR_HEIGHT_M} m clear height and ${ach} air changes per hour gives ${Math.round(m3h)} m³/h. Car park extract is rated for 2 hours at 250 °C as a smoke-clearance duty.`));
    }
    return out;
  },
};

export const CHILLED_WATER: SystemDef = {
  key: "chillers", label: "Chilled Water", colour: "#2563eb", family: "Mechanical",
  build: (b, f) => {
    const out: Line[] = [];
    const kw = coolingKw(f);
    if (kw <= 0) return out;
    const fcus = ceil(kw / FCU_KW);
    push(out, withOverride(f, "chillers", "control_valve",
      "Two-way motorised control valve, with actuator", fcus, "no",
      `One control valve per fan coil (${fcus} on this floor), for variable primary flow.`));
    push(out, withOverride(f, "chillers", "balancing_valve",
      "Double-regulating balancing valve with test points", fcus, "no",
      `One balancing valve per fan coil, so each unit can be commissioned to its design flow.`));
    const branch = Math.round(Math.sqrt(Math.max(totalArea(f), 1)) * 1.8);
    push(out, withOverride(f, "chillers", "chw_branch",
      "Chilled water branch pipework, 25–80 mm, black steel, welded", branch, "m",
      `Branch run taken as 1.8 x the square root of the floor plate (${Math.round(totalArea(f))} m²) — the standard first-pass allowance for a floor served from one riser. Becomes a measured run once geometry exists.`));
    push(out, withOverride(f, "chillers", "chw_insulation",
      "Chilled water pipe insulation, closed cell, with vapour barrier", branch, "m",
      "Insulation measured on the same length as the branch pipework, with a vapour barrier — mandatory in GCC humidity or the pipe sweats."));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const totalKw = b.floors.reduce((s, f) => s + coolingKw(f), 0);
    const diversified = totalKw * 0.85;
    const tr = diversified / TR_KW;
    const nChillers = Math.max(2, ceil(tr / 150));
    const out: Line[] = [];
    if (tr <= 0) return out;
    out.push(L(f0, "chillers", "chiller",
      `Air-cooled screw chiller, ${Math.round(tr / nChillers)} TR, R-134a`, nChillers, "no",
      `Building load ${round1(totalKw)} kW with 0.85 diversity gives ${round1(diversified)} kW (${Math.round(tr)} TR). Split across ${nChillers} machines so one can be taken off line without losing the building — never a single chiller.`));
    out.push(L(f0, "pumps", "chw_primary_pump",
      "Chilled water primary pump, end suction, with VFD", nChillers + 1, "no",
      `One primary pump per chiller plus one standby (${nChillers} + 1).`));
    out.push(L(f0, "pumps", "chw_secondary_pump",
      "Chilled water secondary pump, end suction, with VFD", 3, "no",
      "Two duty and one standby on the secondary circuit, staged on differential pressure."));
    const riserM = Math.round(b.floors.length * ((b.floorToFloorMm ?? 3600) / 1000) * 2 * 1.15);
    out.push(L(f0, "chillers", "chw_riser",
      "Chilled water riser, 150–250 mm, black steel, welded, insulated", riserM, "m",
      `Flow and return risers over ${b.floors.length} levels at ${(b.floorToFloorMm ?? 3600) / 1000} m floor to floor, plus 15% for plant room offsets and headers.`));
    out.push(L(f0, "chillers", "expansion_tank",
      "Pressurisation unit with expansion vessel", 1, "set",
      "One pressurisation set on the system, sized on total water content and static height."));
    return out;
  },
};

// ===========================================================================
// ELECTRICAL
// ===========================================================================
export const LIGHTING: SystemDef = {
  key: "lighting", label: "Lighting & Control", colour: "#9333ea", family: "Electrical",
  build: (b, f) => {
    const out: Line[] = [];
    // Laid out by area served per fitting, then checked back against the energy
    // code's power cap. Taking the cap itself as the design target — which is
    // what the first version did — gave one fitting per 5 m² and a cable take-off
    // about eight times too long. The cap is a limit, not a target.
    let lum = 0, watts = 0, capWatts = 0;
    for (const [sp, a] of Object.entries(f.spaces)) {
      if (a <= 0) continue;
      const n = ceil(a / (M2_PER_LUMINAIRE[sp] ?? 10));
      lum += n;
      watts += n * (LUMINAIRE_W[sp] ?? 24);
      capWatts += a * (LPD_W_M2[sp] ?? 8);
    }
    const a = totalArea(f);
    const density = a > 0 ? watts / a : 0;
    const capDensity = a > 0 ? capWatts / a : 0;
    const verdict = watts <= capWatts
      ? `Installed density ${round1(density)} W/m² is inside the ${round1(capDensity)} W/m² cap.`
      : `WARNING: installed density ${round1(density)} W/m² exceeds the ${round1(capDensity)} W/m² cap — reduce fitting wattage or spacing at detailed design.`;
    push(out, withOverride(f, "lighting", "luminaire",
      "LED luminaire, recessed, with driver (wattage per space type)", lum, "no",
      `${lum} fittings set out on the area each one serves — office at one per 8 m², apartment one per 10 m², corridor one per 6 m, car park one per 25 m². ${verdict} Lux is verified room by room at detailed design.`));
    push(out, withOverride(f, "lighting", "emergency_luminaire",
      "Emergency LED luminaire, 3 hour maintained, self-test", ceil(a / 100), "no",
      `${Math.round(a)} m² at one per 100 m², maintained for 3 hours on the escape route.`));
    push(out, withOverride(f, "lighting", "exit_sign",
      "Illuminated exit sign, 3 hour maintained, double sided", 2, "no",
      "One at each final exit and stair door on the floor."));
    push(out, withOverride(f, "lighting", "occupancy_sensor",
      "Occupancy and daylight sensor, ceiling, DALI", ceil(a / 60), "no",
      `${Math.round(a)} m² at one sensor per 60 m². Required by the energy code for automatic switch-off, and what makes the lighting control worth having.`, 2800));
    push(out, withOverride(f, "lighting", "lighting_control_panel",
      "DALI lighting control panel, per floor, with scene programming", 1, "no",
      "One addressable lighting control panel per floor, in the electrical riser beside the distribution board."));
    return out;
  },
};

export const SMALL_POWER: SystemDef = {
  key: "power_distribution", label: "Small Power", colour: "#f59e0b", family: "Electrical",
  build: (b, f) => {
    const out: Line[] = [];
    const office = area(f, "office", "retail", "lobby");
    const apt = area(f, "apartment");
    const sockets = ceil(office / 10) + ceil(apt / 20);
    push(out, withOverride(f, "power_distribution", "socket_outlet",
      "Switched socket outlet, 13 A twin, with back box", sockets, "no",
      `${Math.round(office)} m² of office and retail at one twin socket per 10 m², plus ${Math.round(apt)} m² of apartment at one per 20 m².`, 400));
    push(out, withOverride(f, "db_panels", "distribution_board",
      "Distribution board, TPN, with MCBs and RCBOs", 1, "no",
      "One distribution board per floor in the electrical riser, with 25% spare ways."));
    const sub = Math.round(Math.abs(f.level) * ((b.floorToFloorMm ?? 3600) / 1000) + 25);
    push(out, withOverride(f, "cable_sizing", "submain",
      "Sub-main cable, 4 core XLPE/SWA/LSZH, to floor DB", sub, "m",
      `Riser drop from the main board to this floor (${Math.abs(f.level)} levels at ${(b.floorToFloorMm ?? 3600) / 1000} m) plus 25 m of horizontal run in the plant room and riser.`));
    return out;
  },
};

// ===========================================================================
// PLUMBING
// ===========================================================================
export const PLUMBING: SystemDef = {
  key: "water_supply", label: "Plumbing & Drainage", colour: "#0891b2", family: "Plumbing",
  build: (b, f) => {
    const out: Line[] = [];
    let people = 0;
    for (const [sp, a] of Object.entries(f.spaces)) {
      const d = M2_PER_PERSON[sp];
      if (d) people += a / d;
    }
    const toiletArea = area(f, "toilet");
    if (people > 0 && (toiletArea > 0 || area(f, "apartment") > 0)) {
      push(out, withOverride(f, "fixtures", "wc",
        "WC suite, close coupled, with concealed cistern and seat", Math.max(1, ceil(people / 25)), "no",
        `${Math.round(people)} occupants at one WC per 25 people, the usual sanitary provision for the space mix on this floor.`));
      push(out, withOverride(f, "fixtures", "basin",
        "Wash basin, vitreous china, with mixer and trap", Math.max(1, ceil(people / 25)), "no",
        `One basin per WC, matched to the same occupancy.`));
    }
    const a = totalArea(f);
    push(out, withOverride(f, "water_supply", "cpvc_pipe",
      "Domestic water pipework, CPVC, 20–50 mm, with fittings and insulation",
      Math.round(Math.sqrt(Math.max(a, 1)) * 1.4), "m",
      `Branch run taken as 1.4 x the square root of the floor plate (${Math.round(a)} m²), covering cold and hot distribution from the riser to the wet areas.`));
    push(out, withOverride(f, "drainage", "upvc_stack",
      "Soil and waste pipework, uPVC, 50–110 mm, with fittings",
      Math.round(Math.sqrt(Math.max(a, 1)) * 1.1), "m",
      `Waste and soil branch run taken as 1.1 x the square root of the floor plate, falling to the nearest stack.`));
    push(out, withOverride(f, "drainage", "floor_drain",
      "Floor drain with trap and chrome grating", Math.max(1, ceil(toiletArea / 15)), "no",
      `${Math.round(toiletArea)} m² of wet area at one drain per 15 m², plus one minimum per wet room.`));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const levels = b.floors.length;
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    return [
      L(f0, "pumps", "booster_set", "Domestic water booster pump set, duty/standby, with VFD and vessel",
        1, "set", "One booster set sized on the highest fixture and the simultaneous demand of the whole building."),
      L(f0, "water_supply", "riser_pipe", "Domestic water riser, 50–100 mm, with isolating valves",
        Math.round(levels * f2f * 1.15), "m",
        `${levels} levels at ${f2f} m floor to floor plus 15% for the pump room and tank room connections.`),
      L(f0, "drainage", "drain_stack", "Soil and vent stack, 110 mm uPVC, with access",
        Math.round(levels * f2f * 1.15), "m",
        `Stack over ${levels} levels plus 15%, vented above roof level.`),
      L(f0, "water_supply", "water_tank", "GRP water storage tank, sectional, with level control", 1, "set",
        "One day's storage at the building's design demand, in two compartments so one can be cleaned without loss of supply."),
    ];
  },
};

// ===========================================================================
// ELV — the rest of the low-current package
// ===========================================================================
export const STRUCTURED_CABLING: SystemDef = {
  key: "structured_cabling", label: "Structured Cabling", colour: "#0f766e", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const work = area(f, "office", "retail", "lobby");
    const homes = area(f, "apartment");
    const outlets = ceil(work / 10) + ceil(homes / 45);
    push(out, withOverride(f, "structured_cabling", "data_outlet",
      "Data outlet, 2 x RJ45 CAT6A, with faceplate and back box", outlets, "no",
      `${Math.round(work)} m² of office and retail at one twin outlet per 10 m², plus ${Math.round(homes)} m² of residential at one per 45 m². Each outlet is two ports, which is the normal provision for a desk or a living space.`, 400));
    if (outlets > 0) {
      push(out, withOverride(f, "structured_cabling", "patch_panel",
        "Patch panel, 24 port CAT6A, 1U, with cable management", ceil(outlets * 2 / 24), "no",
        `${outlets} twin outlets is ${outlets * 2} ports, at 24 ports per panel.`));
      push(out, withOverride(f, "structured_cabling", "floor_rack",
        "Floor IDF rack, 42U, with PDU, shelf and fans", 1, "no",
        "One IDF per floor. Every system on this floor home-runs to it, which is what keeps the horizontal runs inside the 90 m channel limit."));
    }
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    return [
      L(f0, "structured_cabling", "mdf_rack", "Main distribution frame rack, 42U, with PDU and management", 1, "no",
        "One MDF serving every floor IDF."),
      L(f0, "structured_cabling", "fibre_backbone",
        "Fibre backbone, 12 core OM4, riser rated, terminated both ends",
        Math.round(b.floors.length * f2f * 1.25 * 2), "m",
        `A pair of diverse fibre routes from the MDF to each floor IDF over ${b.floors.length} levels at ${f2f} m, plus 25% for the riser offsets and the patching at both ends.`),
      L(f0, "structured_cabling", "core_switch", "Core switch, 10G uplinks, redundant PSU", 2, "no",
        "Two core switches, so a single failure does not take the building's network down."),
    ];
  },
};

export const WIFI: SystemDef = {
  key: "wifi", label: "Wi-Fi", colour: "#15803d", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const occupied = area(f, "office", "retail", "lobby", "apartment", "corridor", "kitchen", "warehouse");
    push(out, withOverride(f, "wifi", "access_point",
      "Wireless access point, Wi-Fi 6, PoE, ceiling mounted", ceil(occupied / 200), "no",
      `${Math.round(occupied)} m² of occupied area at one access point per 200 m², which holds a usable cell size on a 2.8 m ceiling without the cells fighting each other.`, 2800));
    push(out, withOverride(f, "wifi", "carpark_access_point",
      "Wireless access point, outdoor/IP54, PoE, car park", ceil(area(f, "car_park") / 800), "no",
      `${Math.round(area(f, "car_park"))} m² of parking at one access point per 800 m² — coverage for staff devices and plant, not a working density.`, 3000));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const aps = lines.filter(l => l.unit === "no").reduce((s, l) => s + l.qty, 0);
    if (!aps) return [];
    return [
      L(f0, "wifi", "wlan_controller", "Wireless LAN controller, licensed for the access point count", 1, "no",
        `${aps} access points on one controller, licensed to that count.`),
    ];
  },
};

export const INTERCOM: SystemDef = {
  key: "intercom", label: "Intercom", colour: "#7c3aed", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const units = ceil(area(f, "apartment") / 90);
    push(out, withOverride(f, "intercom", "room_station",
      "Intercom room station, 7 inch colour video, hands free", units, "no",
      `${Math.round(area(f, "apartment"))} m² of residential at a 90 m² average unit, giving ${units} units, one station each.`, 1400));
    push(out, withOverride(f, "intercom", "lobby_station",
      "Intercom lift-lobby station, video, vandal resistant", f.lifts ? 1 : 0, "no",
      "One station at the lift lobby on each floor, so a visitor can be seen and released from the floor as well as the entrance.", 1400));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    return [
      L(f0, "intercom", "door_station", "Intercom entrance door station, video, with directory",
        Math.max(1, b.mainEntrances ?? 1), "no",
        `One door station at each of ${b.mainEntrances ?? 1} main entrance(s).`, 1400),
      L(f0, "intercom", "exchange", "Intercom exchange / server, with PSU and battery", 1, "no",
        "One exchange serving every station, in the head end room."),
    ];
  },
};

export const IPTV: SystemDef = {
  key: "iptv", label: "IPTV / MATV", colour: "#be185d", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const tvHomes = ceil(area(f, "apartment") / 45);
    const tvPublic = ceil(area(f, "lobby", "retail") / 150);
    push(out, withOverride(f, "iptv", "tv_outlet",
      "TV outlet, F-type / RJ45, with faceplate and back box", tvHomes + tvPublic, "no",
      `${Math.round(area(f, "apartment"))} m² of residential at one outlet per 45 m² (living room and bedrooms), plus ${Math.round(area(f, "lobby", "retail"))} m² of lobby and retail at one per 150 m².`, 400));
    if (tvHomes + tvPublic > 0) push(out, withOverride(f, "iptv", "floor_multiswitch",
      "Floor multiswitch / IPTV distribution amplifier", 1, "no",
      "One distribution point per floor in the IDF, so a fault on one floor does not pull the signal down on the others."));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const outlets = lines.filter(l => l.device === "tv_outlet").reduce((s, l) => s + l.qty, 0);
    if (!outlets) return [];
    return [
      L(f0, "iptv", "headend", "IPTV / MATV head end — receivers, modulators, combiner, rack", 1, "set",
        `Head end feeding ${outlets} outlets, with terrestrial and satellite inputs.`),
      L(f0, "iptv", "dish_antenna", "Satellite dish and terrestrial antenna, with mast and mounts", 1, "set",
        "Roof-mounted, on a mast clear of the lightning protection air terminals."),
    ];
  },
};

export const PUBLIC_ADDRESS: SystemDef = {
  key: "public_address", label: "Public Address", colour: "#ca8a04", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const indoor = area(f, "office", "retail", "lobby", "corridor", "apartment", "kitchen", "stair");
    push(out, withOverride(f, "public_address", "ceiling_speaker",
      "Ceiling speaker, 6 W, 100 V line, with fire dome", ceil(indoor / 60), "no",
      `${Math.round(indoor)} m² at one speaker per 60 m², which holds intelligible speech at 10 dB above ambient without needing the volume turned up to where it distorts.`));
    push(out, withOverride(f, "public_address", "horn_speaker",
      "Horn speaker, 15 W, 100 V line, IP66", ceil(area(f, "car_park", "warehouse", "plant_room") / 250), "no",
      `${Math.round(area(f, "car_park", "warehouse", "plant_room"))} m² of parking, warehouse and plant at one horn per 250 m² — a horn rather than a ceiling speaker because of the reverberation and the height.`, 3000));
    push(out, withOverride(f, "public_address", "volume_control",
      "Zone volume control with emergency override", 1, "no",
      "One per floor zone, with a 24 V override so an emergency message is heard at full level whatever the local setting."));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const ceil6 = lines.filter(l => l.device === "ceiling_speaker").reduce((s, l) => s + l.qty, 0);
    const horn = lines.filter(l => l.device === "horn_speaker").reduce((s, l) => s + l.qty, 0);
    const watts = ceil6 * 6 + horn * 15;
    if (!watts) return [];
    const amps = Math.max(1, ceil((watts * 1.3) / 500));
    return [
      L(f0, "public_address", "amplifier", "Power amplifier, 500 W, 100 V line, with fault monitoring", amps, "no",
        `${ceil6} ceiling speakers at 6 W and ${horn} horns at 15 W is ${watts} W, plus 30% headroom, at 500 W per amplifier.`),
      L(f0, "public_address", "pa_rack", "PA / voice alarm rack — controller, battery charger, batteries, microphone", 1, "set",
        "One rack with 24 hours standby and 30 minutes alarm load, which is what a voice alarm has to prove at handover."),
    ];
  },
};

export const AUDIO_VISUAL: SystemDef = {
  key: "audio_visual", label: "Audio Visual", colour: "#4338ca", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const rooms = ceil(area(f, "office") / 400);
    if (!rooms) return out;
    push(out, withOverride(f, "audio_visual", "display",
      "Display, 75 inch 4K, with wall mount", rooms, "no",
      `${Math.round(area(f, "office"))} m² of office at one meeting room per 400 m², one display each.`, 1100));
    push(out, withOverride(f, "audio_visual", "soundbar",
      "Video conference soundbar with camera and microphone array", rooms, "no",
      "One per meeting room, which replaces a separate camera, microphone and speaker set."));
    push(out, withOverride(f, "audio_visual", "table_plate",
      "Table connection plate — HDMI, USB-C, power", rooms, "no",
      "One plate per room, so the room works without an adaptor being hunted for."));
    return out;
  },
};

export const PARKING: SystemDef = {
  key: "parking_management", label: "Parking Management", colour: "#0369a1", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const park = area(f, "car_park");
    if (park <= 0) return out;
    const bays = ceil(park / 28);
    push(out, withOverride(f, "parking_management", "bay_sensor",
      "Ultrasonic bay sensor with integral LED indicator", bays, "no",
      `${Math.round(park)} m² of deck at 28 m² per bay including the aisle, giving ${bays} bays, one sensor each.`, 2400));
    push(out, withOverride(f, "parking_management", "zone_controller",
      "Parking zone controller, for up to 50 sensors", ceil(bays / 50), "no",
      `${bays} bays at 50 sensors per controller.`));
    push(out, withOverride(f, "parking_management", "guidance_sign",
      "LED guidance sign, directional, with bay count", ceil(park / 500), "no",
      `One sign per 500 m² of deck, at each decision point on the drive route.`, 2200));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    if (!lines.length) return [];
    return [
      L(f0, "parking_management", "parking_server", "Parking management server and workstation", 1, "set",
        "One server with the occupancy and revenue reporting, at the security desk. The entry and exit barriers are a separate package — see Gate Barrier & Vehicle Access — so they are not counted twice."),
    ];
  },
};

export const BMS: SystemDef = {
  key: "bms", label: "Building Management System", colour: "#047857", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const kw = coolingKw(f);
    const conditioned = area(f, "office", "apartment", "retail", "lobby", "corridor", "kitchen", "warehouse");
    const a = totalArea(f);
    if (a <= 0) return out;
    push(out, withOverride(f, "bms", "room_sensor",
      "Room temperature and humidity sensor, network addressable", ceil(conditioned / 120), "no",
      `${Math.round(conditioned)} m² of conditioned area at one sensor per 120 m² — one per control zone, not one per room.`, 1500));
    const fcus = ceil(kw / FCU_KW);
    push(out, withOverride(f, "bms", "fcu_controller",
      "Fan coil controller, network addressable, with valve and fan outputs", fcus, "no",
      `One controller per fan coil (${fcus} on this floor). This is what makes the chilled water valve and the fan speed answer to the BMS rather than a local thermostat.`));
    // Points drive the controller count, and points are what a BMS is actually
    // priced on. Counting them out loud is what lets a tender be checked.
    const points = ceil(conditioned / 120) * 2 + fcus * 4 + 12;
    push(out, withOverride(f, "bms", "ddc_panel",
      "DDC controller panel, with PSU, battery and terminations", Math.max(1, ceil(points / 120)), "no",
      `${points} monitored and controlled points on this floor — two per room sensor, four per fan coil, and twelve for the floor's fans, dampers and status — at 120 points per panel.`));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const panels = lines.filter(l => l.device === "ddc_panel").reduce((s, l) => s + l.qty, 0);
    if (!panels) return [];
    return [
      L(f0, "bms", "bms_server", "BMS head end — server, workstation, graphics and licences", 1, "set",
        `One head end supervising ${panels} field panels, with the graphics built from the real plant schematics.`),
      L(f0, "bms", "bms_network",
        "BMS field network cable, 2 core shielded, with terminations",
        Math.round(b.floors.length * ((b.floorToFloorMm ?? 3600) / 1000) * 1.3 + panels * 35), "m",
        `The riser trunk over ${b.floors.length} levels plus 30%, and 35 m from each of the ${panels} panels out to its field devices. An allowance from the envelope, not a measured run.`),
      L(f0, "bms", "integration", "Third-party integration — chillers, generators, fire alarm, meters", 1, "set",
        "One integration package. Every GCC authority expects the fire alarm status and the chiller plant to be visible on the BMS head end."),
    ];
  },
};

export const GRMS: SystemDef = {
  key: "grms", label: "Guest Room Management", colour: "#9d174d", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const rooms = ceil(area(f, "apartment") / 35);
    if (!rooms) return out;
    push(out, withOverride(f, "grms", "room_controller",
      "Guest room controller, with lighting, HVAC and curtain outputs", rooms, "no",
      `${Math.round(area(f, "apartment"))} m² of guest room area at a 35 m² key, giving ${rooms} rooms, one controller each.`));
    push(out, withOverride(f, "grms", "door_panel",
      "Corridor door panel — bell, do not disturb, make up room", rooms, "no",
      "One outside each guest room door.", 1400));
    push(out, withOverride(f, "grms", "room_thermostat",
      "Guest room thermostat, networked, with occupancy setback", rooms, "no",
      "One per room, set back automatically when the room reads unoccupied — which is where the energy saving on a hotel actually comes from.", 1400));
    push(out, withOverride(f, "grms", "card_switch",
      "Energy saving key card switch, with delay off", rooms, "no",
      "One inside each room door.", 1400));
    return out;
  },
};

// ===========================================================================
// ELECTRICAL — earthing and lightning protection
// ===========================================================================
export const EARTHING: SystemDef = {
  key: "earthing", label: "Earthing & Bonding", colour: "#78716c", family: "Electrical",
  build: (b, f) => {
    const out: Line[] = [];
    const a = totalArea(f);
    if (a <= 0) return out;
    push(out, withOverride(f, "earthing", "earth_bar",
      "Earth bar, copper, with disconnecting links and insulators", 1, "no",
      "One earth bar per floor in the electrical riser, with a disconnecting link so the loop can be tested without pulling the building apart.", 300));
    push(out, withOverride(f, "earthing", "bonding_conductor",
      "Main bonding conductor, 25 mm² green/yellow, with lugs and labels",
      Math.round(Math.sqrt(Math.max(a, 1)) * 2.2), "m",
      `Bonding from the floor earth bar to the water, drainage, duct and containment services, taken as 2.2 x the square root of the floor plate (${Math.round(a)} m²). An allowance, not a measured run.`));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const plate = b.floors.reduce((t, f) => Math.max(t, Object.values(f.spaces).reduce((x, v) => x + v, 0)), 0);
    const perim = Math.round(4 * Math.sqrt(Math.max(plate, 1)));
    const pits = Math.max(3, ceil(perim / 25));
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    return [
      L(f0, "earthing", "earth_pit", "Earth pit with copper rod, inspection chamber and clamp", pits, "no",
        `A ${perim} m building perimeter at one pit per 25 m, never fewer than three, so a single high-resistance rod cannot carry the system.`),
      L(f0, "earthing", "earth_riser", "Main earth riser, 70 mm² bare copper, with supports",
        Math.round(b.floors.length * f2f * 1.2), "m",
        `${b.floors.length} levels at ${f2f} m plus 20% for the offsets between the pit, the main panel and the riser.`),
      L(f0, "earthing", "earth_test", "Earth resistance testing and certification", 1, "set",
        "A measured result below 1 ohm is what the authority signs off on, not the drawing."),
    ];
  },
};

export const LIGHTNING: SystemDef = {
  key: "lightning_protection", label: "Lightning Protection", colour: "#b45309", family: "Electrical",
  build: () => [],
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const top = b.floors.filter(f => f.level >= 0).reduce((t, f) =>
      Math.max(t, Object.values(f.spaces).reduce((x, v) => x + v, 0)), 0);
    if (top <= 0) return [];
    const side = Math.sqrt(top);
    const perim = Math.round(4 * side);
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    const height = b.floors.filter(f => f.level >= 0).length * f2f;
    const downs = Math.max(2, ceil(perim / 20));
    const mesh = Math.round(perim + side * 2 * Math.max(1, Math.round(side / 10)));
    return [
      L(f0, "lightning_protection", "air_terminal", "Air termination rod, 1 m copper, with base and clamp",
        Math.max(4, ceil(perim / 15)), "no",
        `A ${perim} m roof perimeter at one rod per 15 m, which is the spacing that keeps the rolling sphere off the roof edge.`),
      L(f0, "lightning_protection", "roof_conductor", "Roof conductor tape, 25 x 3 mm copper, with saddles",
        mesh, "m",
        `The ${perim} m perimeter plus a 10 m mesh across a ${Math.round(side)} m x ${Math.round(side)} m roof.`),
      L(f0, "lightning_protection", "down_conductor", "Down conductor, 25 x 3 mm copper, with saddles and PVC sleeve",
        Math.round(downs * height * 1.1), "m",
        `${downs} down conductors (perimeter at 20 m spacing) over ${Math.round(height)} m of height, plus 10% for the offsets round the facade.`),
      L(f0, "lightning_protection", "test_joint", "Test joint in accessible box, at 1.5 m above ground",
        downs, "no", "One test joint per down conductor — the only way the installation can be proved after handover.", 1500),
      L(f0, "lightning_protection", "lp_electrode", "Lightning protection earth electrode with pit",
        downs, "no", "One electrode per down conductor, bonded to the main earth system."),
    ];
  },
};

// ===========================================================================
// ELV — telephony, control room, nurse call, vehicle access
// ===========================================================================
export const PABX: SystemDef = {
  key: "pabx", label: "PABX / Telephony", colour: "#0d9488", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const work = area(f, "office", "retail", "lobby");
    const homes = area(f, "apartment");
    const ext = ceil(work / 20) + ceil(homes / 90);
    push(out, withOverride(f, "pabx", "telephone_outlet",
      "Telephone outlet, RJ45 voice, with faceplate", ext, "no",
      `${Math.round(work)} m² of office and retail at one extension per 20 m², plus ${Math.round(homes)} m² of residential at one per 90 m² unit. Voice rides the structured cabling, so this line is the outlet and the extension licence, not a second cable.`, 400));
    push(out, withOverride(f, "pabx", "ip_handset",
      "IP telephone handset, PoE, with licence", ext, "no",
      "One handset per extension."));
    push(out, withOverride(f, "pabx", "dect_base",
      "DECT base station, PoE, ceiling mounted", ceil(totalArea(f) / 1500), "no",
      `${Math.round(totalArea(f))} m² at one DECT base per 1,500 m², for the roaming handsets that security and facilities carry.`, 2800));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const ext = lines.filter(l => l.device === "telephone_outlet").reduce((s, l) => s + l.qty, 0);
    if (!ext) return [];
    return [
      L(f0, "pabx", "pabx_system", "IP PABX system — server, licences, redundant PSU",
        1, "set", `One PABX licensed for ${ext} extensions, with the usual 20% spare licences.`),
      L(f0, "pabx", "voice_gateway", "Voice gateway / SIP trunk interface",
        Math.max(1, ceil(ext / 300)), "no",
        `${ext} extensions at 300 per gateway, sized on a 10% simultaneous call rate.`),
      L(f0, "pabx", "voice_recorder", "Call recording and voicemail server", 1, "set",
        "One recorder — required at every GCC authority for the security and facilities lines."),
    ];
  },
};

export const SECURITY_ROOM: SystemDef = {
  key: "security_room", label: "Security Control Room", colour: "#1e293b", family: "ELV",
  build: () => [],
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const gross = b.floors.reduce((t, f) => t + Object.values(f.spaces).reduce((x, v) => x + v, 0), 0);
    const operators = Math.max(1, ceil(gross / 25000));
    return [
      L(f0, "security_room", "video_wall", "Video wall, 2 x 2 55 inch, with mounts and bezel trim",
        Math.max(1, operators), "set",
        `One wall per operator position. ${Math.round(gross).toLocaleString()} m² gross gives ${operators} position(s) at one per 25,000 m², which is the usual GCC manning for a building of this size.`),
      L(f0, "security_room", "video_wall_controller", "Video wall controller / decoder, with licences",
        Math.max(1, operators), "no", "One controller per wall."),
      L(f0, "security_room", "operator_console", "Operator console desk, with monitor arms and cable management",
        operators, "no", `${operators} operator position(s).`),
      L(f0, "security_room", "workstation", "Security workstation — CCTV, access control and intercom clients",
        operators, "no", "One workstation per position, running every head end client so the operator works from one seat."),
      L(f0, "security_room", "room_fitout", "Control room fit-out — flooring, lighting, acoustic treatment, racks",
        1, "set", "One fit-out package. The room needs its own cooling, its own UPS feed and a door on access control — all three are what the authority inspects."),
    ];
  },
};

export const NURSE_CALL: SystemDef = {
  key: "nurse_call", label: "Nurse Call", colour: "#db2777", family: "ELV",
  build: (b, f) => {
    const out: Line[] = [];
    const beds = ceil(area(f, "apartment") / 18);
    if (!beds) return out;
    push(out, withOverride(f, "nurse_call", "bed_head_unit",
      "Bed head unit with call button, reassurance light and speech", beds, "no",
      `${Math.round(area(f, "apartment"))} m² of ward area at 18 m² per bed, giving ${beds} beds, one unit each.`, 1400));
    push(out, withOverride(f, "nurse_call", "pull_cord",
      "Emergency pull cord with reset, en-suite", ceil(beds / 2), "no",
      "One pull cord per en-suite, taken at one per two beds. Mandatory in every accessible WC and shower.", 1800));
    push(out, withOverride(f, "nurse_call", "over_door_light",
      "Over-door indicator light, 4 colour", ceil(beds / 2), "no",
      "One over each room door, taken at one per two beds."));
    push(out, withOverride(f, "nurse_call", "corridor_display",
      "Corridor display, alphanumeric, with audible", 2, "no",
      "One at each end of the ward corridor, so a call is visible from either direction.", 2400));
    push(out, withOverride(f, "nurse_call", "staff_station",
      "Staff station / master console, with handset", 1, "no",
      "One per ward, at the nurses' base."));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const beds = lines.filter(l => l.device === "bed_head_unit").reduce((s, l) => s + l.qty, 0);
    if (!beds) return [];
    return [
      L(f0, "nurse_call", "nurse_call_server", "Nurse call server with reporting and mobile paging interface",
        1, "set", `One server covering ${beds} beds, with the response-time reporting the regulator asks for.`),
    ];
  },
};

export const GATE_BARRIER: SystemDef = {
  key: "gate_barrier", label: "Gate Barrier & Vehicle Access", colour: "#334155", family: "ELV",
  build: () => [],
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const lanes = b.carParkLanes ?? 0;
    if (!lanes) return [];
    return [
      L(f0, "gate_barrier", "boom_barrier", "Boom barrier, high speed, 3–6 m arm, with safety loops",
        lanes * 2, "no", `${lanes} lane(s), one barrier at entry and one at exit.`),
      L(f0, "gate_barrier", "loop_detector", "Inductive loop detector with saw-cut loop and cabling",
        lanes * 4, "no", "Two loops per barrier — a safety loop and an arming loop — so the arm cannot drop on a vehicle."),
      L(f0, "gate_barrier", "access_terminal", "Entry / exit terminal — ticket, tag or ANPR trigger",
        lanes * 2, "no", "One terminal per barrier, at driver window height.", 1100),
      L(f0, "gate_barrier", "intercom_lane", "Lane intercom to the control room, with camera",
        lanes * 2, "no", "One per lane, so a stuck vehicle reaches the control room without leaving the car.", 1200),
      L(f0, "gate_barrier", "bollard", "Fixed security bollard, with foundation",
        Math.max(4, lanes * 4), "no", "Bollards protecting the barrier island and the pedestrian route beside it."),
      L(f0, "gate_barrier", "guard_booth", "Guard booth with power, data and split air conditioner",
        1, "set", "One booth at the vehicle entrance."),
    ];
  },
};

// ===========================================================================
// ELECTRICAL — critical power, standby power, LV distribution, solar
// ===========================================================================
const STD_UPS_KVA = [10, 20, 30, 40, 60, 80, 100, 120, 160, 200, 250, 300, 400, 500];
const STD_GEN_KVA = [100, 150, 200, 250, 350, 500, 650, 800, 1000, 1250, 1500, 2000, 2500];
const STD_TX_KVA  = [500, 750, 1000, 1500, 2000, 2500, 3000];
const pick = (list: number[], want: number) => list.find(v => v >= want) ?? list[list.length - 1];

export const UPS: SystemDef = {
  key: "ups", label: "UPS & Critical Power", colour: "#dc2626", family: "Electrical",
  build: (b, f) => {
    const out: Line[] = [];
    const a = totalArea(f);
    if (a <= 0) return out;
    push(out, withOverride(f, "ups", "ups_db",
      "UPS distribution board, with MCBs and separate red sockets", 1, "no",
      "One UPS board per floor beside the normal board, on its own red-socket final circuits so a cleaner cannot unplug a server."));
    push(out, withOverride(f, "ups", "ups_socket",
      "UPS socket outlet, 13 A twin, red, with back box", ceil(area(f, "office") / 40), "no",
      `${Math.round(area(f, "office"))} m² of office at one UPS socket per 40 m² — the desks and the floor IDF, not every position.`, 400));
    return out;
  },
  buildingWide: (b, lines) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const gross = b.floors.reduce((t, f) => t + Object.values(f.spaces).reduce((x, v) => x + v, 0), 0);
    if (gross <= 0) return [];
    // ELV, IT and security are the critical load. 10 W/m² is the figure that
    // holds across GCC offices and residential towers once CCTV, access
    // control, fire alarm, BMS, PA and the IDF switches are added up.
    const kw = gross * 0.010;
    const kva = kw / 0.9;
    const want = kva * 1.3;
    const sized = pick(STD_UPS_KVA, want);
    return [
      L(f0, "ups", "ups_unit", `UPS, ${sized} kVA, on-line double conversion, with internal bypass`,
        2, "no",
        `${Math.round(gross).toLocaleString()} m² at 10 W/m² of ELV, IT and security load is ${round1(kw)} kW, ${round1(kva)} kVA at 0.9 power factor, plus 30% for growth, giving ${Math.round(want)} kVA — taken up to the standard ${sized} kVA frame. Two units in parallel so one can be serviced live.`),
      L(f0, "ups", "battery_bank", `Battery bank, sealed lead acid, 15 minutes at ${sized} kVA, with rack`,
        2, "set",
        "15 minutes autonomy — long enough for the generator to pick up and for a controlled shutdown if it does not."),
      L(f0, "ups", "maintenance_bypass", "External maintenance bypass panel, wrap-around", 1, "no",
        "So the UPS can be isolated for service without dropping the critical load. Leaving this out is the most common reason a UPS cannot be maintained."),
      L(f0, "ups", "ups_monitoring", "UPS monitoring card and BMS interface", 2, "no",
        "One per unit, reporting battery state and load to the BMS head end."),
    ];
  },
};

export const GENERATOR: SystemDef = {
  key: "generator", label: "Generator & Standby Power", colour: "#7c2d12", family: "Electrical",
  build: () => [],
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const gross = b.floors.reduce((t, f) => t + Object.values(f.spaces).reduce((x, v) => x + v, 0), 0);
    const coolKw = b.floors.reduce((t, f) => t + coolingKw(f), 0);
    if (gross <= 0) return [];
    // Essential load, not connected load: life safety, lifts, the fire pump,
    // part of the cooling and the ELV. Sizing a generator on connected load is
    // how buildings end up with a machine that never leaves 30% and wet-stacks.
    const electricalKw = coolKw / 3.2 + gross * 0.012 + gross * 0.008;
    const essential = electricalKw * 0.45;
    const kva = essential / 0.8;
    const sized = pick(STD_GEN_KVA, kva * 1.15);
    return [
      L(f0, "generator", "genset", `Diesel generator, ${sized} kVA prime, acoustic enclosure, with controller`,
        1, "no",
        `Building electrical demand ${Math.round(electricalKw)} kW — cooling at COP 3.2, lighting at 12 W/m² and small power at 8 W/m². Essential load taken at 45% of that (life safety, lifts, fire pump, part cooling, ELV) is ${Math.round(essential)} kW, ${Math.round(kva)} kVA at 0.8 power factor, plus 15% margin, taken up to the standard ${sized} kVA frame.`),
      L(f0, "generator", "ats", "Automatic transfer switch, 4 pole, with controller",
        1, "no", "One ATS with a 10 second changeover, which is what the fire code allows before the life safety systems must be live again."),
      L(f0, "generator", "fuel_tank", "Day tank and bulk fuel tank, 8 hours at full load, with bund and transfer set",
        1, "set", "8 hours at full load, bunded to 110% of capacity."),
      L(f0, "generator", "exhaust", "Exhaust system — silencer, flexible, lagging and flue to roof",
        1, "set", "Residential-grade silencer and a flue discharging clear of every fresh-air intake."),
      L(f0, "generator", "gen_cable", "Generator cable, single core XLPE, from set to ATS",
        Math.round(b.floors.length * ((b.floorToFloorMm ?? 3600) / 1000) * 0.4 + 60), "m",
        "An allowance from the plant room to the main board, not a measured run."),
    ];
  },
};

export const LV_DISTRIBUTION: SystemDef = {
  key: "lv_panel", label: "LV Distribution & Transformer", colour: "#a16207", family: "Electrical",
  build: (b, f) => {
    const out: Line[] = [];
    const a = totalArea(f);
    if (a <= 0) return out;
    push(out, withOverride(f, "lv_panel", "smdb",
      "Sub-main distribution board, TPN, with incomer and outgoing MCCBs", 1, "no",
      "One SMDB per floor feeding the floor's lighting, power, HVAC and ELV boards."));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const gross = b.floors.reduce((t, f) => t + Object.values(f.spaces).reduce((x, v) => x + v, 0), 0);
    const coolKw = b.floors.reduce((t, f) => t + coolingKw(f), 0);
    if (gross <= 0) return [];
    const connectedKw = coolKw / 3.2 + gross * 0.012 + gross * 0.008 + gross * 0.010;
    const kva = (connectedKw * 0.75) / 0.9;          // 0.75 diversity
    const sized = pick(STD_TX_KVA, kva * 1.2);
    const nTx = Math.max(1, ceil(kva * 1.2 / 2500));
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    return [
      L(f0, "transformer", "transformer", `Package substation transformer, ${sized} kVA, 11 kV / 415 V, cast resin`,
        nTx, "no",
        `Connected load ${Math.round(connectedKw)} kW at 0.75 diversity and 0.9 power factor is ${Math.round(kva)} kVA, plus 20% for growth, taken up to the standard ${sized} kVA frame. The supply authority approves this figure, so it is stated with its basis rather than rounded quietly.`),
      L(f0, "lv_panel", "mdb", "Main distribution board, form 4 type 6, with ACB incomer and metering",
        nTx, "no", "One main board per transformer, with a digital meter on every outgoing way so energy can be billed and benchmarked."),
      L(f0, "lv_panel", "capacitor_bank", `Automatic power factor correction bank, ${Math.round(sized * 0.25)} kVAr`,
        nTx, "no", "25% of the transformer rating, which brings a typical 0.85 lagging load up to the 0.9 the authority requires."),
      L(f0, "lv_panel", "emergency_db", "Emergency / essential distribution board, with generator changeover",
        1, "no", "The board everything life-safety sits behind."),
      L(f0, "bus_duct", "bus_duct", `Rising bus duct, ${Math.round(sized * 1.4)} A, sandwich type, with tap-off units`,
        Math.round(b.floors.length * f2f * 1.1), "m",
        `${b.floors.length} levels at ${f2f} m plus 10% for the plant room offset. Rated at 1.4 x the transformer current.`),
      L(f0, "bus_duct", "tap_off", "Bus duct tap-off unit, with MCCB", b.floors.length, "no",
        "One tap-off per floor, feeding that floor's SMDB."),
      L(f0, "cable_sizing", "mv_cable", "MV cable, 11 kV XLPE, from authority substation to transformer",
        120, "m", "A 120 m allowance from the plot boundary. This is the one length that must be replaced with the real route before tender."),
    ];
  },
};

export const SOLAR: SystemDef = {
  key: "solar_pv", label: "Solar PV", colour: "#eab308", family: "Electrical",
  build: () => [],
  buildingWide: (b) => {
    const f0 = { name: "Head end / external", level: 0, spaces: {} } as FloorSpec;
    const roof = b.floors.filter(f => f.level >= 0).reduce((t, f) =>
      Math.max(t, Object.values(f.spaces).reduce((x, v) => x + v, 0)), 0);
    if (roof <= 0) return [];
    const usable = roof * 0.5;                      // plant, access, shading
    const kwp = usable * 0.19;                      // 190 W/m² at module level
    const panels = ceil(kwp / 0.55);                // 550 Wp modules
    const inverters = Math.max(1, ceil(kwp / 50));
    return [
      L(f0, "solar_pv", "pv_module", "PV module, 550 Wp, monocrystalline, with warranty",
        panels, "no",
        `${Math.round(roof).toLocaleString()} m² roof plate, half of it usable after plant, access walkways and inter-row shading, at 190 W/m² gives ${Math.round(kwp)} kWp — ${panels} modules of 550 Wp.`),
      L(f0, "solar_pv", "mounting", "Mounting system, ballasted, non-penetrating, with ballast blocks",
        panels, "set", "Ballasted rather than drilled, so the roof waterproofing is never broken."),
      L(f0, "solar_pv", "inverter", "String inverter, 50 kW, with monitoring",
        inverters, "no", `${Math.round(kwp)} kWp at 50 kW per inverter.`),
      L(f0, "solar_pv", "dc_cable", "DC string cable, 6 mm² solar rated, with MC4 connectors",
        Math.round(panels * 4.5), "m", `${panels} modules at 4.5 m of string cable each, including the return leg.`),
      L(f0, "solar_pv", "ac_combiner", "AC combiner panel with isolation, surge protection and export meter",
        1, "no", "One combiner with the bi-directional meter the net-metering scheme requires."),
    ];
  },
};

// ===========================================================================
// FIRE — smoke management and gas suppression
// ===========================================================================
export const SMOKE_MANAGEMENT: SystemDef = {
  key: "smoke_management", label: "Smoke Management", colour: "#9a3412", family: "Fire",
  build: (b, f) => {
    const out: Line[] = [];
    const a = totalArea(f);
    if (a <= 0) return out;
    push(out, withOverride(f, "smoke_management", "pressure_relief_damper",
      "Pressure relief damper, barometric, stair and lobby", 2, "no",
      "One per pressurised stair on each floor, to hold the 50 Pa differential without the door becoming too heavy to open."));
    push(out, withOverride(f, "smoke_management", "smoke_damper",
      "Motorised smoke damper, 2 hour rated, with actuator and end switch",
      ceil(area(f, "office", "apartment", "retail", "lobby", "corridor") / 300), "no",
      `One damper at every compartment penetration, taken at one per 300 m² of conditioned area. Each one is interlocked to the fire alarm and reports its position back.`));
    push(out, withOverride(f, "smoke_management", "fire_rated_duct",
      "Fire-rated duct, 2 hour, with supports and coating",
      Math.round(Math.sqrt(Math.max(a, 1)) * 1.6), "m",
      `Smoke extract and pressurisation duct on this floor, taken as 1.6 x the square root of the floor plate. An allowance, not a measured run.`));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const levels = b.floors.filter(f => f.level >= 0).length;
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    const height = levels * f2f;
    return [
      L(f0, "smoke_management", "stair_pressurisation_fan",
        "Stair pressurisation fan, axial, with VFD and pressure control", 2, "no",
        `Two escape stairs, one fan each, sized to hold 50 Pa with the doors shut and 1 m/s through an open door over ${Math.round(height)} m of stair.`),
      L(f0, "smoke_management", "lobby_pressurisation_fan",
        "Fire-fighting lobby pressurisation fan, with VFD", 1, "no",
        "One fan on the fire-fighting lobby — a separate system from the stair, which is what the civil defence inspector checks for."),
      L(f0, "smoke_management", "pressurisation_duct",
        "Pressurisation shaft duct, GI, with supports", Math.round(height * 3 * 1.15), "m",
        `Three shafts over ${Math.round(height)} m plus 15% for the plant room connections.`),
      L(f0, "smoke_management", "smoke_control_panel",
        "Smoke control panel with fireman's override switches", 1, "no",
        "One panel at the fire-fighting access point, with manual override on every fan and damper."),
    ];
  },
};

export const GAS_SUPPRESSION: SystemDef = {
  key: "gas_suppression", label: "Gas Suppression", colour: "#065f46", family: "Fire",
  build: (b, f) => {
    const out: Line[] = [];
    const plant = area(f, "plant_room");
    const rooms = plant > 0 ? Math.max(1, ceil(plant / 150)) : 0;
    if (!rooms) return out;
    const vol = Math.round((plant / Math.max(rooms, 1)) * 3.0);
    push(out, withOverride(f, "gas_suppression", "agent_cylinder",
      `Clean agent cylinder (FM-200 / Novec 1230), sized for ${vol} m³, with bracket and weighing device`,
      rooms, "no",
      `${Math.round(plant)} m² of electrical, IT and plant rooms at one protected room per 150 m², each about ${vol} m³ at 3 m clear height. Charge is set on the room volume at the agent's design concentration, with a 10 second discharge.`));
    push(out, withOverride(f, "gas_suppression", "discharge_nozzle",
      "360° discharge nozzle, with pipework", rooms * 3, "no",
      "Three nozzles per room — above, within and below the floor void, because the void is where the fire usually starts."));
    push(out, withOverride(f, "gas_suppression", "detection_pair",
      "Cross-zoned detector pair (optical and heat), with base", rooms * 2, "no",
      "Two independent detectors per room, cross-zoned so a single detector cannot discharge the system."));
    push(out, withOverride(f, "gas_suppression", "release_panel",
      "Extinguishant release control panel, with battery and abort", rooms, "no",
      "One panel per protected room, with an abort switch inside the door."));
    push(out, withOverride(f, "gas_suppression", "warning_sign",
      "Discharge warning sign and sounder-beacon, inside and outside", rooms * 2, "no",
      "One set each side of the door. The authority will not sign the room off without them.", 2200));
    push(out, withOverride(f, "gas_suppression", "pressure_vent",
      "Pressure relief vent, sized on the discharge", rooms, "no",
      "One per room. Without it the discharge blows the walls out, which is a documented failure, not a theoretical one."));
    return out;
  },
};

// ===========================================================================
// MECHANICAL / PLUMBING — pump room and hot water
// ===========================================================================
export const PUMP_ROOM: SystemDef = {
  key: "pump_room", label: "Pump Room & Tanks", colour: "#0e7490", family: "Plumbing",
  build: () => [],
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const gross = b.floors.reduce((t, f) => t + Object.values(f.spaces).reduce((x, v) => x + v, 0), 0);
    if (gross <= 0) return [];
    const basements = b.floors.filter(f => f.level < 0).length;
    const out: Line[] = [
      L(f0, "pumps", "transfer_pump", "Water transfer pump, duty/standby, with level control",
        2, "no", "Duty and standby, lifting from the raw water tank to the roof tank. Never a single pump on a water supply."),
      L(f0, "pumps", "pressure_vessel", "Diaphragm pressure vessel, with gauge and isolation",
        2, "no", "One per pump set, so the set does not short-cycle on a small draw-off."),
      L(f0, "water_supply", "pump_header", "Pump room header and manifold, 100–150 mm, with supports",
        45, "m", "A 45 m allowance for the suction and delivery headers, bypass and the tank connections inside the pump room."),
      L(f0, "water_supply", "pump_valves", "Pump room valve set — gate, non-return, strainer, flexible connector",
        8, "set", "One set per pump plus the header isolation."),
      L(f0, "water_supply", "flow_meter", "Bulk flow meter with pulse output to the BMS",
        2, "no", "One on the incoming supply and one on the delivery, so a leak shows as a difference rather than as a bill."),
      L(f0, "water_supply", "level_control", "Tank level control and alarm panel, with BMS interface",
        1, "set", "Level, low-level alarm and overflow alarm on every tank."),
      L(f0, "pumps", "pump_room_gantry", "Lifting gantry / beam over the pump set",
        1, "set", "So a pump can be lifted out for service. Pump rooms built without one need a wall opened up later."),
    ];
    if (basements > 0) {
      out.push(L(f0, "pumps", "sump_pump", "Submersible sump pump, duty/standby, with float and alarm",
        basements * 2, "no",
        `Two pumps in each of ${basements} basement sump pit(s) — duty and standby, because a basement that floods takes the whole electrical plant with it.`));
      out.push(L(f0, "drainage", "sump_discharge", "Sump discharge pipework, 80 mm, with non-return and air break",
        Math.round(basements * ((b.floorToFloorMm ?? 3600) / 1000) * 1.3 + 25), "m",
        "Discharge from each sump to the external manhole, with a non-return valve and an air break."));
    }
    return out;
  },
};

export const HOT_WATER: SystemDef = {
  key: "hot_water", label: "Hot Water", colour: "#f97316", family: "Plumbing",
  build: (b, f) => {
    const out: Line[] = [];
    const wet = area(f, "toilet", "apartment", "kitchen");
    if (wet <= 0) return out;
    push(out, withOverride(f, "hot_water", "water_heater",
      "Electric water heater, 50–100 L, with TPR valve and drain", ceil(wet / 120), "no",
      `${Math.round(wet)} m² of wet area at one local heater per 120 m², which keeps the dead leg short enough that hot water arrives before the tap is given up on.`, 2200));
    push(out, withOverride(f, "hot_water", "hw_pipe",
      "Hot water pipework, CPVC / PPR, insulated, with fittings",
      Math.round(Math.sqrt(Math.max(totalArea(f), 1)) * 1.1), "m",
      `Hot water distribution on this floor, taken as 1.1 x the square root of the floor plate. An allowance, not a measured run.`));
    push(out, withOverride(f, "hot_water", "tmv",
      "Thermostatic mixing valve, TMV3, with isolation and strainers", ceil(wet / 240), "no",
      "One mixing valve per wet group. Required wherever the outlet is accessible, to hold the temperature at 41 °C and stop a scald."));
    return out;
  },
  buildingWide: (b) => {
    const f0 = { name: "Head end / plant", level: 0, spaces: {} } as FloorSpec;
    const wet = b.floors.reduce((t, f) => t + (f.spaces.toilet || 0) + (f.spaces.apartment || 0) + (f.spaces.kitchen || 0), 0);
    if (wet <= 0) return [];
    const f2f = (b.floorToFloorMm ?? 3600) / 1000;
    return [
      L(f0, "hot_water", "heat_pump", "Air source heat pump water heater, with buffer tank and controls",
        2, "no",
        `${Math.round(wet).toLocaleString()} m² of wet area served centrally. Two units, duty and standby — a heat pump rather than a direct electric calorifier is what the GCC energy codes now expect on a central system.`),
      L(f0, "hot_water", "hw_circulation_pump", "Hot water circulation pump, bronze, duty/standby, with timer",
        2, "no", "Circulation so a distant outlet does not run cold, timed off overnight to stop the standing loss."),
      L(f0, "hot_water", "hw_riser", "Hot water flow and return riser, insulated, with isolating valves",
        Math.round(b.floors.length * f2f * 2 * 1.15), "m",
        `Flow and return over ${b.floors.length} levels at ${f2f} m plus 15% for the plant room connections.`),
    ];
  },
};

export const ALL_SYSTEMS: SystemDef[] = [
  // ELV
  CCTV, ACCESS, STRUCTURED_CABLING, WIFI, INTERCOM, IPTV,
  PUBLIC_ADDRESS, AUDIO_VISUAL, PARKING, GATE_BARRIER, BMS, GRMS,
  PABX, SECURITY_ROOM, NURSE_CALL,
  // Fire
  FIRE_ALARM, SPRINKLER, FIRE_FIGHTING, SMOKE_MANAGEMENT, GAS_SUPPRESSION,
  // Mechanical
  HVAC, CHILLED_WATER,
  // Electrical
  LIGHTING, SMALL_POWER, EARTHING, LIGHTNING, UPS, GENERATOR,
  LV_DISTRIBUTION, SOLAR,
  // Plumbing
  PLUMBING, PUMP_ROOM, HOT_WATER,
];
