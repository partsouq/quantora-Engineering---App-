// Schedules printed on a drawing (2026-10-27).
//
// An MEP sheet usually carries its own quantities: a fan coil unit schedule, a
// diffuser / grille schedule, a lighting fixture schedule, a DB schedule. The
// designer wrote those numbers; counting symbols on the plan is a guess at the
// same thing. A customer's HVAC sheet came back with 31 FCUs "capacity not
// stated" when its own schedule listed 44 with their kW, and "Flow bar 22 nr"
// when the schedule gave 73 m supply and 127.5 m return.
//
// This file does two things:
//  1. SCHEDULE_TOOL: the AI copies every table on the sheet cell by cell. It
//     does not interpret anything, so the same rules apply to every discipline
//     and every drawing style (CAD text, SHX outlines, scans).
//  2. scheduleTablesToItems / applyScheduleItems: plain code turns those tables
//     into BOQ lines and lets them replace the AI's plan count for the same
//     kind of item. The plan count is kept in the note, so a reviewer sees both.

export const SCHEDULE_TOOL = {
  name: "record_sheet_tables",
  description: "Copy every table printed on this drawing sheet exactly as printed, cell by cell.",
  input_schema: {
    type: "object",
    properties: {
      tables: {
        type: "array",
        description: "Every table on the sheet: equipment schedules (FCU, AHU, fans, pumps, chillers, DBs, panels), " +
          "diffuser / grille / register schedules, lighting fixture schedules, door / window / finish schedules, sanitary " +
          "fixture schedules, device or camera schedules, quantity tables. Include a legend or revision table only as kind " +
          "legend / revision. Copy, do not interpret.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "The table's title exactly as printed (empty string if it has none)." },
            kind: {
              type: "string",
              enum: ["equipment_schedule", "terminal_schedule", "fixture_schedule", "door_window_schedule", "quantity_table", "legend", "revision", "notes", "other"],
              description: "equipment_schedule = units listed by reference (FCU-01, AHU-2, DB-GF1). terminal_schedule = diffusers, grilles, registers, " +
                "flow bars, valves. fixture_schedule = light fittings, sanitary fixtures, devices by type. door_window_schedule = doors / windows. " +
                "quantity_table = any other table with a quantity column. legend / revision / notes / other are never quantities.",
            },
            columns: {
              type: "array", items: { type: "string" },
              description: "Column headings left to right. Join a heading printed on two lines with a space, and add its unit line, " +
                "e.g. \"SUPPLY QUANTITY\", \"TOTAL LOAD KW\", \"NECK SIZE (mm)\".",
            },
            rows: {
              type: "array",
              items: { type: "array", items: { type: "string" } },
              description: "Every body row with EXACTLY as many cells as there are columns, in column order, exactly as printed (\"08 Nos.\", \"13.0 mtr.\", \"-\", " +
                "\"FCU-02 TO 44\"). A cell merged across several rows (a location written once for two rows) is repeated in each row it covers. " +
                "Use \"\" for an empty cell. Do not add totals, do not skip rows, do not round.",
            },
            notes: { type: ["string", "null"], description: "Notes printed under the table, e.g. \"capacity is per single unit\"." },
          },
          required: ["title", "kind", "columns", "rows"],
        },
      },
      sheet_floor: { type: ["string", "null"], description: "The floor / level in the title block, e.g. \"FIRST FLOOR\"." },
    },
    required: ["tables"],
  },
};

export const SCHEDULE_PROMPT =
  "Find every TABLE printed on this drawing sheet -- usually beside the legend, in the title strip or in a corner of the plan -- " +
  "and copy each one through record_sheet_tables, cell by cell, exactly as printed. Read the full table, every row. " +
  "This is transcription, not take-off: do not count anything on the plan, do not add or correct values, and do not summarise. " +
  "If a table is cut off or too small to read, leave out the rows you cannot read rather than guessing them. " +
  "If the sheet has no tables, return an empty list.";

