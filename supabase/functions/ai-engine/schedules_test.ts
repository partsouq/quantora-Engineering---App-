// deno test supabase/functions/ai-engine/schedules_test.ts  (offline: local assert)
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
import { applyScheduleItems, countRefs, mergeSameKindRows, scheduleTablesToItems } from "./schedules.ts";

// The two tables on a real customer HVAC sheet (AC-01), copied as printed.
const DIFFUSERS = {
  title: "SCHEDULE OF SUPPLY & RETURN AIR DIFFUSER'S,REGISTER'S,FLOW BAR & GRILLE'S-GROUND FLOOR", kind: "terminal_schedule",
  columns: ["LOCATION", "DESCRIPTION", "NECK SIZE (mm)", "SUPPLY AIR FLOW", "SUPPLY QUANTITY", "RETURN QUANTITY", "VELOCITY (m/s)", "THROW (m)", "PRESSURE DROP (pa)", "NOISE (db)"],
  rows: [
    ["BACKSTORE", "SQUARE DIFFUSER", "300x300mm", "107 L/s Each", "08 Nos.", "-", "1.5", "4.3-5.0-7.0", "10.5", "<15"],
    ["PANTRY", "SQUARE DIFFUSER", "450x450mm", "288 L/s /m", "02 Nos.", "02 Nos.", "1.5", "", "12.5", "27"],
    ["LOUNGE-LOCKER", "SQUARE DIFFUSER", "300x300mm", "127 L/s Each", "01 No.", "01 No.", "1.5", "", "13", "<15"],
    ["CASH ROOM", "SQUARE DIFFUSER", "225x225mm", "75 L/s Each", "01 No.", "01 No.", "1.5", "", "13", "<15"],
    ["SERVER ROOM", "SQUARE DIFFUSER", "450x450mm", "246 L/s Each", "02 Nos.", "02 Nos.", "1.5", "", "11", "23"],
    ["CORRIDOR - BOH", "SQUARE DIFFUSER", "300x300mm", "81 L/s Each", "02 Nos.", "02 Nos.", "1.0", "", "6", "<15"],
    ["PRAYER ROOM", "SQUARE DIFFUSER", "225x225mm", "71 L/s Each", "01 No.", "01 No.", "1.5", "", "13", "<15"],
    ["MNG'R ROOM", "SQUARE DIFFUSER", "300x300mm", "91 L/s Each", "01 No.", "01 No.", "1.0", "", "6", "<15"],
    ["STORAGE & RETURNS", "SQUARE DIFFUSER", "300x300mm", "122 L/s Each", "02 Nos.", "-", "1.5", "", "12", "<15"],
    ["EDP ROOM", "SQUARE DIFFUSER", "375x375mm", "161 L/s /m", "02 Nos.", "02 Nos.", "1.5", "", "10", "18"],
    ["STORAGE", "SQUARE DIFFUSER", "300x300mm", "87 L/s Each", "02 Nos.", "-", "1.0", "", "6", "<15"],
    ["ELEC'L ROOM-1", "GRILLES & REGISTERS", "800x250mm", "308 L/s Each", "01 No.", "01 No.", "2.5", "", "10", "<20"],
    ["BACKSTORE CORRIDOR", "SQUARE DIFFUSER", "300x300mm", "54 L/s Each", "01 No.", "01 No.", "1.0", "", "6", "<15"],
    ["CASH TILLS", "ROUND DIFFUSER", "ø416 mm", "160 L/s Each", "09 Nos.", "-", "1.52", "", "7", "<15"],
    ["CASH TILLS", "FLOW BAR", "1SLOT x 38mm", "80 L/s /m", "13.0 mtr.", "16.5 mtr.", "1.5", "", "8", "<10"],
    ["CLICK & COLLECT", "SQUARE DIFFUSER", "225x225mm", "44 L/s Each", "02 Nos.", "-", "1.0", "", "6", "<15"],
    ["ELEC'L ROOM-2", "GRILLES & REGISTERS", "800x150mm", "151 L/s Each", "01 No.", "01 No.", "2.5", "", "10", "<20"],
    ["ELEC'L ROOM-3", "GRILLES & REGISTERS", "800x150mm", "152 L/s Each", "01 No.", "01 No.", "2.5", "", "10", "<20"],
    ["RETAIL AREA", "ROUND DIFFUSER", "ø416 mm", "159 L/s Each", "280 Nos.", "-", "1.52", "", "7", "<15"],
    ["RETAIL AREA", "FLOW BAR", "1SLOT x 38mm", "80 L/s /m", "60.0 mtr.", "111.0 mtr.", "1.5", "", "8", "<10"],
    ["RETAIL AREA", "GRILLES & REGISTERS", "800x150mm", "159 L/s Each", "10 Nos.", "-", "2.5", "", "10", "<20"],
  ],
};
const FCUS = {
  title: "CALCULATED FAN COIL UNITS SCHEDULE - HOME CENTRE @ MOE, DUBAI, U.A.E.", kind: "equipment_schedule",
  columns: ["SI. NO.", "FCU REF", "LOCATION", "SPEED", "TOTAL LOAD KW", "SENSIBLE LOAD KW", "SUPPLY AIR L/s", "ON COIL AIR COND DB", "ON COIL AIR COND WB", "OFF COIL DB", "OFF COIL WB", "TYPE OF UNIT"],
  rows: [
    ["1", "FCU-01", "SERVER ROOM", "Medium", "6.92", "6.09", "492", "22.6", "15.9", "12.4", "11.5", "FCU-DUCTED"],
    ["2", "FCU-02 TO 44", "RETAIL AREA", "Medium", "19.33", "16.04", "1142", "23.5", "16.6", "12", "11.4", "FCU-DUCTED"],
  ],
};

