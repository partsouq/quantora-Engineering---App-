// ===========================================================================
// Quantora — design rules
//
// Every number here is one an engineer can argue with, and carries the clause
// it came from. That matters more than the arithmetic: a quantity without a
// citation is an opinion, and an opinion is what the consultant rejects.
//
// Where a code gives a range the conservative end is taken. `basis` is copied
// onto every BOQ line and every drawing note so the figure can be checked
// against the real code rather than trusted because software printed it.
// ===========================================================================

export type SpaceMix = Record<string, number>;          // { office: 620, corridor: 140 }

export interface FloorSpec {
  name: string;
  level: number;                 // 0 ground, negative basement
  spaces: SpaceMix;              // m² per space type
  doors?: number;                // access-controlled doors
  lifts?: number;
  overrides?: Record<string, number>;   // client-stated counts, these win
}

export interface BuildingSpec {
  name: string;
  country: string;
  city: string;
  floors: FloorSpec[];
  floorToFloorMm?: number;
  mainEntrances?: number;
  carParkLanes?: number;
}

export interface Line {
  floor: string;
  level: number;
  system: string;            // maps to boq_items.system_category
  device: string;
  label: string;
  qty: number;
  unit: string;
  mountingMm?: number | null;
  source: "client" | "code";
  basis: string;
}