const QTY_CELL = /^\d+(\.\d+)?\s*(nos?|no|nr|pcs|sets?|mtrs?|m|lm|rmt?|meters?|metres?)\.?$/i;
const QTY_HEAD = /\b(QTY|QUANT(ITY|ITIES)?|NOS?\.?|NUMBERS?|NO\.?\s*OF|COUNT|TOTAL\s*(NO|QTY|NUMBER))\b/i;
const SERIAL_HEAD = /^\s*(S\.?\s*[IL]?\.?\s*NO\.?|SR\.?\s*NO\.?|SL\.?\s*NO\.?|SI\.?\s*NO\.?|#|NO\.?|ITEM\s*NO\.?)\s*$/i;
const REF_HEAD = /\b(REF(ERENCE)?|TAG|MARK|DESIGNATION|UNIT\s*NO|EQUIPMENT\s*NO|I\.?D\.?)\b/i;
const DESC_HEAD = /\b(DESCRIPTION|TYPE|ITEM|EQUIPMENT|FIXTURE|FITTING|MODEL|NAME)\b/i;
const SIZE_HEAD = /\b(SIZE|NECK|DIMENSIONS?|DIA(METER)?|W\s*X\s*H)\b/i;
const SPEC_HEAD = /\b(LOAD|KW|CAPACITY|AIR\s*FLOW|SUPPLY\s*AIR|L\/S|CFM|RATING|WATTS?|POWER|HP|TR|BTU|FLOW|VOLTAGE|PHASE|AMPS?|LUMENS?|ESP|PRESSURE)\b/i;
const LOC_HEAD = /\b(LOCATION|ROOM|AREA|ZONE|SERV(ING|ES))\b/i;

export type ScheduleItem = {
  system_category: string; description: string; quantity: number; unit: string;
  family: RegExp; familyName: string; table: string; rowsUsed: number; detail: string[];
};

function parseQty(cell: string): { q: number; unit: string } | null {
  const s = String(cell ?? "").replace(/,/g, "").trim();
  if (!s || /^[-–—/]+$/.test(s) || /^(n\/?a|nil|none)$/i.test(s)) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z.²\d]*)/i);
  if (!m) return null;
  const q = Number(m[1]);
  if (!Number.isFinite(q) || q <= 0) return null;
  const u = m[2].toLowerCase().replace(/\./g, "");
  const unit = /^(mtrs?|m|lm|rm|rmt|meters?|metres?)$/.test(u) ? "m" : /^(m2|sqm|sq|m²)$/.test(u) ? "m2" : "nr";
  return { q, unit };
}

// "FCU-02 TO 44", "FCU-02 TO FCU-44", "EF-1~3", "AHU 1-4", "FCU-1, FCU-3, FCU-7"
export function countRefs(cell: string): number {
  const s = String(cell ?? "").toUpperCase().trim();
  if (!s) return 0;
  const range = s.match(/([A-Z]*)[-\s]*(\d+)\s*(?:TO|~|–|—|-|THRU|THROUGH)\s*(?:[A-Z]+[-\s]*)?(\d+)\s*$/);
  if (range && /[A-Z]/.test(s.replace(/\b(TO|THRU|THROUGH)\b/g, "")) ) {
    const a = Number(range[2]), b = Number(range[3]);
    if (b >= a && b - a < 500) return b - a + 1;
  }
  const parts = s.split(/[,&;\/]|\bAND\b/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => /\d/.test(p))) return parts.length;
  return /[A-Z0-9]/.test(s) ? 1 : 0;
}