const sum = (items: any[], re: RegExp, unit = "nr") => items.filter((i) => re.test(i.description) && i.unit === unit).reduce((s, i) => s + i.quantity, 0);

Deno.test("ranges and lists of references", () => {
  assertEquals(countRefs("FCU-02 TO 44"), 43);
  assertEquals(countRefs("FCU-02 TO FCU-44"), 43);
  assertEquals(countRefs("EF-1~3"), 3);
  assertEquals(countRefs("AHU 1-4"), 4);
  assertEquals(countRefs("FCU-01"), 1);
  assertEquals(countRefs("FCU-1, FCU-3, FCU-7"), 3);
});

Deno.test("HVAC sheet: FCU schedule gives 44 units with their capacities", () => {
  const { items } = scheduleTablesToItems([FCUS]);
  const fcu = items.filter((i) => i.system_category === "fcu");
  assertEquals(fcu.reduce((s, i) => s + i.quantity, 0), 44);
  assertEquals(fcu.length, 2);                                    // 6.92 kW and 19.33 kW kept apart
  assertEquals(fcu.find((i) => i.quantity === 43)!.description.includes("19.33"), true);
});

Deno.test("HVAC sheet: diffusers, grilles and flow bar by size, supply and return", () => {
  const { items } = scheduleTablesToItems([DIFFUSERS]);
  assertEquals(sum(items, /^Supply .*square diffuser/i), 27);
  assertEquals(sum(items, /^Return .*square diffuser/i), 13);
  assertEquals(sum(items, /^Supply .*round diffuser/i), 289);
  assertEquals(sum(items, /^Supply .*grilles/i), 13);
  assertEquals(sum(items, /^Return .*grilles/i), 3);
  assertEquals(sum(items, /^Supply .*flow bar/i, "m"), 73);
  assertEquals(sum(items, /^Return .*flow bar/i, "m"), 127.5);
  // by size: 300x300 supply = 8+1+2+1+2+2+1 = 17
  assertEquals(items.find((i) => /^Supply square diffuser, 300x300mm$/i.test(i.description))!.quantity, 17);
});

