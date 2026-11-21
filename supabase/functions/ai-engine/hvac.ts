// HVAC / chilled-water clean-up (2026-11-21). Runs after the AI has read a sheet and before the BOQ is saved.
// Found on a real customer's AC and chilled-water sheets:
//   - pipes and ducts given as "1 point" instead of a length,
//   - fan coil units and valve packages listed in several overlapping lines (double counting),
//   - crumbs such as a 0.04 m flexible duct,
//   - a floor drain filed under water supply on a chilled-water sheet,
//   - large ducts with only a width (no height), so no duct area could be worked out.
// Nothing here invents a quantity: lines are removed, merged (keeping the largest count, never adding) or
// flagged for the estimator to check.

const LINEAR = /\b(pipe|piping|duct|ducting|cable|tray|trunking|conduit|run|line)\b/i;
const POINT_UNIT = /^(point|points|pt|pts)$/i;
const LENGTH_UNIT = /^(m|lm|rm)$/i;
const FCU = /\bfan\s*coil|\bFCU\b/i;
const NOT_FCU_ITSELF = /control\s*package|valve\s*package|valve|thermostat|controller|drain|insulation|pipe|strainer|\bFCUCP\b/i;
const VALVE_PACKAGE = /\b(valve|control)\s*package\b|\bFCUCP\b|\bVP\b/i;
const THERMOSTAT = /thermostat|room\s*controller/i;

export function hvacSheetKind(name: string): "chw" | "air" | null {
  const t = String(name || "").toUpperCase();
  if (/\bCHW|CHILLED/.test(t)) return "chw";
  if (/\bAC\b|[-_ ]AC[-_ .]|HVAC|DUCT|VENTIL|AIR\s*COND|\bMV\b/.test(t)) return "air";
  return null;
}

const isCount = (r: any) => /^(nr|no|nos|ea|each|set|sets|pcs|unit|units)$/i.test(String(r.unit || "").trim());
const flag = (r: any, note: string) => ({ ...r, optimization_status: "review_required", optimization_note: r.optimization_note ? `${r.optimization_note} ${note}` : note, confidence_score: Math.min(Number(r.confidence_score) || 60, 60) });

export function cleanHvacRows(rows: any[], sheetName: string): { rows: any[]; removed: number; merged: number; flagged: number; moved: number } {
  const kind = hvacSheetKind(sheetName);
  let out = rows, removed = 0, merged = 0, flagged = 0, moved = 0;
  const hvacRow = (r: any) => /^(hvac|ducting|fcu|chilled_water|ventilation|air_conditioning)$/i.test(String(r.system_category || "")) || !!kind;

  // 1. a pipe or duct counted as "points" is not a quantity; 2. crumbs under half a metre
  out = out.filter((r: any) => {
    const u = String(r.unit || "").trim(), d = String(r.description || "");
    if (hvacRow(r) && POINT_UNIT.test(u) && LINEAR.test(d)) { removed++; return false; }
    if (LENGTH_UNIT.test(u) && Number(r.quantity) > 0 && Number(r.quantity) < 0.5) { removed++; return false; }
    return true;
  });

  if (kind) {
    // 3. fan coil units listed in several lines: one line, the largest count (never the sum), checked by the estimator
    const fcus = out.filter((r: any) => isCount(r) && FCU.test(r.description || "") && !NOT_FCU_ITSELF.test(r.description || ""));
    if (fcus.length > 1) {
      const keep = fcus.reduce((a: any, b: any) => (Number(b.quantity) > Number(a.quantity) ? b : a));
      const counts = fcus.map((r: any) => Number(r.quantity)).join(", ");
      out = out.filter((r: any) => !fcus.includes(r) || r === keep).map((r: any) => r === keep
        ? flag(r, `The AI listed fan coil units in ${fcus.length} lines (${counts}); kept the largest count so none is counted twice. Check the FCU types against the schedule.`)
        : r);
      merged += fcus.length - 1; flagged++;
    }
    // 4. valve / control packages in several lines: same rule
    const vps = out.filter((r: any) => isCount(r) && VALVE_PACKAGE.test(r.description || ""));
    if (vps.length > 1) {
      const keep = vps.reduce((a: any, b: any) => (Number(b.quantity) > Number(a.quantity) ? b : a));
      const counts = vps.map((r: any) => Number(r.quantity)).join(", ");
      out = out.filter((r: any) => !vps.includes(r) || r === keep).map((r: any) => r === keep
        ? flag(r, `Valve / control packages were listed in ${vps.length} lines (${counts}); kept the largest count.`) : r);
      merged += vps.length - 1; flagged++;
    }
    // 5. more thermostats than fan coil units on the sheet: flag, do not change
    const fcuN = out.filter((r: any) => isCount(r) && FCU.test(r.description || "") && !NOT_FCU_ITSELF.test(r.description || "")).reduce((s: number, r: any) => s + Number(r.quantity || 0), 0);
    out = out.map((r: any) => {
      if (fcuN > 0 && THERMOSTAT.test(r.description || "") && Number(r.quantity) > fcuN) { flagged++; return flag(r, `${r.quantity} thermostats against ${fcuN} fan coil units on this sheet: check.`); }
      return r;
    });
    // 6. no water supply on an HVAC sheet: a drain is condensate drainage
    out = out.map((r: any) => {
      if (r.system_category === "water_supply" && /drain|trap|gull(e)?y/i.test(r.description || "")) { moved++; return { ...r, system_category: "drainage" }; }
      return r;
    });
    // 7. a duct with only its width cannot be priced by area: say so
    out = out.map((r: any) => {
      if (/\bduct\b/i.test(r.description || "") && /height not (shown|given|stated)/i.test(r.description || "") && r.optimization_status !== "review_required") {
        flagged++; return flag(r, "Only the duct width is on the drawing, so this is a length. Add the height (from the section or schedule) to price it by area.");
      }
      return r;
    });
  }
  return { rows: out, removed, merged, flagged, moved };
}

export const HVAC_PROMPT = `
HVAC AND CHILLED WATER: every pipe, duct and refrigerant line is a LENGTH in metres per size (never a count of "points"); measure each chilled-water flow / return run by diameter. List each fan coil unit type once, with its total count (never the same units again under another wording), and the valve / control packages once. Condensate drains are drainage, not water supply.`;
