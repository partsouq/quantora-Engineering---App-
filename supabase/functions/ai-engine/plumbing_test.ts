// deno test supabase/functions/ai-engine/plumbing_test.ts  (offline: local assert)
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
import { validatePlumbing, applyPlumbingTags, isDrainageOnlySheet, plumbingPromptText } from "./plumbing.ts";

const legend = { SS: "SANITARY SEWER; STAINLESS STEEL", V: "VENT, VOLTS", EW: "EYEWASH", EWC: "ELECTRIC WATER COOLER", WCO: "WALL CLEANOUT",
  FCO: "FLOOR CLEANOUT", COTG: "CLEANOUT TO GRADE", FD: "FLOOR DRAIN", L: "LAVATORY", S: "SINK", WC: "WATER CLOSET; WATER COLUMN" };
// tags on sheet PW113 (waste plan, block 1B) as read from the PDF text
const pw113 = validatePlumbing({ title: "WASTE PLAN FIRST FLOOR - BLOCK 1B", legend,
  counts: { "WC-1": 2, "L-1": 4, "L-2": 3, "FD-3": 2, "SHD-1": 2, "FCO": 2, "COTG": 1, "WCO": 9, "EW-2": 4, "EWC-1": 2, "S-3": 1, "S-5": 1, "S-7": 1 } })!;
const r = (system_category: string, description: string, quantity: number, unit = "nr", basis = "Counted on this tile") =>
  ({ system_category, description, quantity, unit, quantity_basis_notes: basis, quantity_source_type: unit === "m" ? "calculated_quantity" : "physical_count" });
// the AI's lines for PW113 (from the live run)
const ai = [
  r("drainage", "Clean-out access point, corridor location (CORR 1BC1)", 1),
  r("drainage", "Equipment waste connection point EW-2", 1),
  r("drainage", "Floor Cleanout (FCO) - brass or bronze body", 1), r("drainage", "Floor Cleanout (FCO), brass/bronze body", 1), r("drainage", "Floor Cleanout (FCO), stainless steel cover", 1),
  r("drainage", "Floor Drain with trap, stainless steel grate", 2), r("drainage", "Floor Drain, 3\" diameter, stainless steel grating (FD-3)", 2),
  r("drainage", "Horizontal drainage pipe, 4\" stainless steel", 42, "m"),
  r("drainage", "Hub drain connection point for ice maker equipment", 1),
  r("drainage", "Shower Drain (SHD-1), floor drain with strainer", 1),
  r("drainage", "Water Closet Connection (WCO), drainage connection point for water closet", 2),
  r("water_supply", "Cold water supply pipe 2\" V (50mm nominal diameter)", 18, "m"),
  r("water_supply", "Electric Water Cooler (EWC-1, EW-2), wall-mounted", 2),
  r("water_supply", "Electric Water Heater connection, type 2 (EW 2)", 2),
  r("water_supply", "Flexible Connector Hose", 6, "nos", ""),
  r("water_supply", "Junction Box/Connection Point (JC-1 / JC 1F06)", 2),
  r("water_supply", "Lavatory/Sink Connection Point (L-1)", 4),
  r("water_supply", "Lavatory/Wash Basin (L-1, L-2), wall-hung", 5),
  r("water_supply", "Stainless steel water supply piping 4\" SS", 42, "m"),
  r("water_supply", "Water Closet (WC), wall-hung or floor-mounted", 6),
];

Deno.test("sheet type", () => {
  assertEquals(isDrainageOnlySheet("WASTE PLAN FIRST FLOOR - BLOCK 1B"), true);
  assertEquals(isDrainageOnlySheet("DOMESTIC WATER PLAN FIRST FLOOR"), false);
  assertEquals(isDrainageOnlySheet("PLUMBING PLAN"), false);
});

Deno.test("PW113: tags replace fixture lines, no water supply on a waste sheet", () => {
  const out = applyPlumbingTags(ai, pw113, { floor_label: "Level 1" }, 4);
  const q = (re: RegExp) => out.rows.filter((x) => re.test(x.description)).reduce((s, x) => s + x.quantity, 0);
  assertEquals(q(/^Water closet/), 2);
  assertEquals(q(/^Lavatory/), 7);
  assertEquals(q(/^Floor drain/), 2);
  assertEquals(q(/^Shower drain/), 2);
  assertEquals(q(/^Floor cleanout/), 2);
  assertEquals(q(/^Wall cleanout/), 9);
  assertEquals(q(/^Cleanout to grade/), 1);
  assertEquals(q(/^Eyewash/), 4);
  assertEquals(q(/^Electric water cooler/), 2);
  assertEquals(q(/^Sink/), 3);
  // no water supply left, the duplicated 42 m pipe and the "2\" V" cold water are gone
  assertEquals(out.rows.filter((x) => x.system_category === "water_supply").length, 0);
  assertEquals(out.rows.filter((x) => /42/.test(String(x.quantity))).length, 1);
  assertEquals(out.rows.some((x) => /Water Heater|corridor location|Flexible Connector/i.test(x.description)), false);
  // kept: the drainage pipe, the hub drain
  assertEquals(out.rows.some((x) => /Horizontal drainage pipe/.test(x.description)), true);
  assertEquals(out.rows.some((x) => /Hub drain/.test(x.description)), true);
});

Deno.test("no plumbing info: rows unchanged", () => {
  assertEquals(applyPlumbingTags(ai, null, {}, 1).rows.length, ai.length);
});

Deno.test("prompt carries the set's own meanings", () => {
  const t = plumbingPromptText(pw113);
  assertEquals(/SS = SANITARY SEWER/.test(t) && /V = VENT/.test(t) && /EW = EYEWASH/.test(t) && /waste \/ sanitary \/ vent piping only/.test(t), true);
});

Deno.test("validation drops junk", () => {
  const v = validatePlumbing({ counts: { "WC-1": 2, "CAM-1": 3, "X": 1, "L-1": -2 }, legend: { "SS": "SANITARY SEWER", "bad key!": "x" }, title: "T" })!;
  assertEquals(Object.keys(v.counts), ["WC-1"]);
  assertEquals(Object.keys(v.legend), ["SS"]);
});