type Family = { name: string; re: RegExp; system: string };
// Most specific first. The regex also decides which AI lines a schedule replaces.
const FAMILIES: Family[] = [
  { name: "fan coil unit", re: /\b(fan\s*coil|fcu)s?\b/i, system: "fcu" },
  { name: "air handling unit", re: /\b(air\s*handling|ahu|fahu|fresh\s*air\s*(handling\s*)?unit)s?\b/i, system: "ahu" },
  { name: "chiller", re: /\bchillers?\b/i, system: "chillers" },
  { name: "flow bar / linear slot diffuser", re: /\b(flow\s*bars?|linear\s*(slot\s*)?(bar\s*)?diffusers?|slot\s*diffusers?)\b/i, system: "hvac" },
  { name: "diffuser", re: /\bdiffusers?\b/i, system: "hvac" },
  { name: "grille / register", re: /\b(grilles?|registers?|louvres?|louvers?)\b/i, system: "hvac" },
  { name: "damper", re: /\bdampers?\b/i, system: "ducting" },
  { name: "VAV box", re: /\b(vav|variable\s*air\s*volume)\b/i, system: "hvac" },
  { name: "fan", re: /\b(exhaust|extract|supply|transfer|jet|kitchen|toilet)?\s*fans?\b(?!\s*coil)/i, system: "ventilation" },
  { name: "split / VRF unit", re: /\b(split|vrf|vrv|cassette|condensing\s*unit|odu|idu|indoor\s*unit|outdoor\s*unit|package\s*unit)s?\b/i, system: "hvac" },
  { name: "pump", re: /\bpumps?\b/i, system: "pumps" },
  { name: "water heater", re: /\b(water\s*heaters?|ewh|calorifiers?)\b/i, system: "hot_water" },
  { name: "sprinkler", re: /\bsprinklers?\b/i, system: "sprinkler" },
  { name: "fire fighting equipment", re: /\b(hose\s*reels?|extinguishers?|fire\s*hose\s*cabinets?|fhc|landing\s*valves?)\b/i, system: "fire_fighting" },
  { name: "fire alarm device", re: /\b(detectors?|call\s*points?|sounders?|strobes?|beacons?)\b/i, system: "fire_alarm" },
  { name: "camera", re: /\b(cameras?|cctv)\b/i, system: "cctv" },
  { name: "light fitting", re: /\b(light(ing)?\s*fix(ture|ing)s?|luminaires?|downlights?|light\s*fittings?|led\s*(panel|strip|light)s?|spot\s*lights?|emergency\s*lights?|exit\s*signs?)\b/i, system: "lighting" },
  { name: "distribution board", re: /\b(distribution\s*boards?|smdb|mdb|db|panel\s*boards?|lv\s*panels?)\b/i, system: "db_panels" },
  { name: "socket outlet", re: /\b(socket|power\s*outlet|isolator|fused\s*spur)s?\b/i, system: "power_distribution" },
  { name: "sanitary fixture", re: /\b(wc|water\s*closets?|wash\s*basins?|basins?|sinks?|urinals?|showers?|bidets?|ablution)\b/i, system: "fixtures" },
  { name: "door", re: /\bdoors?\b/i, system: "doors" },
  { name: "window", re: /\bwindows?\b/i, system: "windows" },
];

function familyOf(text: string): Family | null {
  for (const f of FAMILIES) if (f.re.test(text)) return f;
  return null;
}

function cap(s: string): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function singularTitle(title: string): string {
  // "CALCULATED FAN COIL UNITS SCHEDULE - HOME CENTRE ..." -> the family name
  const f = familyOf(title);
  return f ? cap(f.name) : "";
}

