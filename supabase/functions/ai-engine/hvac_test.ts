import { cleanHvacRows, hvacSheetKind } from "./hvac.ts";
function assertEquals(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

Deno.test("sheet kind from the file name", () => {
  assertEquals(hvacSheetKind("CEC-CHW-002.pdf"), "chw");
  assertEquals(hvacSheetKind("CEC-AC-001.pdf"), "air");
  assertEquals(hvacSheetKind("GF-architecture.pdf"), null);
});
Deno.test("pipes as points and crumbs are removed", () => {
  const r = cleanHvacRows([
    { description: "Supply Air Duct, blue double-line duct", unit: "point", quantity: 1, system_category: "hvac" },
    { description: "Insulated flexible duct about 138 mm", unit: "m", quantity: 0.04, system_category: "ducting" },
    { description: "Supply Air Square Diffuser", unit: "nr", quantity: 29, system_category: "hvac" },
  ], "CEC-AC-002.pdf");
  assertEquals(r.rows.length, 1); assertEquals(r.removed, 2);
});
Deno.test("FCU lines merged to the largest count, never summed", () => {
  const r = cleanHvacRows([
    { description: "Fan Coil Unit (FCU), cassette type", unit: "nr", quantity: 6, system_category: "fcu" },
    { description: "Fan Coil Unit (FCU) with valve package, FCU-02-01", unit: "nr", quantity: 1, system_category: "hvac" },
    { description: "Fan Coil Unit, ceiling-mounted cassette type", unit: "nr", quantity: 2, system_category: "hvac" },
    { description: "FCU Control Package FCUCP-21", unit: "set", quantity: 6, system_category: "hvac" },
    { description: "Valve package, chilled water system", unit: "nr", quantity: 4, system_category: "hvac" },
    { description: "Floor drain with trap", unit: "nr", quantity: 1, system_category: "water_supply" },
  ], "CEC-CHW-001.pdf");
  const fcu = r.rows.filter((x: any) => /fan coil/i.test(x.description) && !/package/i.test(x.description));
  assertEquals(fcu.length, 1); assertEquals(fcu[0].quantity, 6); assertEquals(fcu[0].optimization_status, "review_required");
  assertEquals(r.rows.filter((x: any) => /package/i.test(x.description)).length, 1);
  assertEquals(r.rows.find((x: any) => /floor drain/i.test(x.description)).system_category, "drainage");
});
Deno.test("thermostats above the FCU count are flagged, not changed", () => {
  const r = cleanHvacRows([
    { description: "Fan Coil Unit (FCU) chilled water type", unit: "nr", quantity: 3, system_category: "hvac" },
    { description: "Room Thermostat/Controller", unit: "nos", quantity: 10, system_category: "hvac" },
  ], "CEC-CHW-002.pdf");
  const t = r.rows.find((x: any) => /thermostat/i.test(x.description));
  assertEquals(t.quantity, 10); assertEquals(t.optimization_status, "review_required");
});
Deno.test("a non-HVAC sheet keeps its count lines", () => {
  const rows = [{ description: "CCTV camera", unit: "nr", quantity: 12, system_category: "cctv" }, { description: "Cable tray 300 mm", unit: "point", quantity: 1, system_category: "containment" }];
  assertEquals(cleanHvacRows(rows, "ELV-GF.pdf").rows.length, 2);
});
