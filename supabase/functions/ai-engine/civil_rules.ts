// ===========================================================================
// Civil & Architectural Estimator -- measurement rules engine (24 Oct 2026).
//
// The AI reads the drawing: what each item is, its dimensions, its gross working
// and each opening. Everything after that is deterministic and lives here:
//   * which method of measurement governs the project (the project's own setting,
//     else the country's usual method -- and then it says it was assumed),
//   * which rule in public.civil_measurement_rules applies to each line,
//   * gross quantity, each deduction and whether the rule deducts it, net quantity,
//   * the validation status and the reason, in words a QS can act on.
// No rule is invented here: a line with no configured rule says so.
// Pure functions only, so tests run without a database (civil_rules_test.ts).
// ===========================================================================

export type Rule = {
  standard: string; edition: string | null; rule_code: string; work_category: string; item_type: string | null;
  unit: string; measurement_basis: string; deduct_openings: boolean; deduction_threshold: number | null;
  deduction_unit: string | null; rounding_dp: number; verification_status: string; version?: number;
};

export type StandardChoice = { standard: string; edition: string | null; label: string; source: "project" | "country_default" };

export const VALIDATION = {
  verified: "Verified",
  calculated_review_required: "Calculated — Review Required",
  assumption_based: "Assumption-Based",
  information_required: "Information Required",
  rule_not_configured: "Rule Not Configured",
  drawing_discrepancy: "Drawing Discrepancy",
} as const;
export type ValidationStatus = keyof typeof VALIDATION;

const MEASURED_UNITS = ["m", "m2", "m3", "kg", "t"];

// --------------------------------------------------------------------- arithmetic
// Numbers, + - * / and brackets only; anything else returns null.
export function evalQuantityFormula(src: unknown): number | null {
  if (typeof src !== "string") return null;
  const s = src.replace(/[×x]/g, "*").replace(/÷/g, "/").replace(/,/g, "").trim();
  if (!s || s.length > 2000 || /[^0-9.+\-*/()\s]/.test(s)) return null;
  let i = 0;
  const peek = () => { while (s[i] === " " || s[i] === "\t" || s[i] === "\n") i++; return s[i]; };
  const num = (): number => {
    peek();
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error("number expected");
    i += m[0].length;
    return Number(m[0]);
  };
  const factor = (): number => {
    const c = peek();
    if (c === "-") { i++; return -factor(); }
    if (c === "+") { i++; return factor(); }
    if (c === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error(") expected"); i++; return v; }
    return num();
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v *= factor(); }
      else if (c === "/") { i++; const d = factor(); if (d === 0) throw new Error("divide by zero"); v /= d; }
      else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  };
  try {
    const v = expr();
    if (peek() !== undefined) return null;
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  } catch { return null; }
}

const round = (v: number, dp: number) => { const f = 10 ** Math.max(0, Math.min(4, dp)); return Math.round(v * f) / f; };

// ------------------------------------------------------------- governing standard
const clean = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const STANDARD_ALIASES: Record<string, string> = {
  "pomi": "POMI", "principles of measurement international": "POMI", "principles of measurement (international)": "POMI",
  "nrm2": "NRM2", "nrm 2": "NRM2", "nrm": "NRM2", "rics nrm2": "NRM2", "new rules of measurement": "NRM2",
  "is1200": "IS1200", "is 1200": "IS1200", "is-1200": "IS1200",
  "cesmm": "CESMM4", "cesmm4": "CESMM4", "smm7": "SMM7", "asmm": "ASMM", "smm2": "SMM2", "hksmm4": "HKSMM4",
  "asaqs": "ASAQS", "base": "BASE",
};

const COUNTRY_STANDARD: [string[], string, string][] = [
  [["uae", "united arab emirates", "ae", "emirates", "ksa", "saudi arabia", "saudi", "sa", "qatar", "qa", "kuwait", "kw",
    "bahrain", "bh", "oman", "om", "philippines", "ph"], "POMI", "POMI"],
  [["india", "in", "bharat"], "IS1200", "IS 1200"],
  [["uk", "united kingdom", "great britain", "gb", "england", "scotland", "wales", "northern ireland", "ireland", "ie", "pakistan", "pk"], "NRM2", "RICS NRM2"],
  [["australia", "au", "new zealand", "nz"], "ASMM", "ASMM"],
  [["singapore", "sg"], "SMM-SG", "SMM for Building Works (Singapore)"],
  [["malaysia", "my"], "SMM2", "SMM2 (Malaysia)"],
  [["hong kong", "hk", "hksar"], "HKSMM4", "HKSMM4"],
  [["south africa", "za", "rsa"], "ASAQS", "ASAQS"],
  [["sri lanka", "srilanka", "lk"], "ICTAD", "ICTAD (CIDA) method of measurement"],
  [["bangladesh", "bd"], "PWD-BD", "PWD Schedule of Rates method"],
  [["us", "usa", "united states", "united states of america", "america", "canada", "ca"], "CSI", "CSI MasterFormat"],
];