Deno.test("schedule replaces the AI's plan count for the same items only", () => {
  const { items } = scheduleTablesToItems([FCUS, DIFFUSERS]);
  const ai = [
    { description: "Proposed Fan Coil Unit with maintenance access platform", quantity: 31, unit: "nr", quantity_source_type: "physical_count", system_category: "hvac" },
    { description: "Supply Air Square Diffuser, 4-way", quantity: 325, unit: "nr", quantity_source_type: "physical_count", system_category: "hvac" },
    { description: "Flow Bar, pink line", quantity: 22, unit: "nr", quantity_source_type: "physical_count", system_category: "hvac" },
    { description: "Supply Air Grille", quantity: 15, unit: "nr", quantity_source_type: "physical_count", system_category: "hvac" },
    { description: "Fire Damper, 2-hour", quantity: 126, unit: "nr", quantity_source_type: "physical_count", system_category: "fire_fighting" },
    { description: "Supply air ductwork, galvanized steel", quantity: 855, unit: "m", quantity_source_type: "physical_count", system_category: "hvac" },
    { description: "Room Thermostat", quantity: 31, unit: "nos", quantity_source_type: "physical_count", system_category: "hvac" },
  ];
  const r = applyScheduleItems(ai, items, { floor_label: "GF" });
  const left = r.rows.filter((x: any) => !String(x.quantity_basis_notes || "").startsWith("Taken from"));
  assertEquals(left.map((x: any) => x.description.split(",")[0]).sort(), ["Fire Damper", "Room Thermostat", "Supply air ductwork"]);
  assertEquals(r.replaced, 4);
});

Deno.test("other disciplines: lighting, sanitary, doors, DBs", () => {
  const { items } = scheduleTablesToItems([
    { title: "LIGHTING FIXTURE SCHEDULE", kind: "fixture_schedule", columns: ["TYPE", "DESCRIPTION", "WATTAGE", "QTY"],
      rows: [["L1", "LED DOWNLIGHT 600x600", "36W", "120"], ["L2", "LED STRIP LIGHT", "14W/m", "45 m"], ["EM", "EMERGENCY LIGHT", "3W", "18"]] },
    { title: "SANITARY FIXTURES", kind: "fixture_schedule", columns: ["S.NO", "ITEM", "QUANTITY"], rows: [["1", "WATER CLOSET", "6"], ["2", "WASH BASIN", "8 Nos"]] },
    { title: "DOOR SCHEDULE", kind: "door_window_schedule", columns: ["MARK", "SIZE", "TYPE", "NO. OF DOORS"], rows: [["D1", "900x2100", "TIMBER DOOR", "12"], ["D2", "1800x2400", "GLASS DOOR", "2"]] },
    { title: "DB SCHEDULE", kind: "equipment_schedule", columns: ["DB REF", "LOCATION", "RATING"], rows: [["DB-GF-01", "ELEC RM", "100A"], ["DB-GF-02", "STORE", "63A"]] },
    { title: "REVISIONS", kind: "revision", columns: ["REV", "DATE", "QTY"], rows: [["01", "1/1/26", "3"]] },
  ]);
  assertEquals(items.filter((i) => i.system_category === "lighting" && i.unit === "nr").reduce((s, i) => s + i.quantity, 0), 138);
  assertEquals(items.find((i) => i.system_category === "lighting" && i.unit === "m")!.quantity, 45);
  assertEquals(items.filter((i) => i.system_category === "fixtures").reduce((s, i) => s + i.quantity, 0), 14);
  assertEquals(items.filter((i) => i.system_category === "doors").reduce((s, i) => s + i.quantity, 0), 14);
  assertEquals(items.filter((i) => i.system_category === "db_panels").reduce((s, i) => s + i.quantity, 0), 2);
  assertEquals(items.some((i) => /rev/i.test(i.table)), false);
});

