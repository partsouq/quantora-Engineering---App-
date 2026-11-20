// Plumbing sheets (2026-11-20). Plumbing drawings tag every fixture (WC-1, L-1, FD-3, SHD-1, EW-2 ...)
// and every cleanout (WCO, FCO, COTG) in real PDF text, and the set's own legend says what each
// abbreviation means (SS = sanitary sewer, V = vent, EW = eyewash). The browser reads both and sends
// them with each sheet; here they
//   1. tell the AI what the set's abbreviations mean (no more "2\" V" read as cold water),
//   2. replace the AI's fixture and cleanout lines with exact counts of the tags on the sheet,
//   3. keep a waste / sanitary / vent sheet out of water supply.

export type PlumbingInfo = {
  counts: Record<string, number>;             // "WC-1" -> 2, "WCO" -> 9
  positions: Record<string, [number, number][]>;
  legend: Record<string, string>;             // "SS" -> "SANITARY SEWER; STAINLESS STEEL"
  title: string;                              // sheet title, e.g. "WASTE PLAN FIRST FLOOR - BLOCK 1B"
};

// Fixture codes: tag = CODE-number. Cleanouts are written bare.
export const PLUMBING_FIXTURES: Record<string, { name: string; system: string; ai: RegExp }> = {
  WC:  { name: "Water closet", system: "fixtures", ai: /\bwater\s*closet|\bWC\b|\bWC[-\s]?\d|toilet\b|\bw\.?c\.?\s/i },
  UR:  { name: "Urinal", system: "fixtures", ai: /\burinal|\bUR[-\s]?\d/i },
  L:   { name: "Lavatory", system: "fixtures", ai: /\blavator|wash\s*-?\s*basin|hand\s*basin|\bL[-\s]\d/i },
  S:   { name: "Sink", system: "fixtures", ai: /(^|[^a-z])sink\b|\bS[-\s]\d/i },
  MS:  { name: "Mop sink", system: "fixtures", ai: /\bmop\s*sink|\bMS[-\s]?\d/i },
  SH:  { name: "Shower", system: "fixtures", ai: /\bshower\b(?!\s*drain)|\bSH[-\s]?\d/i },
  BT:  { name: "Bathtub", system: "fixtures", ai: /\bbath\s*tub|\bBT[-\s]?\d/i },
  EW:  { name: "Eyewash", system: "fixtures", ai: /\beye\s*-?\s*wash|\bEW[-\s]?\d|water\s*heater\s*connection/i },
  EWC: { name: "Electric water cooler", system: "fixtures", ai: /\bwater\s*cooler|drinking\s*fountain|\bEWC[-\s]?\d/i },
  DF:  { name: "Drinking fountain", system: "fixtures", ai: /\bdrinking\s*fountain|\bDF[-\s]?\d/i },
  FD:  { name: "Floor drain", system: "drainage", ai: /\bfloor\s*(drain|waste)|\bFD[-\s]?\d|\bFD\b/i },
  FS:  { name: "Floor sink", system: "drainage", ai: /\bfloor\s*sink|\bFS[-\s]?\d/i },
  SHD: { name: "Shower drain", system: "drainage", ai: /\bshower\s*drain|\bSHD[-\s]?\d/i },
  AD:  { name: "Area drain", system: "drainage", ai: /\barea\s*drain|\bAD[-\s]?\d/i },
  RD:  { name: "Roof drain", system: "drainage", ai: /\broof\s*drain|\bRD[-\s]?\d/i },
  HB:  { name: "Hose bibb", system: "water_supply", ai: /\bhose\s*bib|\bHB[-\s]?\d/i },
  WH:  { name: "Wall hydrant", system: "water_supply", ai: /\bwall\s*hydrant|\bWH[-\s]?\d/i },
};
export const PLUMBING_CLEANOUTS: Record<string, { name: string; ai: RegExp }> = {
  WCO:  { name: "Wall cleanout", ai: /\bWCO\b|wall\s*clean\s*-?\s*out/i },
  FCO:  { name: "Floor cleanout", ai: /\bFCO\b|floor\s*clean\s*-?\s*out/i },
  COTG: { name: "Cleanout to grade", ai: /\bCOTG\b|clean\s*-?\s*out\s*to\s*grade/i },
};
const ANY_CLEANOUT = /\bclean\s*-?\s*out|\bWCO\b|\bFCO\b|\bCOTG\b/i;
export const PLUMBING_TAG_RE = /^(WC|UR|L|S|MS|SH|BT|EW|EWC|DF|FD|FS|SHD|AD|RD|HB|WH)-(\d{1,3}[A-Z]?)$/;
export const PLUMBING_BARE = /^(WCO|FCO|COTG)$/;

