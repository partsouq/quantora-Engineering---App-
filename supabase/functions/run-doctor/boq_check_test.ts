import { checkBoq } from "./boq_check.ts";
function eq(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

Deno.test("junk removed, duplicates merged to the largest", () => {
  const c = checkBoq([
    { id: "1", description: "Supply Air Duct, blue double-line", unit: "point", quantity: 1, system_category: "hvac" },
    { id: "2", description: "Insulated flexible duct", unit: "m", quantity: 0.04, system_category: "ducting" },
    { id: "3", description: "Return Air Square Diffuser", unit: "nr", quantity: 30, system_category: "hvac" },
    { id: "4", description: "Return air square diffuser", unit: "nr", quantity: 28, system_category: "hvac" },
    { id: "5", description: "Volume control damper", unit: "nr", quantity: 32, system_category: "hvac" },
  ]);
  eq(c.deleteIds.sort(), ["1", "2", "4"]);
  eq(c.updates.map((u) => u.id), ["3"]);
  eq(c.checked, 2);
});
Deno.test("ducts in m and m2 are flagged, quantities untouched", () => {
  const c = checkBoq([
    { id: "a", description: "GI rectangular duct 300 mm wide, height not shown", unit: "m", quantity: 133, system_category: "ducting" },
    { id: "b", description: "GI rectangular duct 400x400 mm", unit: "m2", quantity: 93, system_category: "ducting" },
    { id: "c", description: "Supply diffuser", unit: "nr", quantity: 65, system_category: "hvac" },
  ]);
  eq(c.deleteIds, []); eq(c.updates.map((u) => u.id), ["a"]);
  if (!c.issues.some((i) => /duct measured in both/.test(i))) throw new Error("no unit issue");
});
Deno.test("a clean BOQ scores 100", () => {
  const c = checkBoq([
    { id: "x", description: "CCTV camera, dome", unit: "nr", quantity: 12, system_category: "cctv", confidence_score: 95 },
    { id: "y", description: "Cat6 cable", unit: "m", quantity: 640, system_category: "cctv", confidence_score: 80 },
    { id: "z", description: "NVR 32 channel", unit: "nr", quantity: 1, system_category: "cctv", confidence_score: 90 },
  ]);
  eq(c.score, 100); eq(c.issues, []);
});
Deno.test("a thin sheet and huge quantity are reported", () => {
  const c = checkBoq([{ id: "p", description: "Smoke detector", unit: "nr", quantity: 5000, system_category: "fire_alarm" }]);
  if (c.score >= 80) throw new Error("score should drop"); if (c.issues.length < 2) throw new Error("issues missing");
});