/** The method of measurement this project is taken off to. Country is only a fallback, and says so. */
export function standardForProject(project: any): StandardChoice {
  const stated = clean(project?.measurement_standard);
  if (stated) {
    const code = STANDARD_ALIASES[stated] ?? String(project.measurement_standard).trim().toUpperCase().replace(/\s+/g, "");
    return { standard: code, edition: project?.measurement_edition ? String(project.measurement_edition) : null,
             label: String(project.measurement_standard).trim(), source: "project" };
  }
  const c = clean(project?.country);
  const hit = COUNTRY_STANDARD.find(([names]) => names.includes(c));
  return { standard: hit ? hit[1] : "POMI", edition: null, label: hit ? hit[2] : "POMI", source: "country_default" };
}

// ------------------------------------------------------------------- rule lookup
export function pickRule(rules: Rule[], standard: string, category: string, unit: string, description: string):
    { rule: Rule | null; fallback: boolean; unitsForCategory: string[] } {
  const live = rules.filter((r) => r.verification_status !== "withdrawn");
  const matchIn = (std: string) => {
    const cands = live.filter((r) => r.standard === std && r.work_category === category && r.unit === unit);
    const typed = cands.find((r) => {
      if (!r.item_type) return false;
      try { return new RegExp(r.item_type, "i").test(description); } catch { return false; }
    });
    return typed ?? cands.find((r) => !r.item_type) ?? null;
  };
  const own = matchIn(standard);
  if (own) return { rule: own, fallback: false, unitsForCategory: [] };
  const units = [...new Set(live.filter((r) => r.standard === standard && r.work_category === category).map((r) => r.unit))];
  const base = standard === "BASE" ? null : matchIn("BASE");
  return { rule: base, fallback: !!base, unitsForCategory: units };
}

// ------------------------------------------------------------- applying the rule
export type MeasuredLine = {
  quantity: number;
  gross_quantity: number | null;
  deduction_quantity: number | null;
  deductions: { description: string; formula: string | null; qty: number | null; applied: boolean; reason: string }[] | null;
  calc_formula: string | null;
  measurement_standard: string;
  measurement_rule_code: string | null;
  validation_status: ValidationStatus;
  validation_notes: string;
  basis_suffix: string;
};

const ASSUMED = /\b(approx|approximately|assum(e|ed|ing)|estimated|scaled|typical height|not shown|not given|taken as)\b/i;

/**
 * Measure one civil line under the governing rule.
 * item: the AI row (unit, system_category, description, quantity, quantity_formula,
 *       gross_formula, deductions[{description, formula}], confidence_score,
 *       quantity_basis_notes, discrepancy).
 */