export function validatePlumbing(raw: any): PlumbingInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.counts || {})) {
    const tag = String(k).toUpperCase().trim(), n = Math.round(Number(v));
    if (!(PLUMBING_TAG_RE.test(tag) || PLUMBING_BARE.test(tag)) || !(n >= 1 && n <= 2000)) continue;
    counts[tag] = n;
  }
  const positions: Record<string, [number, number][]> = {};
  for (const [k, v] of Object.entries(raw.positions || {})) {
    if (!counts[k] || !Array.isArray(v)) continue;
    positions[k] = (v as any[]).slice(0, 2000).map((p) => [Number(p?.[0]), Number(p?.[1])] as [number, number])
      .filter((p) => p.every((x) => Number.isFinite(x) && x >= 0 && x <= 1));
  }
  const legend: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.legend || {}).slice(0, 400)) {
    const code = String(k).toUpperCase().trim(), meaning = String(v ?? "").replace(/\s+/g, " ").trim();
    if (/^[A-Z0-9]{1,6}$/.test(code) && meaning.length >= 2 && meaning.length <= 80) legend[code] = meaning;
  }
  const title = String(raw.title ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!Object.keys(counts).length && !Object.keys(legend).length) return null;
  return { counts, positions, legend, title };
}

// A sheet that carries only waste, sanitary, soil or vent piping.
export function isDrainageOnlySheet(title: string): boolean {
  const t = String(title || "").toUpperCase();
  return /\b(WASTE|SANITARY|SOIL|DRAINAGE|VENT)\b/.test(t) && !/\b(DOMESTIC|WATER\s+(PLAN|SUPPLY|PIPING|DISTRIBUTION)|COLD|HOT|SUPPLY)\b/.test(t);
}

export function plumbingPromptText(p: PlumbingInfo | null): string {
  if (!p) return "";
  const keys = Object.keys(p.legend);
  const pick = keys.filter((k) => /^(SS|V|VTR|SD|SAN|W|CW|HW|HWR|DCW|DHW|DHWR|NPW|EW|EWC|WCO|FCO|COTG|CO|FD|FS|SHD|L|S|WC|UR|MS|DF|HB|AD|RD|IW|GW|AAV|DN|UP|BFF|AFF|IE)$/.test(k));
  const lines = pick.slice(0, 60).map((k) => `${k} = ${p.legend[k]}`);
  let t = "";
  if (lines.length) t += `\n\nABBREVIATIONS FROM THIS DRAWING SET'S OWN PLUMBING LEGEND (use these meanings, never guess): ${lines.join("; ")}.`;
  if (isDrainageOnlySheet(p.title)) t += `\nThis sheet is "${p.title}": it shows waste / sanitary / vent piping only. Put pipes and fittings under drainage (vent pipes as drainage vent). Do not list any water-supply item from this sheet.`;
  if (Object.keys(p.counts).length) t += `\nFixture and cleanout tags on this sheet are counted exactly from the drawing text; still list them, they will be replaced by the exact counts.`;
  return t;
}

const COUNT_UNIT = /^(nr|no|nos|pcs|ea|each|point|points|set|unit|units)$/i;
const isCountRow = (r: any) => COUNT_UNIT.test(String(r.unit || "").trim());
const rowText = (r: any) => `${r.description || ""} ${r.quantity_basis_notes || ""}`;