// --------------------------------------------------------------- authorities
export const AUTHORITIES: Record<string, any> = {
  "AE-DU": { name: "Dubai — SIRA / DCD", country: "UAE", cities: ["dubai"],
             security: "SIRA Security Systems Regulation",
             fire: "UAE Fire and Life Safety Code of Practice (Dubai Civil Defence)",
             energy: "Dubai Green Building Regulations (Al Sa'fat)" },
  "AE-AZ": { name: "Abu Dhabi — ADMCC / ADCD", country: "UAE", cities: ["abu dhabi", "al ain"],
             security: "ADMCC Security Systems Guideline",
             fire: "UAE Fire and Life Safety Code of Practice",
             energy: "Estidama Pearl Building Rating System" },
  "SA":    { name: "Saudi Arabia — HCIS / SBC", country: "KSA",
             cities: ["riyadh", "jeddah", "dammam", "tabuk", "mecca", "medina", "khobar"],
             security: "HCIS SEC-01 / Ministry of Interior security requirements",
             fire: "Saudi Building Code SBC 801", energy: "Saudi Building Code SBC 601" },
  "QA":    { name: "Qatar — MOI / QCDD", country: "Qatar", cities: ["doha", "al rayyan"],
             security: "MOI Security Systems Requirements", fire: "QCDD Fire Safety Standard",
             energy: "QCS 2014 / GSAS" },
  "KW":    { name: "Kuwait — Kuwait Fire Force / MEW", country: "Kuwait", cities: ["kuwait city", "hawalli", "al ahmadi"],
             security: "Ministry of Interior CCTV Regulation", fire: "Kuwait Fire Force requirements",
             energy: "MEW Code of Practice R-6" },
  "OM":    { name: "Oman — ROP / CDAA", country: "Oman", cities: ["muscat", "salalah", "sohar"],
             security: "Royal Oman Police security requirements", fire: "Civil Defence and Ambulance Authority (CDAA) fire code",
             energy: "Oman Building Code" },
  "AE-SH": { name: "Sharjah — Sharjah Civil Defence / SEWA", country: "UAE", cities: ["sharjah"],
             security: "Sharjah Police security requirements",
             fire: "UAE Fire and Life Safety Code of Practice (Sharjah Civil Defence)", energy: "SEWA regulations" },
  "AE-NE": { name: "Northern Emirates — UAE Civil Defence / EtihadWE", country: "UAE",
             cities: ["ajman", "ras al khaimah", "fujairah", "umm al quwain"],
             security: "Local police security requirements",
             fire: "UAE Fire and Life Safety Code of Practice", energy: "Etihad Water and Electricity regulations" },
  "BH":    { name: "Bahrain — Civil Defence / EWA", country: "Bahrain", cities: ["manama", "muharraq", "riffa"],
             security: "Ministry of Interior security requirements", fire: "General Directorate of Civil Defence requirements",
             energy: "EWA regulations", fireName: "Civil Defence" },
  "IN":    { name: "India — NBC 2016 / State Fire Services", country: "India", cities: [],
             security: "IS/IEC 62676 (no national CCTV regulator for private buildings)",
             fire: "National Building Code of India 2016 Part 4, IS 2189, IS 15105", energy: "ECBC",
             fireName: "State Fire Services", region: "South Asian", retention: 30 },
  "PK":    { name: "Pakistan — Building Code of Pakistan / Rescue 1122", country: "Pakistan", cities: [],
             security: "IEC 62676", fire: "Building Code of Pakistan (Fire Safety Provisions 2016), NFPA 72 / 13",
             energy: "Pakistan energy code", fireName: "fire / Rescue 1122 authority", region: "South Asian", retention: 30 },
  "BD":    { name: "Bangladesh — BNBC 2020 / FSCD", country: "Bangladesh", cities: [],
             security: "IEC 62676", fire: "BNBC 2020 Part 4, NFPA 72 / 13", energy: "BNBC 2020",
             fireName: "Fire Service and Civil Defence", region: "South Asian", retention: 30 },
  "LK":    { name: "Sri Lanka — UDA / Municipal Fire Brigade", country: "Sri Lanka", cities: [],
             security: "IEC 62676", fire: "Fire Brigade requirements, NFPA 72 / 13", energy: "Sri Lanka energy code",
             fireName: "Fire Brigade", region: "South Asian", retention: 30 },
  "SG":    { name: "Singapore — SCDF / BCA / IMDA", country: "Singapore", cities: [],
             security: "IEC 62676", fire: "SCDF Fire Code, SS 645, SS CP 52", energy: "BCA Green Mark",
             fireName: "SCDF", region: "regional", retention: 30 },
  "MY":    { name: "Malaysia — UBBL / Bomba", country: "Malaysia", cities: [],
             security: "IEC 62676", fire: "UBBL 1984, MS 1745, MS 1910", energy: "MS 1525",
             fireName: "Bomba", region: "regional", retention: 30 },
  "PH":    { name: "Philippines — RA 9514 / BFP", country: "Philippines", cities: [],
             security: "IEC 62676", fire: "Fire Code of the Philippines (RA 9514), NFPA 72 / 13", energy: "Philippine Green Building Code",
             fireName: "Bureau of Fire Protection", region: "regional", retention: 30 },
  "HK":    { name: "Hong Kong — FSD / Buildings Department", country: "Hong Kong", cities: [],
             security: "IEC 62676", fire: "FSD Codes of Practice for Minimum Fire Service Installations", energy: "Building Energy Code (EMSD)",
             fireName: "Fire Services Department", region: "regional", retention: 30 },
  "AU":    { name: "Australia — NCC (BCA) / AS 1670", country: "Australia", cities: [],
             security: "AS 4806", fire: "NCC (BCA), AS 1670.1, AS 2118", energy: "NCC Section J",
             fireName: "fire and rescue service", region: "local", retention: 30 },
  "UK":    { name: "United Kingdom — Building Regulations / BS", country: "UK", cities: [],
             security: "BS EN 62676-4", fire: "Approved Document B, BS 5839-1, BS EN 12845", energy: "Approved Document L",
             fireName: "Fire and Rescue Service", region: "UK", retention: 30 },
  "US":    { name: "United States — IBC / NFPA (AHJ)", country: "US", cities: [],
             security: "UL 2802 / IEC 62676", fire: "IBC / IFC, NFPA 72, NFPA 13, NFPA 70", energy: "ASHRAE 90.1 / IECC",
             fireName: "fire marshal", region: "local", retention: 30 },
  "ZA":    { name: "South Africa — SANS 10400", country: "South Africa", cities: [],
             security: "IEC 62676 / POPIA", fire: "SANS 10400-T, SANS 10139, SANS 10287", energy: "SANS 10400-XA",
             fireName: "municipal fire department", region: "local", retention: 30 },
  "EU":    { name: "Europe — EN standards", country: null, cities: [],
             security: "EN 62676-4", fire: "EN 54, EN 12845, national fire regulations", energy: "national energy code (EPBD)",
             fireName: "fire service", region: "local", retention: 30 },
  "INTL":  { name: "International default — NFPA / EN / ASHRAE (confirm with the local authority)", country: null, cities: [],
             security: "IEC 62676", fire: "NFPA 72 and NFPA 13", energy: "ASHRAE 90.1",
             fireName: "local fire authority", region: "local", retention: 30 },
};

/** Gulf authorities: the design lines were written for them and stay word for word. */
export const GULF_KEYS = ["AE-DU", "AE-AZ", "AE-SH", "AE-NE", "SA", "QA", "KW", "OM", "BH"];

const EU_COUNTRIES = ["germany", "france", "italy", "spain", "netherlands", "belgium", "ireland", "portugal", "austria",
  "sweden", "denmark", "finland", "poland", "greece", "czech republic", "czechia", "luxembourg", "romania", "hungary",
  "norway", "switzerland"];