export function scheduleTablesToItems(tables: any[]): { items: ScheduleItem[]; skipped: string[] } {
  const out = new Map<string, ScheduleItem>();
  const skipped: string[] = [];
  for (const t of Array.isArray(tables) ? tables : []) {
    const kind = String(t?.kind ?? "other");
    const title = String(t?.title ?? "").replace(/\s+/g, " ").trim();
    if (["legend", "revision", "notes", "other"].includes(kind)) continue;
    const cols: string[] = (Array.isArray(t?.columns) ? t.columns : []).map((c: any) => String(c ?? "").replace(/\s+/g, " ").trim());
    const rows: string[][] = (Array.isArray(t?.rows) ? t.rows : []).filter((r: any) => Array.isArray(r)).map((r: any[]) => r.map((c) => String(c ?? "").trim()));
    if (!cols.length || !rows.length) continue;
    const idx = (re: RegExp, skip: number[] = []) => cols.map((c, i) => (re.test(c) && !skip.includes(i) ? i : -1)).filter((i) => i >= 0);
    const serial = cols.map((c, i) => (SERIAL_HEAD.test(c) ? i : -1)).filter((i) => i >= 0);
    // Quantity columns: by heading, and by content ("08 Nos.", "13.0 mtr."). A heading that sits over
    // text (a heading shifted by one when the table was copied) is not a quantity column.
    const width = Math.max(cols.length, ...rows.map((r) => r.length));
    const filled = (i: number) => rows.map((r) => r[i] ?? "").filter((v) => v && !/^[-–—/]+$/.test(v));
    const numericShare = (i: number) => { const f = filled(i); return f.length ? f.filter((v) => parseQty(v)).length / f.length : 0; };
    const unitShare = (i: number) => { const f = filled(i); return f.length ? f.filter((v) => QTY_CELL.test(v)).length / f.length : 0; };
    const byHead = idx(QTY_HEAD, serial).filter((i) => (!SPEC_HEAD.test(cols[i]) || /QUANT|QTY/i.test(cols[i])) && numericShare(i) >= 0.5);
    const byContent = Array.from({ length: width }, (_, i) => i).filter((i) => !serial.includes(i) && unitShare(i) >= 0.6);
    const qtyCols = [...new Set([...byHead, ...byContent])].sort((a, b) => a - b);
    const refCols = idx(REF_HEAD, [...serial, ...qtyCols]);
    const descCols = idx(DESC_HEAD, [...serial, ...qtyCols, ...refCols]);
    const sizeCols = idx(SIZE_HEAD, [...serial, ...qtyCols, ...refCols]);
    const specCols = idx(SPEC_HEAD, [...serial, ...qtyCols, ...refCols, ...sizeCols, ...descCols]);
    const locCols = idx(LOC_HEAD, [...serial, ...qtyCols, ...refCols, ...descCols]);
    const equipment = kind === "equipment_schedule" || (refCols.length > 0 && !qtyCols.length);
    if (!qtyCols.length && !(equipment && refCols.length) && !(refCols.length && rows.some((r) => countRefs(refCols.map((i) => r[i] ?? "").join(" ")) > 1))) { skipped.push(title || "untitled table"); continue; }

    // Units listed by reference with ranges ("FCU-02 TO 44"): the references ARE the count, for every row.
    const byRef = refCols.length > 0 && rows.some((r) => countRefs(refCols.map((i) => r[i] ?? "").join(" ")) > 1);
    const carry: Record<number, string> = {};
    for (const r of rows) {
      const cell = (i: number) => {
        const v = r[i] ?? "";
        if (v) carry[i] = v;
        return v || (descCols.includes(i) || locCols.includes(i) ? carry[i] ?? "" : "");
      };
      const desc = descCols.map(cell).filter(Boolean).join(", ");
      const ref = refCols.map(cell).filter(Boolean).join(" ");
      const size = sizeCols.map(cell).filter(Boolean).join(" x ");
      const loc = locCols.map(cell).filter(Boolean).join(", ");
      const fam = familyOf(`${desc} ${ref}`) ?? familyOf(title);
      // Equipment reads "Fan coil unit, ducted, total load 19.33 kW, supply air 1142 L/s": the family name,
      // the unit type if the row gives one, then capacities -- only numeric values, so a heading copied one
      // column off cannot put a word where a kW should be.
      const typeWord = r.map((c) => String(c ?? "")).find((c) => /\b(DUCTED|CASSETTE|WALL[-\s]?MOUNTED|FLOOR[-\s]?STANDING|CONCEALED|EXPOSED|CEILING|HI[-\s]?WALL|VERTICAL|HORIZONTAL)\b/i.test(c));
      const descOk = desc && /[a-z]{3}/i.test(desc) && !/^\d/.test(desc);
      const name = equipment && fam
        ? [cap(fam.name), typeWord ? typeWord.replace(/^[A-Z]{2,5}[-\s]+/i, "").toLowerCase() : "", descOk && !fam.re.test(desc) ? desc.toLowerCase() : ""].filter(Boolean).join(", ")
        : descOk ? cap(desc) : (singularTitle(title) || cap(ref.replace(/[-\s]*\d.*$/, "")) || "Scheduled item");
      const unitOf = (h: string) => (h.match(/\b(KW|L\/S|CFM|W|HP|TR|BTU\/?H?|A|V|M3\/H)\b/i) || [])[1] || "";
      const specBits = equipment ? specCols.map((i) => {
        const v = String(r[i] ?? "").trim();
        if (!/^\d+(\.\d+)?\s*[a-z/%]*$/i.test(v)) return "";
        const head = cols[i].replace(/\(.*?\)/g, "").replace(/\b(KW|L\/S|CFM|W|HP|TR|BTU\/?H?|M3\/H)\b/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
        const u = /[a-z]/i.test(v) ? "" : unitOf(cols[i]);
        return `${head} ${v}${u ? " " + u.replace(/^KW$/i, "kW").replace(/^L\/S$/i, "L/s") : ""}`.trim();
      }).filter(Boolean).slice(0, 4) : [];
      const lines: { q: number; unit: string; side: string }[] = [];
      if (byRef) {
        const n = countRefs(ref);
        if (n > 0) lines.push({ q: n, unit: "nr", side: "" });
      } else if (qtyCols.length) {
        for (const qi of qtyCols) {
          const p = parseQty(r[qi]);
          if (!p) continue;
          const sideWord = String(cols[qi] ?? "").match(/\b(SUPPLY|RETURN|EXHAUST|EXTRACT|FRESH|TRANSFER|SPILL)\b/i);
          const side = qtyCols.length > 1 && sideWord ? cap(sideWord[1]) : "";
          lines.push({ ...p, side });
        }
      } else {
        const n = countRefs(ref);
        if (n > 0) lines.push({ q: n, unit: "nr", side: "" });
      }
      for (const ln of lines) {
        const label = [ln.side, name].filter(Boolean).join(" ");
        const key = [fam?.name ?? label, label.toLowerCase(), size.toLowerCase(), ln.unit, equipment ? specBits.join("|").toLowerCase() : ""].join("§");
        const descr = [label, size, ...specBits].filter(Boolean).join(", ");
        let it = out.get(key);
        if (!it) {
          it = { system_category: fam?.system ?? "other", description: descr, quantity: 0, unit: ln.unit,
                 family: fam?.re ?? new RegExp(`\\b${label.split(" ").pop()!.replace(/[^a-z]/gi, "")}`, "i"),
                 familyName: fam?.name ?? label.toLowerCase(), table: title, rowsUsed: 0, detail: [] };
          out.set(key, it);
        }
        it.quantity = Math.round((it.quantity + ln.q) * 100) / 100;
        it.rowsUsed++;
        it.detail.push(`${[ref, loc].filter(Boolean).join(" ") || "row"}: ${ln.q}${ln.unit === "nr" ? "" : " " + ln.unit}`);
      }
    }
  }
  return { items: [...out.values()], skipped };
}

const COUNT_UNIT = /^(nr|no|nos|pcs|ea|each|point|points|set|sets|unit|units)$/i;
const LENGTH_UNIT = /^(m|lm|rm|mtr|metres?|meters?)$/i;

// Replace the AI's plan count for every kind of item the sheet's own schedule
// quantifies. Only counted / measured lines are replaced; reference rows stay.
export function applyScheduleItems(rows: any[], items: ScheduleItem[], base: any): { rows: any[]; replaced: number; added: number; notes: string[] } {
  if (!items.length) return { rows, replaced: 0, added: 0, notes: [] };
  const notes: string[] = [];
  let out = rows, replaced = 0;
  const byFamily = new Map<string, ScheduleItem[]>();
  for (const it of items) { if (!byFamily.has(it.familyName)) byFamily.set(it.familyName, []); byFamily.get(it.familyName)!.push(it); }
  const added: any[] = [];
  for (const [fname, its] of byFamily) {
    const re = its[0].family;
    const aiGone: any[] = [];
    out = out.filter((r: any) => {
      if (!["physical_count", null, undefined].includes(r.quantity_source_type)) return true;
      const u = String(r.unit || "").trim();
      // a count or a length of the same item: a flow bar the AI counted in "nr" is still the flow bar
      const sameKind = COUNT_UNIT.test(u) || LENGTH_UNIT.test(u);
      if (!sameKind) return true;
      const subj = String(r.description || "").split(/,| with | for | including | per /i)[0];
      // a damper is not a diffuser, a duct is not a grille: match the item, not a word in passing
      if (!re.test(subj) || /\b(duct(work)?|pipe|cable|tray|conduit)\b/i.test(subj)) return true;
      aiGone.push(r);
      return false;
    });
    replaced += aiGone.length;
    const aiTotal = aiGone.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const schedTotal = its.filter((i) => i.unit === "nr").reduce((s, i) => s + i.quantity, 0);
    for (const it of its) {
      added.push({
        ...base, system_category: it.system_category, description: it.description, quantity: it.quantity, unit: it.unit,
        confidence_score: 92, quantity_source_type: "physical_count", coordinates: null, optimization_note: null,
        location: base.floor_label ?? null,
        quantity_basis_notes: `Taken from the drawing's own schedule${it.table ? ` "${it.table.slice(0, 80)}"` : ""}: ${it.detail.slice(0, 8).join("; ")}${it.detail.length > 8 ? " …" : ""}.` +
          (aiGone.length ? ` The AI's count of the plan symbols for ${fname} was ${aiTotal} — the schedule governs; check the plan if they differ a lot.` : ""),
      });
    }
    notes.push(`${fname}: schedule ${schedTotal || its.map((i) => `${i.quantity} ${i.unit}`).join(" + ")} replaces ${aiGone.length} AI line(s) (${aiTotal})`);
  }
  // One controller / thermostat per fan coil unit: flag a count that does not match the FCU schedule.
  const fcuTotal = items.filter((i) => i.system_category === "fcu" && i.unit === "nr").reduce((s, i) => s + i.quantity, 0);
  if (fcuTotal) {
    const ctl = out.filter((r: any) => /\b(ddc|thermostat|controller)\b/i.test(String(r.description || "")) && /\b(fcu|fan\s*coil)\b/i.test(`${r.description} ${r.quantity_basis_notes || ""}`)
      && ["physical_count", null, undefined].includes(r.quantity_source_type));
    const ctlTotal = ctl.reduce((s: number, r: any) => s + (Number(r.quantity) || 0), 0);
    if (ctl.length && ctlTotal !== fcuTotal) {
      for (const r of ctl) {
        r.schedule_quantity_crosscheck = Math.round(fcuTotal);
        r.quantity_basis_notes = [r.quantity_basis_notes, `The FCU schedule lists ${fcuTotal} units, normally one controller each; ${ctlTotal} were counted on the plan. Check before pricing.`].filter(Boolean).join(" ");
      }
      notes.push(`FCU controllers: ${ctlTotal} counted vs ${fcuTotal} FCUs scheduled (flagged)`);
    }
  }
  return { rows: out.concat(added), replaced, added: added.length, notes };
}

// Tiles describe the same item in different words ("Fire Damper (FD), 3-hour..." on one tile,
// "Fire Damper (FD), red bar symbol..." on the next), so the per-tile merge keeps them as separate
// lines. Each tile only counted its own core area, so the lines add up: one line per kind of item.
export function mergeSameKindRows(rows: any[]): { rows: any[]; merged: number } {
  const keyOf = (r: any) => {
    if (!["physical_count", null, undefined].includes(r.quantity_source_type)) return null;
    if (!COUNT_UNIT.test(String(r.unit || "").trim())) return null;
    const subj = String(r.description || "").split(/,| with | for | including | per |\.|\(/i)[0];
    const fam = familyOf(subj);
    if (!fam) {
      const ctl = /\b(ddc|direct\s*digital\s*controller|thermostat)\b/i.test(subj) ? "controller" : null;
      if (!ctl) return null;
      return `${r.system_category}§controller§${String(r.unit).toLowerCase()}`;
    }
    const side = (subj.match(/\b(supply|return|exhaust|extract|fresh|transfer|smoke|motori[sz]ed|fire|volume|square|round|linear)\b/gi) || []).map((w) => w.toLowerCase()).sort().join("+");
    return `${r.system_category}§${fam.name}§${side}§${String(r.unit).toLowerCase().replace(/^(nos|no|ea|each|pcs)$/, "nr")}`;
  };
  const groups = new Map<string, any>();
  const out: any[] = [];
  let merged = 0;
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) { out.push(r); continue; }
    const g = groups.get(k);
    if (!g) { const c = { ...r }; groups.set(k, c); out.push(c); continue; }
    g.quantity = (Number(g.quantity) || 0) + (Number(r.quantity) || 0);
    if (String(r.description || "").length > String(g.description || "").length) g.description = r.description;
    const gc = g.coordinates, rc = r.coordinates;
    if (gc && rc) gc.instances = [...(gc.instances || []), { x: rc.x, y: rc.y }, ...(rc.instances || [])];
    else if (!gc && rc) g.coordinates = rc;
    const c = Number(r.confidence_score), cc = Number(g.confidence_score);
    if (Number.isFinite(c) && (!Number.isFinite(cc) || c < cc)) g.confidence_score = c;
    g.quantity_basis_notes = [g.quantity_basis_notes, `Plus ${r.quantity} counted on another part of the sheet and described differently there.`].filter(Boolean).join(" ");
    merged++;
  }
  return { rows: out, merged };
}
