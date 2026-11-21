// BOQ check agent (2026-11-21, owner approved, zero cost). Every finished take-off is checked by rules
// (no AI, no cost) within a few minutes: junk lines are removed, exact duplicates merged (largest count,
// never the sum), suspicious lines marked "check this line" with the reason, and the sheet gets a score.
// Mismatches go to the admin (Admin -> Platform alerts); the owner decides any further action.

export type Row = { id: string; description?: string; unit?: string; quantity?: number | string; system_category?: string;
  confidence_score?: number | string; optimization_status?: string; optimization_note?: string | null; location?: string | null; page?: number | null };
export type Check = { deleteIds: string[]; updates: { id: string; patch: Record<string, unknown> }[]; issues: string[]; score: number; total: number; checked: number };

const LINEAR = /\b(pipe|piping|duct|ducting|cable|cabling|tray|trunking|conduit|ladder|busbar|busway|wire)\b/i;
const POINT_UNIT = /^(point|points|pt|pts)$/i;
const LEN = /^(m|lm|rm|rmt)$/i;
const AREA = /^(m2|m²|sqm)$/i;
const COUNT = /^(nr|no|nos|ea|each|set|sets|pcs|unit|units|point|points)$/i;
const FAMILIES: [string, RegExp][] = [["duct", /\bduct/i], ["pipe", /\bpip(e|ing)\b/i], ["cable", /\bcabl/i], ["tray", /\btray\b|\bladder\b/i], ["conduit", /\bconduit/i]];

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const q = (r: Row) => Number(r.quantity ?? 0);
const note = (r: Row, why: string) => (r.optimization_note ? `${r.optimization_note} ` : "") + `Check this line: ${why}`;

export function checkBoq(rows: Row[]): Check {
  const del = new Set<string>(); const upd = new Map<string, Record<string, unknown>>(); const issues: string[] = [];
  const flag = (r: Row, why: string) => { const p = upd.get(r.id) || {}; upd.set(r.id, { ...p, optimization_status: "review_required", optimization_note: note({ ...r, optimization_note: (p.optimization_note as string) ?? r.optimization_note }, why) }); };
  const live = () => rows.filter((r) => !del.has(r.id));

  // 1. junk: a pipe / duct / cable counted as "points"; crumbs under half a metre; zero lines nobody asked to review
  for (const r of rows) {
    const u = String(r.unit || "").trim(), d = String(r.description || "");
    if (POINT_UNIT.test(u) && LINEAR.test(d)) { del.add(r.id); continue; }
    if (LEN.test(u) && q(r) > 0 && q(r) < 0.5) { del.add(r.id); continue; }
    if (!(q(r) > 0) && r.optimization_status !== "review_required") { del.add(r.id); continue; }
  }
  if (del.size) issues.push(`${del.size} junk line(s) removed (lengths given as points, pieces under 0.5 m, or zero quantities).`);

  // 2. exact duplicates (same wording, unit and system): one line, the largest quantity, never the sum
  const groups = new Map<string, Row[]>();
  for (const r of live()) { const k = `${norm(r.description || "")}|${String(r.unit || "").toLowerCase()}|${r.system_category || ""}|${norm(r.location || "")}|${r.page ?? ""}`; groups.set(k, [...(groups.get(k) || []), r]); }
  let dups = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = g.reduce((a, b) => (q(b) > q(a) ? b : a));
    for (const r of g) if (r !== keep) { del.add(r.id); dups++; }
    flag(keep, `the same item was listed ${g.length} times (${g.map(q).join(", ")}); kept the largest.`);
  }
  if (dups) issues.push(`${dups} duplicate line(s) merged (largest kept).`);

  // 3. the same family measured in both length and area (e.g. ducts in m and m2): cannot be added up
  for (const [fam, re] of FAMILIES) {
    const rs = live().filter((r) => re.test(r.description || ""));
    const hasLen = rs.some((r) => LEN.test(String(r.unit || ""))), hasArea = rs.some((r) => AREA.test(String(r.unit || "")));
    if (hasLen && hasArea) { rs.filter((r) => LEN.test(String(r.unit || ""))).forEach((r) => flag(r, `other ${fam} lines on this sheet are in m2; this one is a length.`)); issues.push(`${fam} measured in both m and m2.`); }
  }

  // 4. quantities far outside what one sheet can hold
  for (const r of live()) {
    const u = String(r.unit || "");
    if ((COUNT.test(u) && q(r) > 1500) || (LEN.test(u) && q(r) > 20000) || (AREA.test(u) && q(r) > 100000)) { flag(r, `${q(r)} ${u} is unusually large for one sheet.`); issues.push(`Unusually large quantity: ${String(r.description || "").slice(0, 50)} = ${q(r)} ${u}.`); }
  }

  // 5. sheet-level signs
  const lv = live();
  const low = lv.filter((r) => Number(r.confidence_score) > 0 && Number(r.confidence_score) < 60).length;
  if (lv.length && low / lv.length > 0.4) issues.push(`${low} of ${lv.length} lines have low AI confidence (under 60%).`);
  if (lv.length > 0 && lv.length < 3) issues.push(`Only ${lv.length} line(s) on this sheet: check nothing was missed.`);

  const flagged = [...upd.keys()].filter((id) => !del.has(id)).length;
  const touched = del.size + flagged;
  let score = rows.length ? Math.round(100 * (1 - touched / rows.length)) : 0;
  if (lv.length && low / lv.length > 0.4) score -= 10;
  if (lv.length > 0 && lv.length < 3) score -= 20;
  score = Math.max(0, Math.min(100, score));
  return { deleteIds: [...del], updates: [...upd.entries()].filter(([id]) => !del.has(id)).map(([id, patch]) => ({ id, patch })), issues, score, total: rows.length, checked: lv.length };
}
