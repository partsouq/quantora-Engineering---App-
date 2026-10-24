// deno test supabase/functions/ai-engine/civil_rules_test.ts
// Reference quantities worked by hand; tolerance 0.01 in the line's unit.
// Local asserts: the test runs offline, with no package download.
function assert(c: unknown, msg = "assertion failed"): asserts c { if (!c) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
import { evalQuantityFormula, measureLine, pickRule, standardForProject, type Rule } from "./civil_rules.ts";

const R = (std: string, code: string, cat: string, unit: string, extra: Partial<Rule> = {}): Rule => ({
  standard: std, edition: null, rule_code: `${std}-${code}`, work_category: cat, item_type: null, unit,
  measurement_basis: "test", deduct_openings: false, deduction_threshold: null, deduction_unit: null,
  rounding_dp: 2, verification_status: "unverified", ...extra,
});
const RULES: Rule[] = [
  R("BASE", "MA-01", "masonry", "m2", { deduct_openings: true, deduction_threshold: 0.5, deduction_unit: "m2" }),
  R("BASE", "SK-01", "skirting", "m", { deduct_openings: true, deduction_threshold: 0, deduction_unit: "m" }),
  R("BASE", "FF-01", "floor_finishes", "m2"),
  R("BASE", "CO-01", "concrete", "m3"),
  R("BASE", "RE-01", "reinforcement", "kg"),
  R("POMI", "MA-01", "masonry", "m2", { deduct_openings: true, deduction_threshold: 0.5, deduction_unit: "m2" }),
  R("POMI", "SK-01", "skirting", "m", { deduct_openings: true, deduction_threshold: 0, deduction_unit: "m" }),
  R("NRM2", "MA-01", "masonry", "m2", { deduct_openings: true, deduction_threshold: 1.0, deduction_unit: "m2", verification_status: "verified" }),
  R("POMI", "PA-01", "partitions", "m2", { deduct_openings: true, deduction_threshold: 0.5, deduction_unit: "m2", verification_status: "withdrawn" }),
];
const UAE = { country: "UAE" };
const NRM = { country: "UK", measurement_standard: "NRM2", measurement_edition: "2nd edition" };
const near = (a: number | null, b: number) => assert(a !== null && Math.abs(a - b) <= 0.01, `${a} != ${b}`);

Deno.test("arithmetic: area, length, volume, weight, count", () => {
  near(evalQuantityFormula("6.2*3.0"), 18.6);
  near(evalQuantityFormula("2*(6.20+4.80)-0.90"), 21.1);
  near(evalQuantityFormula("1.80*1.80*0.60*12"), 23.328);
  near(evalQuantityFormula("120*0.888"), 106.56);           // Y12 bars, kg
  near(evalQuantityFormula("14"), 14);
  assertEquals(evalQuantityFormula("2*(6+"), null);
  assertEquals(evalQuantityFormula("alert(1)"), null);
  assertEquals(evalQuantityFormula("1/0"), null);
});

Deno.test("standard: project setting wins; country is a stated fallback", () => {
  assertEquals(standardForProject(NRM).standard, "NRM2");
  assertEquals(standardForProject(NRM).source, "project");
  assertEquals(standardForProject({ country: "India" }).standard, "IS1200");
  assertEquals(standardForProject({ country: "UAE" }).source, "country_default");
  assertEquals(standardForProject({ country: "Azerbaijan" }).standard, "POMI");
  assertEquals(standardForProject({ country: "India", measurement_standard: "POMI" }).standard, "POMI");
});

Deno.test("opening deduction threshold: door deducted, small window not", () => {
  const m = measureLine({ system_category: "masonry", unit: "m2", description: "200 mm blockwork",
    gross_formula: "6*3", deductions: [{ description: "door D1", formula: "0.9*2.1" }, { description: "window W3", formula: "0.6*0.6" }],
    confidence_score: 90 }, RULES, standardForProject(UAE));
  near(m.gross_quantity, 18);
  near(m.deduction_quantity, 1.89);
  near(m.quantity, 16.11);
  assertEquals(m.deductions!.map((d) => d.applied), [true, false]);
  assertEquals(m.measurement_rule_code, "POMI-MA-01");
  assertEquals(m.validation_status, "calculated_review_required");
});

Deno.test("different standard, different threshold (NRM2 test rule 1.0 m2)", () => {
  const m = measureLine({ system_category: "masonry", unit: "m2", description: "blockwork",
    gross_formula: "6*3", deductions: [{ description: "opening", formula: "0.9*1.0" }], confidence_score: 92 }, RULES, standardForProject(NRM));
  near(m.quantity, 18);                                  // 0.9 m2 is under the 1.0 m2 threshold
  assertEquals(m.validation_status, "verified");          // verified rule + contractual standard + read dimensions
});

Deno.test("verified needs all three: rule, contract standard, read dimensions", () => {
  const m = measureLine({ system_category: "masonry", unit: "m2", description: "blockwork", gross_formula: "6*3",
    confidence_score: 70 }, RULES, standardForProject(NRM));
  assertEquals(m.validation_status, "calculated_review_required");
});

Deno.test("skirting: every doorway deducted", () => {
  const m = measureLine({ system_category: "skirting", unit: "m", description: "skirting",
    gross_formula: "2*(6.2+4.8)", deductions: [{ description: "door", formula: "0.9" }], confidence_score: 88 }, RULES, standardForProject(UAE));
  near(m.quantity, 21.1);
});

Deno.test("gross, net and the AI's own sum kept apart", () => {
  const m = measureLine({ system_category: "masonry", unit: "m2", description: "blockwork",
    gross_formula: "10*3", deductions: [{ description: "door", formula: "1*2.1" }], quantity_formula: "30", confidence_score: 90 }, RULES, standardForProject(UAE));
  near(m.gross_quantity, 30); near(m.quantity, 27.9);
  assert(m.validation_notes.includes("AI's own net working gave 30"));
});

Deno.test("missing rule for the project standard -> base rule, flagged", () => {
  const m = measureLine({ system_category: "floor_finishes", unit: "m2", description: "porcelain tiles", quantity_formula: "4*5", confidence_score: 90 },
    RULES, standardForProject(UAE));
  near(m.quantity, 20);
  assertEquals(m.measurement_rule_code, "BASE-FF-01");
  assertEquals(m.validation_status, "rule_not_configured");
});

Deno.test("no rule anywhere -> Rule Not Configured, quantity still from the working", () => {
  const m = measureLine({ system_category: "glazing", unit: "m2", description: "shopfront glazing", quantity_formula: "3*2.4", confidence_score: 90 },
    RULES, standardForProject(UAE));
  near(m.quantity, 7.2);
  assertEquals(m.measurement_rule_code, null);
  assertEquals(m.validation_status, "rule_not_configured");
});

Deno.test("withdrawn rule is never used", () => {
  const p = pickRule(RULES, "POMI", "partitions", "m2", "gypsum partition");
  assertEquals(p.rule, null);
});

Deno.test("missing dimensions -> Information Required", () => {
  const m = measureLine({ system_category: "concrete", unit: "m3", description: "C35 footing", quantity: 0, confidence_score: 40 }, RULES, standardForProject(UAE));
  assertEquals(m.validation_status, "information_required");
});

Deno.test("scaled / assumed dimension -> Assumption-Based", () => {
  const m = measureLine({ system_category: "masonry", unit: "m2", description: "blockwork", gross_formula: "12*3",
    quantity_basis_notes: "height assumed 3.0 m, not shown on plan", confidence_score: 55 }, RULES, standardForProject(UAE));
  assertEquals(m.validation_status, "assumption_based");
});

Deno.test("conflicting documents -> Drawing Discrepancy", () => {
  const m = measureLine({ system_category: "masonry", unit: "m2", description: "blockwork", gross_formula: "6*3",
    discrepancy: "plan shows 200 mm, schedule shows 150 mm", confidence_score: 90 }, RULES, standardForProject(UAE));
  assertEquals(m.validation_status, "drawing_discrepancy");
});

Deno.test("negative working is clamped to zero and flagged", () => {
  const m = measureLine({ system_category: "concrete", unit: "m3", description: "slab", quantity_formula: "2-5", confidence_score: 90 }, RULES, standardForProject(UAE));
  assertEquals(m.quantity, 0);
  assertEquals(m.validation_status, "information_required");
});