export function measureLine(item: any, rules: Rule[], choice: StandardChoice): MeasuredLine {
  const unit = String(item.unit ?? "").trim();
  const category = String(item.system_category ?? "other");
  const description = String(item.description ?? "");
  const { rule, fallback, unitsForCategory } = pickRule(rules, choice.standard, category, unit, description);
  const dp = rule?.rounding_dp ?? 2;
  const notes: string[] = [];
  const stdName = choice.edition ? `${choice.label} ${choice.edition}` : choice.label;

  // gross and each deduction, all by our own arithmetic
  const grossFormula = typeof item.gross_formula === "string" && item.gross_formula.trim() ? item.gross_formula.trim() : null;
  const gross = evalQuantityFormula(grossFormula);
  const rawDeds: any[] = Array.isArray(item.deductions) ? item.deductions : [];
  const deductions = rawDeds.map((d) => {
    const formula = typeof d?.formula === "string" ? d.formula : (typeof d?.qty === "number" ? String(d.qty) : null);
    const qty = evalQuantityFormula(formula);
    let applied = false, reason = "";
    if (qty === null) { reason = "working could not be read, not deducted"; }
    else if (!rule) { applied = true; reason = "deducted as shown (no rule configured to test it against)"; }
    else if (!rule.deduct_openings) { applied = true; reason = `deducted as shown; ${rule.rule_code} sets no opening threshold`; }
    else if (rule.deduction_unit === "m" || unit === "m") { applied = qty > (rule.deduction_threshold ?? 0); reason = applied ? `doorway / gap deducted (${rule.rule_code})` : "zero width, not deducted"; }
    else {
      const t = rule.deduction_threshold ?? 0;
      applied = qty > t;
      reason = applied ? `opening over ${t} m2, deducted (${rule.rule_code})` : `opening of ${t} m2 or less, not deducted (${rule.rule_code})`;
    }
    return { description: String(d?.description ?? "opening"), formula, qty, applied, reason };
  });

  const stated = evalQuantityFormula(item.quantity_formula);
  let net: number;
  let grossOut: number | null = null, dedOut: number | null = null, formulaOut: string | null = null;
  if (gross !== null) {
    const ded = deductions.filter((d) => d.applied && d.qty !== null).reduce((s, d) => s + (d.qty as number), 0);
    grossOut = round(gross, dp);
    dedOut = round(ded, dp);
    net = round(Math.max(0, gross - ded), dp);
    formulaOut = deductions.length
      ? `${grossFormula} - (${deductions.filter((d) => d.applied).map((d) => d.formula).join(" + ") || "0"})`
      : grossFormula;
    if (stated !== null && Math.abs(stated - net) > Math.max(0.01, Math.abs(net) * 0.01)) {
      notes.push(`The AI's own net working gave ${stated}; the quantity is ${net} after applying the deduction rule.`);
    }
  } else if (stated !== null) {
    net = round(Math.max(0, stated), dp);
    grossOut = deductions.length ? null : net;
    formulaOut = String(item.quantity_formula);
    if (deductions.length) notes.push("Openings were listed but no gross working was given, so the deduction rule could not be applied; the quantity is the AI's net working.");
  } else {
    net = round(Math.max(0, Number(item.quantity) || 0), dp);
  }
  if ((gross !== null && gross < 0) || (stated !== null && stated < 0)) notes.push("The working came out negative and was set to 0.");

  // status, most serious first
  let status: ValidationStatus;
  const basis = String(item.quantity_basis_notes ?? "");
  const conf = Number(item.confidence_score ?? 0);
  const measured = MEASURED_UNITS.includes(unit);
  if (item.discrepancy) {
    status = "drawing_discrepancy";
    notes.unshift(`Drawing discrepancy: ${String(item.discrepancy)}. Confirm which document governs before pricing.`);
  } else if (measured && gross === null && stated === null) {
    status = "information_required";
    notes.unshift("No working was given for this measured item. Provide the dimensions (or the drawing that shows them) so it can be calculated.");
  } else if (measured && net === 0) {
    status = "information_required";
    notes.unshift("The quantity is 0: the drawing gives the specification but not how many / how much. Provide the number of repetitions or the extent.");
  } else if (!rule && unit !== "item") {
    status = "rule_not_configured";
    notes.unshift(`No ${stdName} rule is configured for ${category.replace(/_/g, " ")} measured in ${unit}` +
      (unitsForCategory.length ? ` (configured units for this work: ${unitsForCategory.join(", ")}).` : ".") +
      " The quantity is calculated from the working shown; configure the rule in the measurement rule library before relying on it.");
  } else if (fallback) {
    status = "rule_not_configured";
    notes.unshift(`${stdName} has no rule configured for this item; measured to the Quantora base rule ${rule!.rule_code}. Configure the ${stdName} rule before relying on it.`);
  } else if (ASSUMED.test(basis) || conf < 60) {
    status = "assumption_based";
    notes.unshift("Depends on an assumed or scaled dimension (see the working). Confirm the dimension from the drawings.");
  } else if (rule && rule.verification_status === "verified" && choice.source === "project" && conf >= 85) {
    status = "verified";
  } else {
    status = "calculated_review_required";
    const why: string[] = [];
    if (rule && rule.verification_status !== "verified") why.push(`rule ${rule.rule_code} has not yet been verified by a QS`);
    if (choice.source === "country_default") why.push(`the project does not state its method of measurement, so ${stdName} was assumed from the country`);
    if (conf < 85) why.push("the dimensions are not all read directly from the drawing");
    notes.unshift(`Calculated; review required${why.length ? ` because ${why.join("; ")}` : ""}.`);
  }

  const dedText = deductions.length
    ? ` Deductions: ${deductions.map((d) => `${d.description} ${d.qty ?? "?"}${d.applied ? "" : " (not deducted)"}`).join("; ")}.`
    : "";
  const basisSuffix = `[${stdName}${choice.source === "country_default" ? " (assumed from country)" : ""}` +
    `${rule ? `, rule ${rule.rule_code}${rule.verification_status === "verified" ? "" : " (unverified)"}` : ", no rule configured"}` +
    `${grossOut !== null ? `; gross ${grossOut} ${unit}` : ""}${dedOut ? `, deductions ${dedOut} ${unit}` : ""}; net ${net} ${unit}.${dedText}]`;

  return {
    quantity: net, gross_quantity: grossOut, deduction_quantity: dedOut,
    deductions: deductions.length ? deductions : null, calc_formula: formulaOut,
    measurement_standard: choice.edition ? `${choice.standard} ${choice.edition}` : choice.standard,
    measurement_rule_code: rule?.rule_code ?? null,
    validation_status: status, validation_notes: notes.join(" "), basis_suffix: basisSuffix,
  };
}

/** One line for the prompt: the method of measurement and the project's own preambles. */
export function civilStandardPrompt(project: any, choice: StandardChoice): string {
  const pre = String(project?.boq_preambles ?? "").trim();
  return `\nMethod of measurement: ${choice.source === "project"
    ? `the contract states ${choice.label}${choice.edition ? ` ${choice.edition}` : ""}.`
    : `the project does not state one; ${choice.label} is assumed from the country (${project?.country ?? "not stated"}) and every line will say so.`}` +
    (pre ? `\nPROJECT BOQ PREAMBLES / MEASUREMENT NOTES (these take precedence over the general measurement rules below where they differ):\n${pre.slice(0, 4000)}\n` : "\n");
}