export function applyPlumbingTags(rows: any[], p: PlumbingInfo | null, base: any, pageNo: number): { rows: any[]; replaced: number; moved: number; dropped: number; counted: Record<string, number> } {
  if (!p) return { rows, replaced: 0, moved: 0, dropped: 0, counted: {} };
  let out = rows, replaced = 0, moved = 0, dropped = 0;
  const counted: Record<string, number> = {};
  const codesPresent = new Set<string>();
  for (const tag of Object.keys(p.counts)) { const m = PLUMBING_TAG_RE.exec(tag); codesPresent.add(m ? m[1] : tag); }

  // 1. drainage-only sheet: no water supply on it
  if (isDrainageOnlySheet(p.title)) {
    const keep: any[] = [];
    for (const r of out) {
      if (r.system_category === "water_supply" || r.system_category === "hot_water") {
        const isPipe = /^(m|lm)$/i.test(String(r.unit || "").trim());
        if (isPipe || !r.quantity_basis_notes) { dropped++; continue; }      // a pipe here is drainage already listed; an unexplained accessory is not on the sheet
        keep.push({ ...r, system_category: "drainage" }); moved++; continue;
      }
      keep.push(r);
    }
    out = keep;
  }

  // 2. fixtures and cleanouts: the tags on the sheet replace the AI's lines
  const fixtureCodes = [...codesPresent].filter((c) => PLUMBING_FIXTURES[c]);
  const anyCleanout = [...codesPresent].some((c) => PLUMBING_CLEANOUTS[c]);
  const before = out.length;
  out = out.filter((r: any) => {
    if (!isCountRow(r)) return true;
    const txt = rowText(r);
    if (anyCleanout && ANY_CLEANOUT.test(r.description || "")) return false;
    for (const c of fixtureCodes) {
      // EW must not take the water-cooler line (EWC), and the reverse
      if (c === "EW" && /\bwater\s*cooler|\bEWC\b/i.test(r.description || "") && !/eye\s*-?\s*wash/i.test(r.description || "")) {
        if (codesPresent.has("EWC")) return false;
        continue;
      }
      if (PLUMBING_FIXTURES[c].ai.test(r.description || "") || new RegExp(`\\b${c}[-\\s]\\d`).test(txt)) return false;
    }
    return true;
  });
  replaced = before - out.length;

  const tags = Object.keys(p.counts).sort();
  for (const tag of tags) {
    const m = PLUMBING_TAG_RE.exec(tag), code = m ? m[1] : tag;
    const fx = PLUMBING_FIXTURES[code], co = PLUMBING_CLEANOUTS[code];
    if (!fx && !co) continue;
    const meaning = p.legend[code] ? p.legend[code].split(";")[0].trim() : (fx ? fx.name : co!.name);
    const name = meaning.charAt(0).toUpperCase() + meaning.slice(1).toLowerCase();
    const n = p.counts[tag];
    const pts = p.positions[tag] || [];
    const coords = pts.length ? { page: pageNo, x: pts[0][0] - 0.006, y: pts[0][1] - 0.006, width: 0.012, height: 0.012,
      instances: pts.slice(1).map((q) => ({ x: q[0] - 0.006, y: q[1] - 0.006 })), tags: pts.map(() => tag) } : null;
    counted[tag] = n;
    out = out.concat([{ ...base, system_category: fx ? fx.system : "drainage", description: m ? `${name}, type ${tag} (as fixture schedule)` : name,
      quantity: n, unit: "nr", confidence_score: 97, quantity_source_type: "physical_count", coordinates: coords, __coords: coords,
      optimization_note: null, location: base.floor_label ?? null,
      quantity_basis_notes: `Counted from the tags on the drawing: ${n} × "${tag}"${p.legend[code] ? ` (legend: ${code} = ${p.legend[code]})` : ""}. Tags in the title block and legend are not counted.` }]);
  }
  return { rows: out, replaced, moved, dropped, counted };
}