export function authorityFor(country: string, city: string): string {
  const c = (country || "").trim().toLowerCase();
  const t = (city || "").trim().toLowerCase();
  for (const [k, a] of Object.entries(AUTHORITIES)) {
    // a city name only decides the authority inside its own country (Hyderabad is in India and Pakistan)
    if ((a.cities as string[]).includes(t) && (!c || !a.country || a.country.toLowerCase() === c ||
        (a.country === "UAE" && ["uae", "united arab emirates", "ae"].includes(c)) ||
        (a.country === "KSA" && ["ksa", "saudi arabia", "saudi", "sa"].includes(c)))) return k;
  }
  if (["uae", "united arab emirates", "ae"].includes(c)) return "AE-DU";
  if (["ksa", "saudi arabia", "saudi", "sa"].includes(c)) return "SA";
  if (["qatar", "qa"].includes(c)) return "QA";
  if (["kuwait", "kw"].includes(c)) return "KW";
  if (["oman", "om"].includes(c)) return "OM";
  if (["bahrain", "bh"].includes(c)) return "BH";
  if (["india", "in", "bharat"].includes(c)) return "IN";
  if (["pakistan", "pk"].includes(c)) return "PK";
  if (["bangladesh", "bd"].includes(c)) return "BD";
  if (["sri lanka", "srilanka", "lk"].includes(c)) return "LK";
  if (["singapore", "sg"].includes(c)) return "SG";
  if (["malaysia", "my"].includes(c)) return "MY";
  if (["philippines", "ph"].includes(c)) return "PH";
  if (["hong kong", "hk"].includes(c)) return "HK";
  if (["australia", "au"].includes(c)) return "AU";
  if (["uk", "united kingdom", "great britain", "gb", "england", "scotland", "wales"].includes(c)) return "UK";
  if (["us", "usa", "united states", "united states of america", "america"].includes(c)) return "US";
  if (["south africa", "za", "rsa"].includes(c)) return "ZA";
  if (EU_COUNTRIES.includes(c)) return "EU";
  return "INTL";
}

// ------------------------------------------------------------------ helpers
export const ceil = (x: number) => Math.ceil(x - 1e-9);
export const round1 = (x: number) => Math.round(x * 10) / 10;

/** Cooling load density, W/m². The single number the whole mechanical design hangs off. */
export const COOLING_W_M2: Record<string, number> = {
  office: 130, apartment: 110, retail: 180, lobby: 150, corridor: 60,
  kitchen: 250, warehouse: 80, toilet: 0, stair: 0, plant_room: 0, car_park: 0,
};

/** Area served by one luminaire, m² — how a lighting layout is actually set out. */
export const M2_PER_LUMINAIRE: Record<string, number> = {
  office: 8, apartment: 10, retail: 6, lobby: 8, corridor: 6,
  kitchen: 8, warehouse: 30, toilet: 6, stair: 10, plant_room: 15, car_park: 25,
};

/** Typical fitting wattage by space, used to check the layout against the cap. */
export const LUMINAIRE_W: Record<string, number> = {
  office: 36, apartment: 12, retail: 25, lobby: 18, corridor: 18,
  kitchen: 25, warehouse: 70, toilet: 12, stair: 18, plant_room: 36, car_park: 36,
};

/** Lighting power density, W/m² — the cap the energy code sets. */
export const LPD_W_M2: Record<string, number> = {
  office: 9, apartment: 7, retail: 15, lobby: 11, corridor: 5,
  kitchen: 11, warehouse: 8, toilet: 6, stair: 5, plant_room: 6, car_park: 3,
};

/** Air changes per hour where the space is ventilated rather than cooled. */
export const ACH: Record<string, number> = { car_park: 6, toilet: 10, kitchen: 20, plant_room: 6 };

/** Occupant density, m² per person — drives fresh air and sanitary fixtures. */
export const M2_PER_PERSON: Record<string, number> = {
  office: 10, retail: 7, apartment: 25, lobby: 20, warehouse: 50, kitchen: 15,
};

/** Lines written for the Gulf, worded for the project's own country. */
export function localiseLine(text: string, key: string): string {
  if (!text || GULF_KEYS.includes(key)) return text;
  const a = AUTHORITIES[key] ?? AUTHORITIES.INTL;
  return text
    .replace(/every GCC authority/g, "every regulated authority")
    .replace(/typical GCC /g, "typical ")
    .replace(/mandatory in GCC humidity/g, "mandatory in humid conditions")
    .replace(/the usual GCC manning/g, "the usual manning")
    .replace(/the GCC energy codes now expect/g, `${a.energy ?? "the current energy code"} now expects`)
    .replace(/\bGCC\b/g, a.region ?? "local")
    .replace(/the civil defence vehicle/g, `the ${a.fireName ?? "fire service"} vehicle`)
    .replace(/the civil defence inspector/g, `the ${a.fireName ?? "fire authority"} inspector`)
    .replace(/[Cc]ivil [Dd]efence/g, a.fireName ?? "fire authority")
    .replace(/31-day retention is the authority minimum/g, `${a.retention ?? 30}-day retention is assumed (confirm the local requirement)`)
    .replace(/31-day retention/g, `${a.retention ?? 30}-day retention`);
}