Deno.test("a table with no quantities gives nothing", () => {
  const { items, skipped } = scheduleTablesToItems([
    { title: "LIGHTING FIXTURE TYPES", kind: "fixture_schedule", columns: ["TYPE", "DESCRIPTION", "WATTAGE"], rows: [["L1", "LED DOWNLIGHT", "36W"]] },
  ]);
  assertEquals(items.length, 0);
  assertEquals(skipped.length, 1);
});

Deno.test("a table copied with its headings shifted still counts right", () => {
  // the AI dropped one heading, so every heading after it sits over the wrong column
  const shifted = { ...FCUS, columns: ["SI. NO.", "FCU REF", "LOCATION", "SPEED", "TOTAL LOAD", "SENSIBLE LOAD", "SUPPLY AIR", "ON COIL DB", "ON COIL WB", "OFF COIL DB", "TYPE OF UNIT", "NO. OF UNITS"],
    rows: [["1", "FCU-01", "SERVER ROOM", "Medium", "6.92", "6.09", "492", "22.6", "15.9", "12.4", "11.5", "FCU-DUCTED", "50"],
           ["2", "FCU-02 TO 44", "RETAIL AREA", "Medium", "19.33", "16.04", "1142", "23.5", "16.6", "12", "11.4", "FCU-DUCTED", "50"]] };
  const { items } = scheduleTablesToItems([shifted]);
  assertEquals(items.filter((i) => i.system_category === "fcu").reduce((s, i) => s + i.quantity, 0), 44);
  const noQtyHeads = { ...DIFFUSERS, columns: ["LOCATION", "DESCRIPTION", "NECK SIZE (mm)", "SUPPLY AIR FLOW", "SUPPLY", "RETURN", "VELOCITY", "THROW", "PD", "NOISE"] };
  const d = scheduleTablesToItems([noQtyHeads]).items;
  assertEquals(sum(d, /^Supply .*round diffuser/i), 289);
  assertEquals(sum(d, /^Return .*flow bar/i, "m"), 127.5);
});

Deno.test("same item described differently on two tiles becomes one line", () => {
  const rows = [
    { description: "Fire Damper (FD), 3-hour fire-rated", quantity: 55, unit: "nr", system_category: "fire_fighting", quantity_source_type: "physical_count" },
    { description: "Fire Damper (FD), red rectangular bar symbol", quantity: 12, unit: "nr", system_category: "fire_fighting", quantity_source_type: "physical_count" },
    { description: "Motorized Smoke Fire Damper, 24VDC", quantity: 4, unit: "nr", system_category: "fire_fighting", quantity_source_type: "physical_count" },
    { description: "Supply Air Grille (SAG), triangle", quantity: 145, unit: "nr", system_category: "hvac", quantity_source_type: "physical_count" },
    { description: "Supply Air Grille (SAG), upward triangle. Size not stated", quantity: 18, unit: "nr", system_category: "hvac", quantity_source_type: "physical_count" },
    { description: "Return Air Grille (RAG)", quantity: 57, unit: "nr", system_category: "hvac", quantity_source_type: "physical_count" },
    { description: "Direct Digital Controller (DDC) for Fan Coil Unit", quantity: 21, unit: "nr", system_category: "bms", quantity_source_type: "physical_count" },
    { description: "Direct Digital Controller (DDC) for FCU control", quantity: 7, unit: "nr", system_category: "bms", quantity_source_type: "physical_count" },
  ];
  const r = mergeSameKindRows(rows);
  const q = (re: RegExp) => r.rows.filter((x: any) => re.test(x.description)).map((x: any) => x.quantity);
  assertEquals(q(/^Fire Damper/), [67]);
  assertEquals(q(/^Motorized/), [4]);
  assertEquals(q(/^Supply Air Grille/), [163]);
  assertEquals(q(/^Return Air Grille/), [57]);
  assertEquals(q(/^Direct Digital/), [28]);
});
