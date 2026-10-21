// AI Construction Engineering Platform — AI Engine Edge Function
// Actions: analyze_drawing | analyze_drawing_tiled | design_system | rework | chat | classify_pages
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

const ACTUAL_INPUT_PER_MTOK_USD = 3.0;
const ACTUAL_OUTPUT_PER_MTOK_USD = 15.0;
const MARKUP_MULTIPLIER = 3;
const CUSTOMER_INPUT_PER_MTOK_USD = ACTUAL_INPUT_PER_MTOK_USD * MARKUP_MULTIPLIER;
const CUSTOMER_OUTPUT_PER_MTOK_USD = ACTUAL_OUTPUT_PER_MTOK_USD * MARKUP_MULTIPLIER;

const MAX_CLASSIFY_PAGES = 300;

// One wording, used by analyze_drawing, rework and the combined-analysis call,
// so the three cannot drift apart -- they previously said three different
// things about the same field, and only one of them mentioned omitting.
//
// The hard part of drawing markup is not drawing the boxes, it is getting a
// model to admit when it cannot see something. Left to itself it produces a
// neat, evenly-spaced, entirely fictional set of positions, which looks more
// convincing than a sparse honest one. Hence the explicit anti-patterns.
const MARKUP_COORDS_INSTRUCTION = [
  'Fill in "coordinates" so the user can see every item highlighted on the drawing itself.',
  'Put the first symbol in x/y and EVERY other occurrence of the same item in coordinates.instances[]',
  '-- an item with quantity 12 should carry 12 positions in total, not 1, because the estimator needs',
  'to see where all twelve are. Keep each box tight around the symbol (about 0.01-0.03 of the page for',
  'a device); a box the size of a room tells them nothing.',
  'Leave coordinates out completely for anything you cannot actually locate on the page -- schedule and',
  'legend rows, general notes, quantities read off a table rather than counted on the plan. A marker',
  'pointing at empty floor is worse than no marker. Never invent evenly-spaced or round-numbered',
  'positions to make the set look complete.'
].join(" ");

// ---------------------------------------------------------------------------
// Tiled take-off helpers
// ---------------------------------------------------------------------------

type TileSpec = {
  path: string;
  row: number;
  col: number;
  // The tile's footprint on the full page, as fractions of page width/height.
  x0: number; y0: number; x1: number; y1: number;
  // The tile's "core": the sub-rectangle this tile is responsible for, in
  // fractions OF THE TILE. Outside the core is overlap that a neighbour owns.
  core_x0: number; core_y0: number; core_x1: number; core_y1: number;
};

// Hard ceiling on tiles per run. The browser picks the grid, and the browser is
// user-controlled, so this is a cost guard rather than a formatting preference:
// without it a crafted request could bill an unbounded number of Claude calls.
const MAX_TILES_PER_RUN = 24;
// How many tile calls are in flight at once. Sequential would blow the
// background-task wall clock on a 12-tile sheet; unbounded would trip
// Anthropic's rate limit and fail the whole run on a 429.
const TILE_CONCURRENCY = 5;
const TILE_MAX_OUTPUT_TOKENS = 12000;

function validateTiles(raw: any): TileSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("No tiles were supplied for a tiled analysis.");
  if (raw.length > MAX_TILES_PER_RUN) {
    throw new Error(`This request contains ${raw.length} tiles, over the ${MAX_TILES_PER_RUN}-tile limit for a single sheet. Render the sheet at a lower resolution or analyse fewer pages at once.`);
  }
  return raw.map((t: any, i: number) => {
    const num = (v: any, name: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Tile ${i} has an invalid ${name} (${v}); tile geometry must be page fractions between 0 and 1.`);
      return n;
    };
    if (typeof t?.path !== "string" || !t.path) throw new Error(`Tile ${i} has no storage path.`);
    return {
      path: t.path,
      row: Number(t.row) || 0,
      col: Number(t.col) || 0,
      x0: num(t.x0, "x0"), y0: num(t.y0, "y0"), x1: num(t.x1, "x1"), y1: num(t.y1, "y1"),
      core_x0: num(t.core_x0 ?? 0, "core_x0"), core_y0: num(t.core_y0 ?? 0, "core_y0"),
      core_x1: num(t.core_x1 ?? 1, "core_x1"), core_y1: num(t.core_y1 ?? 1, "core_y1"),
    };
  });
}

// Runs `worker` over every item with at most `limit` in flight. Written out
// rather than pulled from a library because edge functions pay for every byte
// of cold start and this is nine lines.
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // Once any runner throws the caller is going to reject anyway, so the other
  // runners must stop taking new work -- otherwise a sheet that fails on tile 2
  // still pays Anthropic for tiles 3 through 12.
  let failed = false;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// A reference panel reported in tile fractions, expressed on the page.
function panelToPageRect(p: any, tile: TileSpec): { x0: number; y0: number; x1: number; y1: number } | null {
  const x = Number(p?.x), y = Number(p?.y), w = Number(p?.width), h = Number(p?.height);
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null;
  if (w <= 0 || h <= 0) return null;
  const tw = tile.x1 - tile.x0, th = tile.y1 - tile.y0;
  if (!(tw > 0) || !(th > 0)) return null;
  // A panel claiming to cover essentially the whole tile is not information --
  // honouring it would delete every device found there.
  if (w >= 0.98 && h >= 0.98) return null;
  return {
    x0: tile.x0 + Math.max(0, x) * tw,
    y0: tile.y0 + Math.max(0, y) * th,
    x1: tile.x0 + Math.min(1, x + w) * tw,
    y1: tile.y0 + Math.min(1, y + h) * th,
  };
}

function pointInAnyRect(pt: any, rects: { x0: number; y0: number; x1: number; y1: number }[]): boolean {
  const x = Number(pt?.x), y = Number(pt?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
}

// Drops device positions that fall inside a legend, key, schedule or title block,
// AND takes the count that came with them.
//
// The original version kept the quantity and dropped only the coordinates, on the
// reasoning that deleting a line "would change the take-off on the strength of a
// box the model drew". Deleting still would, and this does not delete. But the
// position and the count are one observation: a position rejected for sitting
// inside the legend is evidence about the legend, not about the building. Keeping
// its count is how a row ends up claiming a PoE injector that appears nowhere on
// the plan -- measured on this database, every single unmarked device came from
// exactly this path.
//
//   every position inside a panel -> reclassified "legend_reference", an existing
//     NON-COUNTABLE source type. The row stays visible and auditable, the
//     consolidation layer excludes it from totals, and the UI already labels it
//     "Legend Reference (not counted)".
//   some positions inside panels  -> quantity reduced by exactly that many, with
//     the original preserved in the basis note.
// The model routinely describes a typical detail correctly in quantity_basis_notes
// and then files the row as physical_count anyway, so the count reaches the BOQ
// total. Same failure shape as the legend positions: right reasoning, wrong field.
//
// Narrow on purpose. "typical detail" / "typical cross-section" / "representative
// section" are captions on a repeated construction detail. "typical floor plan"
// and "typical practice" are ordinary MEP phrasings for things that ARE countable,
// and must not match. This only ever moves a row to a NON-counting classification;
// it can never invent or raise a quantity.
const TYPICAL_DETAIL_PHRASES = [
  /\btypical\s+(?:cross[-\s]?section|section|detail)\b/i,
  /\brepresentative\s+(?:cross[-\s]?section|section|detail)\b/i,
  /\bshown\s+(?:on|in)\s+(?:a\s+)?typical\b/i,
];
// A file that is not a drawing is not a failed analysis -- it is the wrong input,
// and the customer needs to know where the right place is. Reporting "completed,
// 0 items" makes them run it again, which is exactly what a customer did seven
// times in four minutes.
function wrongFileKindMessage(kind: string, notes: string): string | null {
  const tail = notes ? ` What was read: ${String(notes).slice(0, 400)}` : "";
  if (kind === "specification") {
    return "This file is a written specification, not a drawing — there is no layout on it to measure. " +
      "Upload it on the Specification page instead: Quantora reads specifications clause by clause and lists every " +
      "requirement with the page and clause it came from, which is what a document like this is for." + tail;
  }
  if (kind === "schedule") {
    return "This file is a schedule or table with no drawing to measure against. A schedule on its own cannot be " +
      "counted safely — the same equipment usually also appears on a layout, and counting both is how a BOQ doubles. " +
      "Upload the layout drawing it belongs to, and the schedule will be used to cross-check it." + tail;
  }
  if (kind === "other") {
    return "No drawing content was found in this file — it looks like a cover page, transmittal or similar. " +
      "Please upload the layout, plan or section sheets." + tail;
  }
  return null;
}

function reclassifyTypicalDetailRows(items: any[]): number {
  let changed = 0;
  for (const it of items) {
    if ((it.quantity_source_type ?? "physical_count") !== "physical_count") continue;
    const text = `${it.quantity_basis_notes ?? ""} ${it.optimization_note ?? ""}`;
    if (!TYPICAL_DETAIL_PHRASES.some((re) => re.test(text))) continue;
    it.quantity_source_type = "typical_detail_reference";
    it.quantity_basis_notes = [
      it.quantity_basis_notes,
      "Recorded as a typical-detail reference rather than an installed quantity: the note above describes a typical or representative detail, which shows how the item is built once, not how many are in the project. Excluded from the take-off total until a real count or a length/spacing rule is available.",
    ].filter(Boolean).join(" ");
    changed++;
  }
  return changed;
}

function stripPositionsInPanels(items: any[], panels: { x0: number; y0: number; x1: number; y1: number }[]): number {
  if (!panels.length) return 0;
  let dropped = 0;
  for (const it of items) {
    const c = it.coordinates;
    if (!c || c.x == null) continue;
    const all = [{ x: c.x, y: c.y, width: c.width, height: c.height },
                 ...(Array.isArray(c.instances) ? c.instances : [])];
    let droppedHere = 0;
    const kept = all.filter((p) => {
      const inside = pointInAnyRect(p, panels);
      if (inside) { dropped++; droppedHere++; }
      return !inside;
    });

    if (!kept.length) {
      it.coordinates = null;
      // Only a count that claimed to be a physical observation is downgraded --
      // a schedule or note row never claimed a position in the first place.
      if ((it.quantity_source_type ?? "physical_count") === "physical_count") {
        it.quantity_source_type = "legend_reference";
        it.quantity_basis_notes = [
          it.quantity_basis_notes,
          `Every position reported for this item fell inside a legend, key plan or title block, so it is recorded as a legend reference and excluded from the take-off total rather than counted as ${it.quantity ?? 0} installed device(s). Reclassify it if these are genuinely installed on the plan.`,
        ].filter(Boolean).join(" ");
      }
      continue;
    }

    const [head, ...rest] = kept;
    it.coordinates = { ...c, ...head, instances: rest };

    if (droppedHere > 0 && (it.quantity_source_type ?? "physical_count") === "physical_count") {
      const was = Number(it.quantity);
      if (Number.isFinite(was) && was > 0) {
        const now = Math.max(0, was - droppedHere);
        if (now !== was) {
          it.quantity = now;
          it.quantity_basis_notes = [
            it.quantity_basis_notes,
            `Reduced from ${was} to ${now}: ${droppedHere} of the reported position(s) fell inside a legend, key plan or title block, where a symbol is a reference and not an installed device.`,
          ].filter(Boolean).join(" ");
        }
      }
    }
  }
  return dropped;
}

// A tile reports positions as fractions OF THE TILE. Everything downstream --
// the markup overlay, the exports -- works in fractions of the PAGE, so
// convert here, once, at the boundary.
function tileToPageCoords(coords: any, tile: TileSpec, pageNumber: number): any {
  if (!coords || typeof coords !== "object") return null;
  const w = tile.x1 - tile.x0, h = tile.y1 - tile.y0;
  if (!(w > 0) || !(h > 0)) return null;
  const conv = (p: any) => {
    if (!p || typeof p !== "object") return null;
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const out: any = {
      x: Math.min(1, Math.max(0, tile.x0 + x * w)),
      y: Math.min(1, Math.max(0, tile.y0 + y * h)),
    };
    const pw = Number(p.width), ph = Number(p.height);
    if (Number.isFinite(pw)) out.width = Math.min(1, Math.max(0, pw * w));
    if (Number.isFinite(ph)) out.height = Math.min(1, Math.max(0, ph * h));
    return out;
  };
  const head = conv(coords);
  if (!head) return null;
  const instances = Array.isArray(coords.instances)
    ? coords.instances.map(conv).filter(Boolean)
    : [];
  return { page: pageNumber, ...head, instances };
}

function normaliseDesc(v: any): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Distance below which two same-named devices of the same system are treated as
// one symbol seen twice through a seam. 1.2% of the page diagonal is about
// 12mm on an A1 sheet -- comfortably tighter than the spacing between two real
// devices, and comfortably wider than the coordinate jitter between two tiles
// describing the same symbol.
const DUP_RADIUS = 0.012;

// The identity a tile's row is grouped by. `legend_item` is the legend's own
// wording and is identical across every tile that saw the same device, which is
// the whole point -- the model's free-text description is not, and matching on it
// is why the previous version merged nothing at all.
function tileGroupKey(it: any): string {
  const sys = String(it.system_category ?? "other");
  const legendName = normaliseDesc(it.legend_item);
  // Countability is part of the identity. stripPositionsInPanels runs first and can
  // reclassify a row to legend_reference; without this, that row would group with
  // the real physical counts for the same legend item and the merged line would
  // inherit whichever source type arrived first -- either hiding a real count or
  // letting a legend count back into the total.
  const countable = (it.quantity_source_type ?? "physical_count") === "physical_count"
    || it.quantity_source_type === "calculated_quantity";
  return `${sys}::${legendName || normaliseDesc(it.description)}::${countable ? "counted" : "reference"}`;
}

function positionsOf(it: any): any[] {
  const pts: any[] = [];
  if (it?.coordinates?.x != null) pts.push(it.coordinates);
  if (Array.isArray(it?.coordinates?.instances)) pts.push(...it.coordinates.instances);
  return pts;
}

// One BOQ line per device per sheet, not one per tile.
//
// Quantity is the sum of the tile counts MINUS the seam overlaps we can actually
// demonstrate: a position within DUP_RADIUS of one already contributed by a
// different tile is the same physical symbol seen twice. Summing alone
// double-counts every symbol on a seam; counting distinct positions alone
// UNDER-counts, because a tile routinely reports "3 sensors" while locating only
// one of them. Sum-minus-proven-overlap is the only one of the three that is
// wrong in neither direction.
function mergeTileRows(items: any[]): { items: any[]; removed: number } {
  const groups = new Map<string, any>();
  const order: string[] = [];
  let removed = 0;

  for (const it of items) {
    const key = tileGroupKey(it);
    const pts = positionsOf(it);
    const qty = Number(it.quantity);
    const addQty = Number.isFinite(qty) && qty > 0 ? qty : 0;

    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, {
        // The longest description wins as the group's own: it is reliably the
        // most specific, and specificity is what makes a BOQ line procurable.
        row: { ...it },
        positions: pts.slice(),
        qtySum: addQty,
        tiles: new Set([it.__tile].filter(Boolean)),
        overlaps: 0,
      });
      continue;
    }

    const g = groups.get(key);
    g.tiles.add(it.__tile);
    g.qtySum += addQty;
    let dupHere = 0;
    for (const p of pts) {
      const dup = g.positions.some((a: any) =>
        Math.hypot((a.x ?? 0) - (p.x ?? 0), (a.y ?? 0) - (p.y ?? 0)) < DUP_RADIUS);
      if (dup) dupHere++;
      else g.positions.push(p);
    }
    g.overlaps += dupHere;
    if (String(it.description ?? "").length > String(g.row.description ?? "").length) {
      g.row.description = it.description;
      g.row.technical_specification = it.technical_specification ?? g.row.technical_specification;
    }
    // Keep the most cautious confidence in the group rather than the last one.
    const c = Number(it.confidence_score), gc = Number(g.row.confidence_score);
    if (Number.isFinite(c) && (!Number.isFinite(gc) || c < gc)) g.row.confidence_score = c;
    removed++;
  }

  const out: any[] = [];
  for (const key of order) {
    const g = groups.get(key);
    const row = g.row;
    const total = Math.max(0, g.qtySum - g.overlaps);
    if (g.positions.length) {
      const [head, ...rest] = g.positions;
      row.coordinates = { ...(row.coordinates ?? {}), ...head, instances: rest };
    }
    if (g.tiles.size > 1) {
      row.quantity = total;
      const bits = [`Counted across ${g.tiles.size} tiles of this sheet and merged into one line (${g.qtySum} counted`];
      bits.push(g.overlaps ? `, ${g.overlaps} removed as the same symbol seen twice through a tile seam).` : ").");
      row.quantity_basis_notes = [row.quantity_basis_notes, bits.join("")].filter(Boolean).join(" ");
    }
    out.push(row);
  }
  return { items: out, removed };
}

// Compares each merged line against the quantity printed in the sheet's own
// legend and records the disagreement -- it does NOT resolve it. The legend goes
// into schedule_quantity_crosscheck, which the BOQ consolidation layer already
// reads to raise a discrepancy and force the line out of the Confirmed bucket.
// A legend can be stale or state a per-string figure, so quietly adopting it
// would be the same mistake as quietly publishing an inflated physical count.
function crossCheckAgainstLegend(items: any[], legend: any): number {
  const entries = Array.isArray(legend?.legend_entries) ? legend.legend_entries : [];
  if (!entries.length) return 0;
  const byName = new Map<string, number>();
  for (const e of entries) {
    const q = Number(e?.quantity);
    if (!Number.isFinite(q) || q <= 0) continue;
    const name = normaliseDesc(e?.meaning);
    if (name) byName.set(name, q);
  }
  if (!byName.size) return 0;

  let flagged = 0;
  for (const it of items) {
    if (it.quantity_source_type && it.quantity_source_type !== "physical_count") continue;
    if (it.schedule_quantity_crosscheck != null) continue;
    const name = normaliseDesc(it.legend_item);
    if (!name || !byName.has(name)) continue;
    const legendQty = byName.get(name)!;
    const counted = Number(it.quantity);
    if (!Number.isFinite(counted) || counted === legendQty) continue;
    it.schedule_quantity_crosscheck = legendQty;
    it.quantity_basis_notes = [
      it.quantity_basis_notes,
      `The sheet's legend states ${legendQty} for this item; ${counted} were counted on the plan. Not reconciled automatically — verify against the drawing before pricing.`,
    ].filter(Boolean).join(" ");
    flagged++;
  }
  return flagged;
}

function legendToPromptText(legend: any): string {
  if (!legend || !Array.isArray(legend.legend_entries) || !legend.legend_entries.length) {
    return "No readable symbol legend was found on this sheet. Identify devices from their symbol shape, any text label next to them, and the sheet title.";
  }
  // The printed quantity travels with each row: a tile that can see the legend
  // says so, and the merge step below compares it against what was counted.
  const rows = legend.legend_entries
    .map((e: any) => `  ${e.symbol_code} = ${e.meaning}${e.shape_description ? ` (drawn as: ${e.shape_description})` : ""}${e.system_category ? ` [${e.system_category}]` : ""}`)
    .join("\n");
  return `SYMBOL LEGEND for this sheet, read from the legend box at full resolution:\n${rows}\n\nUse these definitions. Do not re-invent what a symbol means.`;
}

function computeCostCents(inputTokens: number, outputTokens: number): number {
  const usd =
    ((inputTokens || 0) * CUSTOMER_INPUT_PER_MTOK_USD + (outputTokens || 0) * CUSTOMER_OUTPUT_PER_MTOK_USD) /
    1_000_000;
  return Math.max(1, Math.ceil(usd * 100));
}

function computeActualCostCents(inputTokens: number, outputTokens: number): number {
  const usd =
    ((inputTokens || 0) * ACTUAL_INPUT_PER_MTOK_USD + (outputTokens || 0) * ACTUAL_OUTPUT_PER_MTOK_USD) /
    1_000_000;
  return Math.max(1, Math.ceil(usd * 100));
}

function estimatePageCount(bytes: Uint8Array, isPdf: boolean): number {
  if (!isPdf) return 1;
  let text = "";
  const CHUNK = 65536;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g);
  if (pageMatches && pageMatches.length > 0) return pageMatches.length;
  const countMatches = [...text.matchAll(/\/Count\s+(\d+)/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => !Number.isNaN(n));
  if (countMatches.length > 0) return Math.max(...countMatches);
  return 1;
}

function bytesToBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const REQUEST_SIZE_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024;
const MAX_CAD_TEXT_CHARS = 400_000;

function buildFileContentBlock(fileName: string, bytes: Uint8Array): { block: any; kind: "pdf" | "dxf" | "ifc" | "image" } {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return { kind: "pdf", block: { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) } } };
  }
  if (lower.endsWith(".dxf") || lower.endsWith(".ifc")) {
    const isDxf = lower.endsWith(".dxf");
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    let truncated = false;
    if (text.length > MAX_CAD_TEXT_CHARS) { text = text.slice(0, MAX_CAD_TEXT_CHARS); truncated = true; }
    const label = isDxf ? "DXF CAD exchange file (raw text content)" : "IFC BIM exchange file (raw STEP text content)";
    return {
      kind: isDxf ? "dxf" : "ifc",
      block: { type: "text", text: `--- ${label} follows${truncated ? ` (truncated to the first ${MAX_CAD_TEXT_CHARS.toLocaleString()} characters due to size)` : ""} ---\n${text}` },
    };
  }
  const mediaType = lower.match(/\.png$/) ? "image/png" : "image/jpeg";
  return { kind: "image", block: { type: "image", source: { type: "base64", media_type: mediaType, data: bytesToBase64(bytes) } } };
}

async function extractSelectedPages(fileBytes: Uint8Array, pageNumbers1Indexed: number[]): Promise<Uint8Array> {
  const srcDoc = await PDFDocument.load(fileBytes);
  const newDoc = await PDFDocument.create();
  const indices0 = [...new Set(pageNumbers1Indexed)]
    .map((n) => n - 1)
    .filter((i) => i >= 0 && i < srcDoc.getPageCount())
    .sort((a, b) => a - b);
  if (!indices0.length) throw new Error("No valid pages in selection.");
  const copiedPages = await newDoc.copyPages(srcDoc, indices0);
  copiedPages.forEach((p) => newDoc.addPage(p));
  return await newDoc.save();
}

const SYSTEM_CATEGORIES = [
  "cctv","access_control","structured_cabling","wifi","intercom","iptv","public_address",
  "audio_visual","parking_management","anpr","bms","grms",
  "lighting","power_distribution","db_panels","cable_sizing","containment","earthing","lightning_protection",
  "hvac","fcu","ahu","chillers","ducting","ventilation",
  "water_supply","drainage","pumps","fixtures",
  "fire_alarm","fire_fighting","sprinkler","fire_pump","other"
];

const OPTIMIZATION_STATUS_VALUES = [
  "drawing_requirement", "engineered", "calculated", "ai_optimized",
  "potential_optimization", "review_required", "authority_approval_required",
];

// Pass 1 of a tiled run. Small output on purpose: this call exists only to
// read the symbol key, so the per-tile calls in pass 2 stop guessing what a
// triangle means. Returning items here would waste the budget twice.
const TILE_LEGEND_TOOL = {
  name: "record_drawing_legend",
  description: "Record the drawing's symbol legend/key and overall context, read from high-resolution tiles of the sheet.",
  input_schema: {
    type: "object",
    properties: {
      sheet_title: { type: ["string", "null"], description: "Title of the sheet as printed in the title block." },
      systems_present: {
        type: "array",
        description: "Which building systems actually appear as devices on this sheet.",
        items: { type: "string" },
      },
      legend_entries: {
        type: "array",
        description: "Every row of the symbol legend/key that you can actually read. Omit rows you cannot read rather than guessing them.",
        items: {
          type: "object",
          properties: {
            symbol_code: { type: "string", description: "The abbreviation printed against the symbol, e.g. \"CR\", \"ML\", \"C1\"." },
            meaning: { type: "string", description: "What the legend says it is, e.g. \"Card Reader\", \"Fixed Dome Camera\"." },
            shape_description: { type: "string", description: "What the symbol looks like on the plan, so a reader can match it: e.g. \"filled triangle with tail\", \"circle with a wedge showing field of view\"." },
            system_category: { type: "string", description: "Which system it belongs to, e.g. cctv, access_control." },
            quantity: {
              type: ["number", "null"],
              description: "If the legend table prints a quantity/count column against this row, the number exactly as printed. Null if the legend shows no quantity. This is used ONLY to cross-check the physical count -- never as the quantity itself -- so report what is printed and do not adjust it.",
            },
          },
          required: ["symbol_code", "meaning"],
        },
      },
      legend_legible: {
        type: "boolean",
        description: "True only if you could genuinely read the legend text. False if it is cropped, absent or still too small -- do not claim it was legible to be helpful.",
      },
      notes: { type: ["string", "null"], description: "Anything a counter needs to know: sheet covers only part of the floor, devices are scheduled elsewhere, etc." },
    },
    required: ["legend_entries", "legend_legible", "systems_present"],
  },
};

const BOQ_ITEM_TOOL = {
  name: "record_boq_items",
  description: "Record the structured Bill of Quantities items extracted or designed for this system/drawing.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            system_category: { type: "string", enum: SYSTEM_CATEGORIES },
            floor_label: { type: "string" },
            zone: { type: "string" },
            room: { type: "string" },
            area_label: { type: "string" },
            item_no: { type: "string" },
            description: { type: "string", description: "Must name the PHYSICAL EQUIPMENT and its key procurement specification, not a coverage/view/zone label. See the EQUIPMENT SPECIFICITY section of the system prompt -- e.g. \"Dome IP CCTV Camera, 4MP, 2.8mm fixed lens, IR 30m, PoE, IP66 vandal-resistant\", never \"IP CCTV Camera - 10% Detection View\"." },
            technical_specification: { type: "string" },
            manufacturer: { type: "string", description: "Suggested manufacturer/brand for procurement, e.g. \"CommScope / Panduit / equivalent\" or a specific brand if the drawing/spec calls one out. Omit if not determinable -- do not guess a specific brand with no basis." },
            model_number: { type: "string", description: "Suggested model/part number where a specific one is identifiable from the drawing or spec. Omit if not determinable." },
            subsystem: { type: "string", description: "Sub-classification within system_category where it adds useful detail, e.g. system_category=cctv, subsystem=\"IP Camera Network\" vs \"VMS Server Infrastructure\". Omit if system_category alone is specific enough." },
            building: { type: "string", description: "Building/Block/Villa/Tower name -- ONLY for multi-building, multi-villa, or multi-tower projects (e.g. \"Villa 12\", \"Tower B\"). Omit entirely for single-building projects, where floor/zone/room already fully locate the item." },
            from_location: { type: "string", description: "Origin point for a run-type item (cable, conduit, containment, pipework), e.g. \"Server Room, Ground Floor\". Omit for point items (a single device/fixture)." },
            to_location: { type: "string", description: "Destination point for a run-type item, paired with from_location. Omit for point items." },
            optimization_status: {
              type: "string",
              enum: OPTIMIZATION_STATUS_VALUES,
              description: "See the DECISION HIERARCHY / OPTIMIZATION STATUS instructions in the system prompt. Omit to let the platform default it (drawing_requirement for a physical_count/schedule_quantity item, calculated for a calculated_quantity item).",
            },
            optimization_note: { type: "string", description: "Explanation paired with optimization_status -- why this status was assigned, what was optimized or assumed, or what specifically needs review/approval. Required whenever optimization_status is ai_optimized, potential_optimization, review_required, or authority_approval_required." },
            quantity: { type: "number" },
            unit: { type: "string" },
            length_value: { type: "number" },
            area_value: { type: "number" },
            location: { type: "string" },
            installation_accessories: { type: "string" },
            consumables: { type: "string" },
            testing_requirements: { type: "string" },
            commissioning_requirements: { type: "string" },
            confidence_score: { type: "number", description: "0-100. Use lower scores for ambiguous/unclear detections, higher for clearly legible items. If quantity_source_type is a discrepancy-prone reference (schedule_quantity vs. a differing physical count), reflect that uncertainty here too -- confidence measures quantity reliability, not just object recognition." },
            legend_item: {
              type: ["string", "null"],
              description: "The symbol legend row this device matches, copied EXACTLY as the legend words it (e.g. \"360 PARKING SENSOR\"). Null only if this sheet has no legend or this item genuinely matches no legend row. Every tile of one sheet must give the same device the same value here, whatever wording your own description uses -- this is how the same device counted on several tiles becomes one BOQ line instead of several.",
            },
            quantity_source_type: {
              type: "string",
              enum: ["physical_count", "schedule_quantity", "key_plan_reference", "legend_reference", "typical_detail_reference", "note_reference", "calculated_quantity", "duplicate_reference"],
              description: "CRITICAL for avoiding double-counting. Classify where THIS row's quantity number came from: physical_count = you counted actual physical symbols/devices/equipment shown on a floor plan, layout, or riser (this is the PRIMARY source of truth); schedule_quantity = the number came from an equipment/device/material schedule table AND a separate physical_count row for the same item also exists (use ONLY as a cross-check -- if the schedule is the ONLY source, use physical_count instead, see the QUANTITY ACCURACY rules); key_plan_reference = symbols shown only on a navigation/overview key plan, not counted; legend_reference = a symbol shown only in a legend/symbol table to explain notation, never counted; typical_detail_reference = an example/typical/detail drawing showing one instance to illustrate a repeated condition, not an additional physical installation; note_reference = a quantity mentioned only in text/notes, not verified against a real count; calculated_quantity = legitimately derived from explicit dimensions/design rules (e.g. cable length from measured run distance), counts toward the total like physical_count; duplicate_reference = you recognize this is the SAME physical item already reported in another row -- mark the redundant occurrence this way so it is excluded, do not silently omit it. DEFAULT/ASSUME physical_count when you counted real symbols on an actual layout drawing. NEVER simply add up every number you see for the same equipment across floor plan + schedule + key plan + legend.",
            },
            schedule_quantity_crosscheck: {
              type: "integer",
              description: "WHOLE NUMBER ONLY (the database column is an integer -- a decimal here will be rejected). Only set this on a physical_count row (not on a schedule_quantity row) when a schedule/equipment list ALSO exists for this same item and states a possibly-different quantity than what you physically counted -- put the schedule's stated number here so the platform can flag a discrepancy for engineer review. Omit if no schedule exists or if the schedule agrees exactly with your physical count.",
            },
            quantity_basis_notes: {
              type: "string",
              description: "Brief note on how the quantity was determined, e.g. \"Counted 18 dome camera symbols on CCTV-GF-L01 page 3\" or \"Schedule reference only, cross-checked against physical count of 96\". Also record here any specification attribute the drawing did NOT state, so the engineer knows what must still be confirmed before procurement. Keeps the quantity traceable for the Quantity Basis drilldown.",
            },
            coordinates: {
              type: "object",
              description: [
                "Only when extracting from an actual drawing image/PDF page (omit entirely for AI-designed, non-drawing-based items):",
                "where this item's symbols appear on the page, so EVERY occurrence can be highlighted on the drawing.",
                "page is the 1-indexed page number within the document sent. x/y are the TOP-LEFT corner of the box and",
                "width/height its size, all as a FRACTION of the page's full width/height (0.0-1.0), never pixels.",
                "",
                "SIZE: the box must tightly enclose the symbol itself, not the room it sits in. A device symbol on a",
                "typical A1 sheet is about 0.01-0.03 of the page in each direction. Only use a box larger than 0.08 when",
                "the item genuinely IS an area -- a riser shaft, a plant room, a cable route -- and never larger than 0.2.",
                "",
                "INSTANCES: quantity is usually more than 1, and each physical occurrence needs its own marker. Put the",
                "FIRST occurrence in x/y and EVERY OTHER occurrence in instances[]. For an item with quantity 17 you",
                "should return x/y plus 16 entries in instances, one per symbol you actually located. If you can only",
                "find some of them, return the ones you found -- a partial, honest set is useful; a padded one is not.",
                "",
                "OMIT RATHER THAN GUESS: leave coordinates out entirely for any item whose symbols you cannot actually",
                "see and place on this page -- schedule rows, legend entries, general notes, quantities taken from a",
                "table rather than counted on the plan, or anything too small or dense to resolve. A marker over empty",
                "floor is worse than no marker, because the estimator may believe it. Do not distribute boxes evenly,",
                "do not step positions down a column, and do not round to neat values like 0.50 or 0.65 to fill gaps."
              ].join(" "),
              properties: {
                page: { type: "number" },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                instances: {
                  type: "array",
                  description: "Every occurrence of this item's symbol on the page BEYOND the first (which is in x/y). Same fractional coordinate system. One entry per physical device counted.",
                  items: {
                    type: "object",
                    properties: { x: { type: "number" }, y: { type: "number" } },
                    required: ["x", "y"]
                  }
                }
              }
            }
          },
          required: ["system_category", "description", "quantity", "unit", "confidence_score"]
        }
      },
      cost_optimizations: {
        type: "array",
        description: "Cost-saving alternatives you identified but did NOT silently apply to the item itself -- proposed here for the customer/engineer to explicitly accept or reject. Typically one entry per item with optimization_status=potential_optimization.",
        items: {
          type: "object",
          properties: {
            item_ref: { type: "number", description: "0-indexed position within \"items\" this optimization relates to. Omit for a project-level optimization not tied to one line item." },
            title: { type: "string" },
            original_approach: { type: "string" },
            optimized_approach: { type: "string" },
            estimated_savings_note: { type: "string", description: "Free-text, e.g. \"~15% lower switch cost, same PoE budget\" -- do not fabricate a precise dollar figure with no basis." },
          },
          required: ["title"],
        },
      },
      assumptions: {
        type: "array",
        description: "Assumptions you made that are not directly shown on the drawing/spec (e.g. \"assumed a standard 3m ceiling height for cable-drop calculation, not dimensioned\"). Always disclose these rather than assuming silently.",
        items: {
          type: "object",
          properties: {
            item_ref: { type: "number", description: "0-indexed position within \"items\" this assumption relates to. Omit for a project-level assumption." },
            assumption_text: { type: "string" },
          },
          required: ["assumption_text"],
        },
      },
      review_items: {
        type: "array",
        description: "Items or aspects needing human engineer review before procurement -- used instead of guessing a quantity or specification. Typically one entry per item with optimization_status=review_required or authority_approval_required, and also where a required equipment specification was not stated on the drawing.",
        items: {
          type: "object",
          properties: {
            item_ref: { type: "number", description: "0-indexed position within \"items\" this review item relates to. Omit for a project-level review note." },
            reason: { type: "string" },
          },
          required: ["reason"],
        },
      },
      reference_panels: {
        type: "array",
        description:
          "Bounding boxes of any LEGEND, SYMBOL KEY, SCHEDULE TABLE, NOTES BLOCK or TITLE BLOCK visible in this image, " +
          "as fractions of THIS IMAGE (0.0-1.0). These panels contain drawn symbols that are references, not installed " +
          "devices, so they are used to discard false device positions. Report every such panel you can see, even partially. " +
          "Omit or leave empty if the image is entirely floor plan.",
        items: {
          type: "object",
          properties: {
            x: { type: "number", description: "Left edge as a fraction of this image." },
            y: { type: "number", description: "Top edge as a fraction of this image." },
            width: { type: "number", description: "Width as a fraction of this image." },
            height: { type: "number", description: "Height as a fraction of this image." },
            kind: { type: "string", description: "What it is: legend, symbol_key, schedule, notes, title_block, key_plan." },
          },
          required: ["x", "y", "width", "height"],
        },
      },
      analysis_notes: { type: "string", description: "Short summary of what was analyzed, assumptions made, and any items that could not be confidently determined." },
      document_kind: {
        type: "string",
        enum: ["drawing", "specification", "schedule", "other"],
        description: "What this file actually is. \"drawing\" = a layout, plan, section, riser or detail you can measure from. \"specification\" = written prose: a specification section, standard, method statement or datasheet, with no measurable layout. \"schedule\" = a table of quantities or equipment with no layout. \"other\" = anything else, e.g. a cover page or a transmittal. If it is NOT a drawing, set this and return an EMPTY items list -- do not attempt to derive quantities from prose or from a table alone. Saying so is far more useful than a guess.",
      }
    },
    required: ["items", "analysis_notes"]
  }
};

const QUANTITY_RECONCILIATION_RULES = `

QUANTITY ACCURACY -- READ CAREFULLY, THIS PREVENTS DOUBLE-COUNTING:
The actual physical installation shown on layout/floor/riser drawings is the PRIMARY source of quantity. Do NOT simply add up every number you encounter for the same equipment.
- If you see 20 camera symbols physically drawn on a floor plan AND a camera schedule table stating "20", the correct final quantity is 20, not 40. The schedule VALIDATES the physical count -- it is not a second batch of cameras. Report the physical count as one physical_count row; optionally set schedule_quantity_crosscheck=20 on that same row rather than emitting a duplicate row for the schedule number.
- NEVER count symbols shown only in a legend/symbol table/abbreviation key as installed equipment (quantity_source_type: legend_reference, excluded from totals).
- A DIMENSION IS NOT A QUANTITY. A material or fabrication table gives sizes and lengths -- "PIPE 50 / HANDRAIL / 60.30 OD x 3.91 / LENGTH 1450". The 1450 is how long one handrail is, not how many there are. Put it in length_value, describe the size in technical_specification, and set quantity to the number of PIECES you can actually count on the drawing. If the drawing does not say how many pieces, set quantity to 0, quantity_source_type to typical_detail_reference, and say plainly in quantity_basis_notes that the count is not stated -- do NOT put the dimension in the quantity field, and do NOT invent a count. The unit field must never be mm or cm: those are dimensions, and a BOQ quantity unit is no/nos/set/m/m2.
- A TYPICAL DETAIL IS NOT AN INSTALLATION. A panel captioned "typical detail", "typical cross-section", "typical section" or "representative section" shows how something is built ONCE, to be repeated wherever the plan calls for it. Counting the items drawn inside it gives the number the draughtsman happened to illustrate, not the number in the building. If your own reasoning contains the words "typical" or "representative", the row's quantity_source_type MUST be typical_detail_reference, never physical_count. A real customer BOQ came back with "3 Terramesh Units" because three blocks happened to be drawn in one typical cross-section; the true quantity depended on road length and spacing, which that detail never stated.
- ALWAYS set legend_item to the legend row this device matches, copied EXACTLY as the legend words it. Every tile of one sheet must therefore give the same device the same legend_item, even when your description of it differs. This is what lets the same device counted on six different tiles become one BOQ line instead of six. (This block is inside a TS template literal -- no backticks.)
- NEVER count a key plan's symbols as an independent quantity source when the actual floor plan is also available (quantity_source_type: key_plan_reference, excluded from totals).
- "Typical Floor" drawings: if a typical-floor drawing shows 25 devices and a note says it applies to floors 03-10 (8 floors) with NO individual per-floor drawings provided, you may report quantity_source_type=calculated_quantity with quantity = 25 x 8 = 200 and explain the basis in quantity_basis_notes. But if individual drawings for floors 03-10 ARE also provided/visible, count each floor's own drawing as physical_count and do NOT additionally multiply the typical-floor drawing (that would double the count).
- If the same physical equipment appears across multiple drawing types for the same project (e.g. an ELV layout AND an architectural plan both show the same fire alarm device), classify the redundant occurrence as duplicate_reference so it is excluded, and only count it once as physical_count on its primary/clearest source.
- If a schedule quantity disagrees with your physical count (schedule says 50, you counted 48 physical symbols), do NOT silently pick the larger number -- report your physical count as the quantity, set schedule_quantity_crosscheck to the schedule's number, and lower confidence_score to reflect the unresolved discrepancy so it surfaces for engineer review.
- SHARED MULTI-TRADE CABINET/ENCLOSURE LABELS -- a common over-counting trap: generic cabinet tags (e.g. "12U CAB", "DB", "IDF", "MDF", comms/data/patch cabinet symbols) routinely appear MANY times on one floor plan, but that same generic symbol is normally shared infrastructure used by MULTIPLE trades on the drawing (electrical distribution boards, data/IT, access control, CCTV, etc.) -- it is NOT one dedicated cabinet per trade per label. Do NOT count every occurrence of a generic/ambiguous cabinet label as belonging to whichever single system you are currently extracting. Only count a cabinet as dedicated to your system when the drawing, legend, or schedule explicitly and specifically identifies it as such (e.g. a distinct "CCTV CAB" tag, or a legend entry naming it as that system's network cabinet). Absent that explicit dedication, apply standard engineering practice: a shared network/communications cabinet is typically allocated ONE per floor to house that floor's system-specific active equipment (e.g. one PoE switch + patch panel section within the shared cabinet), not one cabinet per label instance -- seeing 16-18 generic cabinet labels on a floor is evidence of a shared riser/telecom-closet convention repeated across trades, not 16-18 separate CCTV-dedicated cabinets. Apply this SAME reasoning consistently across every floor and drawing within one project.
- CRITICAL -- WHEN THE SCHEDULE IS THE ONLY SOURCE, IT MUST STILL COUNT: everything above about schedule_quantity being validation-only assumes a physical_count row for that same item ALSO exists. If it does not -- you took an item's quantity from an equipment/device schedule and did NOT separately count that item's symbols on a layout (because the layout page wasn't supplied, the symbols were illegible, the sheet is a schematic/riser, or the schedule is simply the authoritative definition of scope) -- then the schedule IS your primary source for that item. In that case report it as quantity_source_type=physical_count (NOT schedule_quantity) and say in quantity_basis_notes that the figure came from the schedule and no independent symbol count was possible. Rationale you must respect: schedule_quantity rows are EXCLUDED from the BOQ total by design, so if an item's only row is schedule_quantity that item silently contributes ZERO and disappears from the customer's BOQ. A real drawing analysis on 2026-08-10 did exactly this and dropped all 40 cameras from a CCTV BOQ that otherwise looked complete. NEVER leave an item whose sole row is schedule_quantity.
- Default every real drawing-based item to quantity_source_type=physical_count unless one of the reference/schedule/duplicate categories clearly applies.`;

const MASTER_BOQ_ENGINE_RULES = `

DECISION HIERARCHY -- apply in this order for every item:
1. EXPLICIT REQUIREMENT WINS: if the drawing, schedule, or specification explicitly shows or states an item, spec, or quantity, that governs the BOQ row -- never silently change it to something you think is better.
2. ENGINEER THE GAP: where the drawing implies a system but leaves a specific value undefined (e.g. a camera is shown but its cable route/length is not dimensioned, or an accessory isn't itemized), apply standard, defensible engineering practice to fill the gap, and explain the basis in optimization_note.
3. OPTIMIZE ONLY WHERE SAFE: you may propose a lower-cost alternative only where no explicit requirement exists, or where the alternative would still fully satisfy an explicit requirement. Set optimization_status=potential_optimization and add a cost_optimizations entry rather than silently substituting it -- UNLESS it is a pure equivalent-spec substitution with zero functional change, in which case you may apply it directly with optimization_status=ai_optimized (still explain the substitution in optimization_note).
4. NEVER SILENTLY OVERRIDE an explicit requirement to save cost. If a requirement looks unusual or over-specified, flag it via optimization_note (and a review_items entry if it's genuinely ambiguous) instead of changing it.

OPTIMIZATION STATUS -- assign the closest match on every item:
- drawing_requirement: explicitly shown/scheduled on the drawing/spec as-is (the common case for a straightforward drawing extraction).
- engineered: derived via standard engineering practice/rule to fill a gap the drawing left undefined.
- calculated: computed from an explicit formula/dimension (e.g. cable length from a measured run, HVAC load from room area, quantity from a design_system requirements calculation).
- ai_optimized: you substituted a lower-cost equivalent that still fully meets the same explicit requirement -- explain the substitution in optimization_note.
- potential_optimization: a cost-saving alternative exists but you did NOT apply it to this row -- add a matching cost_optimizations entry describing original vs. optimized approach; this is a proposal only, never applied automatically.
- review_required: the drawing data is ambiguous, contradicts itself across revisions, or otherwise isn't confidently determinable -- do NOT guess a quantity; add a matching review_items entry explaining what a human engineer needs to resolve.
- authority_approval_required: this item needs a local-authority approval/certificate before procurement -- name the authority/approval in optimization_note.
If you have no particular reason to set one of the non-default values, omit optimization_status and let the platform apply its default.

SUPPORTING ARRAYS -- use the tool's optional cost_optimizations / assumptions / review_items arrays (each entry may reference the 0-indexed position of the related item in "items" via item_ref, or omit item_ref for a project-level note not tied to one row):
- Every potential_optimization item should normally have a matching cost_optimizations entry.
- Any assumption you made that isn't directly shown on the drawing (e.g. "assumed 3m ceiling height, not dimensioned") belongs in assumptions -- disclose it, don't bury it silently in a description field.
- Every review_required or authority_approval_required item should normally have a matching review_items entry.

EQUIPMENT SPECIFICITY -- the description must identify WHAT TO BUY, not merely what the drawing calls it. A real customer's BOQ came back with rows like "IP CCTV Camera - 10% Detection View", which is a coverage/view classification from the drawing's own annotation, not a procurable item -- nobody can price or order from it. Every description must lead with the physical equipment type and its key procurement-relevant specification, then optionally the drawing reference. For a camera that means the FORM FACTOR (dome / bullet / turret / PTZ / fisheye / box), plus whatever of resolution, sensor, lens (fixed or varifocal, focal length), IR/night capability, power method (PoE / PoE+ / 12VDC), housing and IP/IK rating the drawing, its schedule, its legend or its specification actually states -- e.g. "Dome IP CCTV Camera, 4MP, 2.8mm fixed lens, IR 30m, PoE, IP66 vandal-resistant (DET view, CCTV-01 to 04)". The same principle applies to every discipline: name the actual device (light fitting type/wattage/mounting, DB panel with way count and rating, FCU with capacity, sprinkler head type and temperature rating, cable with size and core count), never just its role or a view/zone label.
- If the drawing genuinely does not state a needed attribute, DO NOT invent a specific brand or model. Give the type and whatever specification IS stated, then record the missing attributes in quantity_basis_notes or as a review_items entry so the engineer knows what still has to be confirmed before procurement. A row that is honestly "Dome IP CCTV Camera, resolution not stated on drawing" is far more useful than "Camera - Detection View".
- Where several genuinely different equipment types share a coverage class or zone label, keep them as SEPARATE rows by type. Do not merge distinct devices into one line just because the drawing groups them under one annotation.

LOCATION FIELDS: fill "building" only for multi-building/multi-villa/multi-tower projects (e.g. "Villa 12", "Tower B") -- omit it for single-building projects, where floor/zone/room already fully locate the item. Fill "subsystem" for a meaningful sub-classification within system_category where it adds real detail. Fill "from_location"/"to_location" only for run-type items (cable, conduit, containment, pipework) describing origin and destination -- omit both for point items (a single device/fixture has one location, not a run).`;

// ---------------------------------------------------------------------------
// CIVIL TAKE-OFF (2026-10-21, phase 1)
//
// Customers asked for civil BOQs: earthworks, concrete, formwork, steel,
// blockwork, plaster, finishes, skirting, doors and windows, external works.
// Those trades are MEASURED (m, m2, m3, kg), not counted, so they get their
// own prompt and their own category list. They are read from the whole sheet,
// never from tiles: a tile cuts dimension strings and room outlines in half.
//
// A drawing goes down this path when its discipline is civil, structural or
// architectural. An architectural plan that carries lighting or small power is
// uploaded as Electrical, as it always has been.
// ---------------------------------------------------------------------------
const CIVIL_DISCIPLINES = ["civil", "structural", "architectural"];

function isCivilDrawing(drawing: any): boolean {
  const d = String(drawing?.discipline ?? "").toLowerCase().trim();
  return CIVIL_DISCIPLINES.includes(d);
}

const CIVIL_CATEGORIES = [
  "site_works", "earthworks", "concrete", "formwork", "reinforcement", "structural_steel",
  "masonry", "waterproofing", "insulation", "plaster_render", "screed",
  "floor_finishes", "wall_finishes", "ceiling_finishes", "skirting", "painting",
  "doors", "windows", "joinery", "metalwork", "external_works", "drainage",
  "piling", "ground_stabilisation", "other",
];

// Same tool as MEP, with the civil categories and civil wording. Built from
// BOQ_ITEM_TOOL so every other field (coordinates, source types, review
// arrays) stays identical and the row mapping below needs no change.
const CIVIL_BOQ_TOOL = (() => {
  const t = JSON.parse(JSON.stringify(BOQ_ITEM_TOOL));
  t.description = "Record the measured civil / structural / architectural Bill of Quantities items taken off this drawing.";
  const p = t.input_schema.properties.items.items.properties;
  p.system_category = { type: "string", enum: CIVIL_CATEGORIES, description: "The civil work section this item belongs to." };
  p.description = {
    type: "string",
    description: "What is built or supplied, with its specification, as a QS would write it: e.g. \"Reinforced concrete C35/45 in ground beams\", \"200 mm hollow concrete blockwork in external walls\", \"Porcelain floor tiles 600x600 mm on adhesive bed\", \"Ceramic skirting 100 mm high\".",
  };
  p.unit = { type: "string", enum: ["m3", "m2", "m", "kg", "t", "nr", "item"], description: "Measurement unit: m3 volume, m2 area, m length, kg/t steel, nr for counted items, item for a lump sum." };
  p.quantity_basis_notes = {
    type: "string",
    description: "REQUIRED for every measured item: the dimensions and arithmetic, e.g. \"Room 104: 2x(6.20+4.80)=22.00 m less door 0.90 = 21.10 m\" or \"Footing F1: 1.80x1.80x0.60 = 1.944 m3 x 12 nr = 23.33 m3\". Name where each dimension came from (dimension string, schedule, area tag, scale).",
  };
  p.quantity_formula = {
    type: "string",
    description: "REQUIRED for every measured row: the working as a plain arithmetic expression using only numbers, + - * / and brackets, in the row's unit -- e.g. \"2*(6.20+4.80)-0.90\" or \"1.80*1.80*0.60*12\". The platform calculates the quantity from this, so it must be the complete sum, not a fragment.",
  };
  delete p.manufacturer;
  delete p.model_number;
  delete p.testing_requirements;
  delete p.commissioning_requirements;
  p.installation_accessories = { type: "string", description: "Items deemed included with this row, e.g. \"adhesive, grout, spacers\" or \"tie wire, spacers, chairs\". Omit if none." };
  return t;
})();

const CIVIL_TAKEOFF_RULES = `

YOU ARE TAKING OFF CIVIL, STRUCTURAL AND ARCHITECTURAL QUANTITIES. These trades are MEASURED from dimensions, not counted from symbols.

1. READ THE SHEET FIRST
- Title block: drawing title, drawing number, revision, scale (e.g. 1:100 at A1) and units. Dimensions on construction drawings are in millimetres unless stated; levels are in metres.
- Find every schedule and key on the sheet: room finish schedule, door and window schedule, footing / column / beam schedule, bar bending schedule, finish legend, hatch legend. A schedule is the best source of a specification; the plan is the source of where and how much.
- Note what kind of sheet it is (plan, section, elevation, detail, schedule) and which items it can and cannot give. A floor plan gives floor areas, perimeters, wall lengths and openings; heights come from sections, elevations or notes.

2. HOW TO GET A DIMENSION -- in this order, and say which one you used in quantity_basis_notes
  a) A written dimension string, area tag (e.g. "AREA 24.5 m2") or schedule value. Always prefer these.
  b) Add up a chain of written dimensions to get an overall length.
  c) Only if nothing is written: scale it from the drawing using the printed scale or scale bar. Mark the row engineered, keep confidence at 60 or below, and say "scaled".
  Never invent a dimension. If a needed dimension (often a height or a thickness) is not on this sheet, state the value you assumed in assumptions[], lower the confidence, and put the item in review_items.

3. MEASUREMENT RULES (standard method of measurement practice)
- Excavation, fill, concrete: m3, net volume, no allowance for bulking or waste. Concrete per element type and grade (blinding, footings, ground beams, slab on grade, columns, beams, suspended slabs, walls, stairs).
- Formwork: m2 of the face in contact with concrete, per element type. Not to blinding or the top face of a slab.
- Reinforcement: kg or t, per bar type, from a bar bending schedule or the bar marks and spacings shown. If there is no schedule and the bars are not detailed, give the item with an assumed rate in kg per m3 of concrete, status engineered, confidence 40 or below, and say so.
- Blockwork / masonry: m2, per wall thickness and type, wall length x height. Deduct openings (doors, windows) larger than 0.5 m2.
- Plaster, render, paint, wall tiles: m2 of the finished face, per side of the wall that receives it. Deduct openings larger than 0.5 m2.
- Floor finishes, screed, ceilings, waterproofing: m2 of the room or zone, measured net within the walls. State the room.
- Skirting, coving, kerbs, copings, DPC, handrails, edge strips: m, measured along the room perimeter or the line shown, LESS the width of every doorway the skirting does not run across.
- Doors, windows, manholes, sanitary fixtures shown on architectural plans: nr, per type mark from the schedule (D1, W2...).
- Paving, landscaping, road layers: m2 per layer and thickness; kerbs m; road base / sub-base can also be m3 if the drawing gives thickness.
- Structural steel members: kg (or t), length x mass per metre from standard section tables for the profile shown, per profile; state the number of pieces and the kg/m used in the working. Plates: kg from size x thickness x 7850 kg/m3. Bolts and anchors: nr.
- Ground stabilisation: shotcrete m2 per thickness, mesh m2, rock bolts / soil nails nr per length and diameter (and m of drilling), drainage holes nr. Piles nr per diameter and length, plus m of piling.

4. ROWS
- One row per item type per room or zone where the drawing names rooms (room field filled). If the sheet has very many rooms (more than about 25), give one row per item type per floor and list the room totals inside quantity_basis_notes instead.
- Never put two different specifications in one row. Never repeat the same quantity in two rows.
- A drawing title or note that says "TYPICAL" or "TYP." applies to the repetitions it states only if the number of repetitions is printed. Otherwise measure one and add a review item.
- A plan that refers to another sheet for a detail ("SEE DWG A-501") does not give that detail: measure what this sheet shows and note the reference.
- quantity_source_type: calculated_quantity for anything you worked out from dimensions; schedule_quantity when the number is printed in a schedule; physical_count for items counted on the plan (doors, manholes).
- For a sheet that only shows a reference plan (e.g. a skirting reference plan or a finishes key plan), the finish codes on the plan tell you WHICH finish goes WHERE: measure each code's quantity from the room outlines and dimensions, and take its specification from the legend.
- If a perimeter can only be estimated from a room's area tag (no dimensions, sheet not to scale), give ONE ROW PER ROOM, write "estimated from area" in the working, and keep confidence at 40 or below. Never total a set of estimates into one confident row.
- If nothing on the sheet can be measured, return an EMPTY items list and explain why in analysis_notes. Never add a row that only describes the sheet.
- A sheet of typical details with no number of repetitions: give each item with quantity 0, its full specification and the per-unit working in quantity_basis_notes, status review_required, so the estimator can multiply it once the number is known.

5. CONFIDENCE
- 85-95: taken from a written dimension, area tag or schedule.
- 60-80: added up from several written dimensions, or a height taken from another part of the sheet.
- 30-60: scaled, or depends on an assumed height or thickness.
- Below 30: guessed from context. Put every such row in review_items.

6. WHAT NOT TO MEASURE
- Nothing from a legend, symbol key, title block or north arrow.
- No MEP or ELV items (lights, sockets, ducts, pipes, cameras) -- those are taken off from the MEP drawings.
- No prices or rates.

Fill quantity_basis_notes on EVERY row with where each dimension came from, and quantity_formula with the complete arithmetic. The platform calculates the quantity from quantity_formula, so a quantity surveyor can check it in one look. A quantity without its working is not usable.`;

function civilSystemPrompt(projectContext: string): string {
  return `You are an expert quantity surveyor taking off civil, structural and architectural works from construction drawings to produce an accurate, checkable Bill of Quantities. ${projectContext}${CIVIL_TAKEOFF_RULES}`;
}

function civilUserText(drawing: any, usingSelection: boolean, selectionCount: number, coordsInstruction: string): string {
  return `Take off this ${drawing.discipline ?? "civil"} drawing${drawing.floor_label ? ` for ${drawing.floor_label}` : ""}${usingSelection ? ` (${selectionCount} selected pages)` : ""}. ` +
    `Read the title block, scale, schedules and legends first. Then measure every civil, structural and architectural item this sheet gives enough information for, ` +
    `in m3, m2, m, kg/t or nr as the rules say, and record them with record_boq_items. Show the dimensions and arithmetic in quantity_basis_notes on every row. ` +
    `Disclose every assumed height, thickness or dimension in assumptions, and give an honest confidence_score per row. ${coordsInstruction}`;
}

// Markers are point markers: only counted items (doors, windows, manholes)
// can carry them; sanitizeCoordinates drops them for m, m2 and m3 anyway.
const CIVIL_COORDS_INSTRUCTION =
  "Give coordinates ONLY for doors, windows and manholes you counted on a plan, one point per occurrence (page 1-indexed, x/y as fractions of the page), and only where you can actually place each one. " +
  "Omit coordinates for every measured item, for anything from a schedule or table, and whenever unsure -- a wrong marker is worse than none.";

// Safe arithmetic for civil quantities (2026-10-21). The AI writes the working
// as a plain expression, e.g. "2*(6.20+4.80)-0.90"; the platform does the sum.
// In testing the AI listed room perimeters adding up to ~1,190 m and reported
// 714.6 m -- a QS checks the arithmetic first, so the arithmetic is ours.
// Numbers, + - * / and brackets only; anything else returns null.
function evalQuantityFormula(src: unknown): number | null {
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

// Civil rows after the AI, before saving (2026-10-21). Learned from the first
// four real drawings: the AI's own sums were wrong, it invented a category
// ("shotcrete"), filed a "Ground floor plan" placeholder row, repeated a row,
// and claimed 75% on perimeters it had guessed from room areas.
const CIVIL_CATEGORY_ALIASES: Record<string, string> = {
  shotcrete: "ground_stabilisation", rock_bolts: "ground_stabilisation", rock_bolt: "ground_stabilisation",
  soil_nails: "ground_stabilisation", slope_protection: "ground_stabilisation", mesh: "ground_stabilisation",
  excavation: "earthworks", backfill: "earthworks", blockwork: "masonry", brickwork: "masonry",
  plaster: "plaster_render", render: "plaster_render", tiling: "floor_finishes", flooring: "floor_finishes",
  ceiling: "ceiling_finishes", ceilings: "ceiling_finishes", paint: "painting", steelwork: "structural_steel",
  steel: "structural_steel", rebar: "reinforcement", paving: "external_works", landscaping: "external_works",
  roads: "external_works", kerbs: "external_works", cladding: "wall_finishes",
};

function finalizeCivilItems(items: any[]): { items: any[]; recalculated: number; dropped: number; indexMap: Map<number, number> } {
  let recalculated = 0, dropped = 0;
  const seen = new Set<string>();
  const out: any[] = [];
  const indexMap = new Map<number, number>();
  for (const [idx, raw] of (items || []).entries()) {
    const it = { ...raw };
    const cat = String(it.system_category ?? "other").toLowerCase().trim();
    it.system_category = CIVIL_CATEGORIES.includes(cat) ? cat : (CIVIL_CATEGORY_ALIASES[cat] ?? "other");

    // A row that only describes the sheet is not a quantity.
    const desc = String(it.description ?? "").toLowerCase();
    if (it.system_category === "other" && String(it.unit ?? "") === "item" && /\b(plan|drawing|layout|sheet)\b/.test(desc)) {
      dropped++; continue;
    }

    // The platform does the arithmetic.
    const calc = evalQuantityFormula(it.quantity_formula);
    if (calc !== null) {
      const said = Number(it.quantity);
      const value = Math.max(0, calc);
      if (!Number.isFinite(said) || Math.abs(said - value) > Math.max(0.01, Math.abs(value) * 0.01)) {
        recalculated++;
        it.quantity_basis_notes = `${it.quantity_basis_notes ?? ""} [Quantity calculated by the platform from ${it.quantity_formula} = ${value}${Number.isFinite(said) ? `; the AI had written ${said}` : ""}.]`.trim();
      } else {
        it.quantity_basis_notes = `${it.quantity_basis_notes ?? ""} [Working: ${it.quantity_formula} = ${value}]`.trim();
      }
      if (calc < 0) {
        it.optimization_status = "review_required";
        it.optimization_note = "The working came out negative, so the quantity was set to 0 for review.";
      }
      it.quantity = value;
    }

    // Guessed geometry cannot claim high confidence.
    const basis = String(it.quantity_basis_notes ?? "").toLowerCase();
    if (/\b(approx|approximately|estimated from (the )?(room )?area|assum(ed|ing) (typical )?proportion|scaled)\b/.test(basis)) {
      it.confidence_score = Math.min(Number(it.confidence_score ?? 50), 50);
    }

    // Markers only for counted items; measured items have no point position.
    if (String(it.unit ?? "") !== "nr") delete it.coordinates;

    const key = [it.system_category, desc.replace(/\s+/g, " ").trim(), it.unit, String(it.room ?? "").toLowerCase(), Number(it.quantity)].join("|");
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    indexMap.set(idx, out.length);
    out.push(it);
  }
  return { items: out, recalculated, dropped, indexMap };
}

// Assumptions, review notes and optimisations point at rows by position, so
// they follow the rows that were kept; a note about a dropped row becomes a
// sheet-level note instead of attaching to the wrong line.
function applyCivilFinalize(result: any): string {
  const f = finalizeCivilItems(result.items || []);
  result.items = f.items;
  for (const key of ["assumptions", "review_items", "cost_optimizations"]) {
    for (const e of result[key] || []) {
      if (typeof e?.item_ref !== "number") continue;
      const to = f.indexMap.get(e.item_ref);
      if (to === undefined) delete e.item_ref; else e.item_ref = to;
    }
  }
  const bits: string[] = [];
  if (f.recalculated) bits.push(`${f.recalculated} quantit${f.recalculated === 1 ? "y was" : "ies were"} recalculated by the platform from the working shown`);
  if (f.dropped) bits.push(`${f.dropped} repeated or descriptive row${f.dropped === 1 ? " was" : "s were"} removed`);
  return bits.length ? ` ${bits.join("; ")}.` : "";
}

// AUTO-DETECT (2026-10-21). A customer uploaded a skirting reference plan as
// "Plumbing" because that was the nearest choice, and was charged for a run
// that found nothing. Before an MEP/ELV read of a PDF or image, one short call
// asks whether the sheet actually carries MEP/ELV work. If it carries none and
// is an architectural, structural or civil sheet, it is measured as civil
// works instead and the drawing's type is corrected, with a note saying so.
const SHEET_KIND_TOOL = {
  name: "record_sheet_kind",
  description: "Say what kind of construction sheet this is.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["mep_elv", "architectural", "structural", "civil", "not_a_drawing"],
        description: "mep_elv if ANY electrical, lighting, power, ELV, HVAC, plumbing, drainage or fire devices, fixtures, or cable/pipe/duct runs are drawn on it, even on an architectural background. Otherwise the sheet's own discipline: architectural (layouts, finishes, skirting, doors, windows), structural (foundations, concrete, steel, reinforcement) or civil (earthworks, roads, external works, ground stabilisation). not_a_drawing for a specification, schedule-only page or cover sheet.",
      },
      reason: { type: "string", description: "One short sentence: what on the sheet decided it." },
    },
    required: ["kind", "reason"],
  },
};

async function detectSheetKind(apiKey: string, fileBlock: any): Promise<{ kind: string; reason: string } | null> {
  try {
    // Direct call, not callClaude: callClaude insists on an items list.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL, max_tokens: 400,
        system: "You sort construction drawings by trade before take-off. Look at the whole sheet, its title block and its legend.",
        tools: [SHEET_KIND_TOOL], tool_choice: { type: "tool", name: SHEET_KIND_TOOL.name },
        messages: [{ role: "user", content: [fileBlock, { type: "text", text: "What kind of sheet is this? Answer with record_sheet_kind." }] }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const r = data.content?.find((c: any) => c.type === "tool_use")?.input as any;
    return r?.kind ? { kind: String(r.kind), reason: String(r.reason ?? "") } : null;
  } catch (e) {
    console.warn("detectSheetKind failed, reading the sheet as typed:", describeError(e));
    return null;
  }
}

const PAGE_CLASSIFICATION_TOOL = {
  name: "record_page_classifications",
  description: "Classify every page of this construction drawing package by the system/discipline it primarily shows.",
  input_schema: {
    type: "object",
    properties: {
      total_pages: { type: "number" },
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page_number: { type: "number" },
            system_category: { type: "string", enum: [...SYSTEM_CATEGORIES, "architectural", "structural", "general"] },
            page_label: { type: "string", description: "Short human label, e.g. 'Ground Floor CCTV Layout'." }
          },
          required: ["page_number", "system_category"]
        }
      }
    },
    required: ["total_pages", "pages"]
  }
};

async function supersedePriorNoDrawingRuns(admin: any, projectId: string, runKind: string, currentRunId: string) {
  const { data: priorRuns } = await admin.from("analysis_runs")
    .select("id")
    .eq("project_id", projectId)
    .is("drawing_id", null)
    .eq("run_kind", runKind)
    .neq("id", currentRunId);
  const priorRunIds = (priorRuns || []).map((r: any) => r.id);
  if (!priorRunIds.length) return;
  await admin.from("boq_items").delete().in("analysis_run_id", priorRunIds);
  await admin.from("analysis_runs").update({ status: "superseded" }).in("id", priorRunIds);
}

const ENGINEERING_RULE_COUNTABLE_UNITS = new Set([
  "no", "nos", "ea", "each", "unit", "units", "pc", "pcs", "set", "assembly", "point", "points",
]);
const ENGINEERING_RULE_EXCLUDED_QTY_SOURCES = new Set([
  "schedule_quantity", "key_plan_reference", "legend_reference", "typical_detail_reference", "note_reference", "duplicate_reference",
  // calculated_quantity added 2026-08-16. An engineered/calculated line is
  // itself an accessory the AI worked out from a counted device, so letting it
  // trigger a rule derives accessories from accessories. On Heena Khan's sheet
  // 6 that turned 34 doors into 752 access-control items, because the maglock,
  // the 2-door controller and the break-glass unit each re-fired all five
  // "per door" rules that the card reader had already fired.
  // Physically counted items are unaffected, so a sheet with sixteen different
  // camera types still derives sixteen licences -- those are separate cameras,
  // not one device described four ways.
  "calculated_quantity",
]);

// Words too generic to prove two descriptions mean the same equipment. "Door
// Access Controller" and "Access Control Door Controller" must match on
// "controller", not on "door" and "access", or every access-control accessory
// would suppress every other one.
const RULE_COVERAGE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "per", "with", "to", "from", "in", "on", "at", "by",
  "supply", "install", "installation", "testing", "commissioning", "test", "commission",
  "system", "systems", "unit", "units", "type", "typical", "standard", "complete", "including",
  "access", "control", "door", "doors", "backup", "point", "points", "camera", "cameras",
  "surface", "mounted", "wall", "ceiling", "indoor", "outdoor", "new", "each",
]);

function ruleCoverageTokens(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !RULE_COVERAGE_STOPWORDS.has(w));
}

// True when an item the analysis already produced clearly IS the thing this rule
// would add. Requires every significant word of the rule's description to be
// present, because a false positive here silently deletes a BOQ line while a
// false negative merely leaves a visible duplicate.
function ruleAlreadyCoveredBy(ruleDescription: string, existing: any[]): any | null {
  const needed = ruleCoverageTokens(ruleDescription);
  if (!needed.length) return null;
  for (const it of existing) {
    if (it.source === "engineering_rule") continue;   // only real analysis output counts
    const hay = ruleCoverageTokens(it.description);
    if (!hay.length) continue;
    const haySet = new Set(hay);
    if (needed.every((w) => haySet.has(w))) return it;
  }
  return null;
}

const ENGINEERING_RULE_RELATIONAL_BOUNDARY = /\b(for|per|serving|supporting|feeding|connected to|connecting to)\b/i;
function engineeringRuleSubjectText(description: string): string {
  const text = description || "";
  const m = text.match(ENGINEERING_RULE_RELATIONAL_BOUNDARY);
  return m ? text.slice(0, m.index) : text;
}

async function deriveEngineeringItems(admin: any, insertedRows: any[]) {
  const { data: rules } = await admin.from("engineering_rules").select("*");
  if (!rules || !rules.length) return [];

  // Group the analysis's own output by system once, rather than rescanning every
  // row for every rule of every item -- this runs inside the request that the
  // customer is waiting on.
  const sameSystemItems = new Map<string, any[]>();
  for (const it of insertedRows) {
    const key = it.system_category ?? "other";
    if (!sameSystemItems.has(key)) sameSystemItems.set(key, []);
    sameSystemItems.get(key)!.push(it);
  }

  const derived: any[] = [];
  for (const item of insertedRows) {
    const itemUnit = String(item.unit || "").trim().toLowerCase();
    if (!ENGINEERING_RULE_COUNTABLE_UNITS.has(itemUnit)) continue;
    const itemQtySourceType = item.quantity_source_type || "physical_count";
    if (ENGINEERING_RULE_EXCLUDED_QTY_SOURCES.has(itemQtySourceType)) continue;
    if (!(Number(item.quantity) > 0)) continue;
    const itemSubjectText = engineeringRuleSubjectText(item.description).toLowerCase();
    for (const rule of rules) {
      if (rule.system_category !== item.system_category) continue;
      if (!item.description || !itemSubjectText.includes(rule.trigger_keyword.toLowerCase())) continue;

      // A rule exists to fill a gap the drawing left. If the analysis already
      // produced this equipment for the same system, adding the generic version
      // on top is a straight double-count -- and the analysis line is the better
      // one, because it carries the real specification read off the drawing.
      const covered = ruleAlreadyCoveredBy(rule.derived_description, sameSystemItems.get(item.system_category) ?? []);
      if (covered) {
        console.log(`engineering rule "${rule.derived_description}" suppressed: already covered by "${covered.description}" (qty ${covered.quantity})`);
        continue;
      }

      derived.push({
        project_id: item.project_id, drawing_id: item.drawing_id, analysis_run_id: item.analysis_run_id,
        revision_number: item.revision_number, system_category: item.system_category,
        floor_label: item.floor_label, zone: item.zone, room: item.room, area_label: item.area_label,
        building: item.building ?? null,
        description: rule.derived_description, technical_specification: rule.notes,
        quantity: Number(item.quantity || 0) * Number(rule.quantity_per_trigger || 1),
        unit: rule.derived_unit, location: item.location,
        confidence_score: 100, source: "engineering_rule",
        optimization_status: "engineered",
        optimization_note: `Derived from "${item.description}" (qty ${item.quantity}) via engineering rule: ${rule.quantity_per_trigger} per trigger.`,
      });
    }
  }
  // Last guard. Two genuinely different physically-counted triggers can still
  // land on the same accessory row for the same location -- e.g. two separate
  // reader schedules on one drawing. Those quantities SHOULD add up, so this
  // merges rather than discards, and records what it merged so the quantity
  // stays traceable in the Quantity Basis drilldown.
  const byKey = new Map<string, any>();
  for (const d of derived) {
    const key = [d.drawing_id ?? "-", d.revision_number, d.system_category, d.description, d.unit,
                 d.floor_label ?? "-", d.zone ?? "-", d.room ?? "-"].join("|").toLowerCase();
    const hit = byKey.get(key);
    if (!hit) { byKey.set(key, d); continue; }
    hit.quantity = Number(hit.quantity || 0) + Number(d.quantity || 0);
    hit.optimization_note = `${hit.optimization_note} + ${d.optimization_note}`;
  }
  const finalDerived = [...byKey.values()];

  if (finalDerived.length) await admin.from("boq_items").insert(finalDerived);
  return finalDerived;
}

// promoteSoleSourceScheduleRows (2026-08-10). Defence in depth behind the
// prompt rule added to QUANTITY_RECONCILIATION_RULES.
//
// THE FAILURE THIS PREVENTS, observed for real: a Ground Floor CCTV analysis
// returned five camera rows totalling 38 cameras plus 2 ANPR cameras, every one
// tagged quantity_source_type="schedule_quantity". Because schedule rows are
// treated as validation-only and excluded from totals, the customer's BOQ
// counted ZERO cameras -- and deriveEngineeringItems also skips schedule rows,
// so no VMS licences, patch cords or network points were generated either. The
// BOQ looked complete and plausible while missing the entire primary scope,
// which for a tender document is the worst possible failure mode.
//
// A schedule row is only legitimately excludable when it CROSS-CHECKS a real
// physical count of the same item. If no physical_count row describes the same
// item, that schedule row is not a cross-check -- it is the sole evidence the
// equipment exists, and dropping it deletes real scope. Matching is by exact
// description (case-insensitive) rather than system_category, deliberately:
// category is far too coarse. In the real case above the cctv category DID
// contain one physical_count row (the network cabinet), so a category-level
// test would have concluded "a physical count exists here" and left all 38
// cameras excluded -- exactly the bug.
function promoteSoleSourceScheduleRows(rows: any[]): { rows: any[]; promoted: number } {
  const physicalDescriptions = new Set(
    rows
      .filter((r) => (r.quantity_source_type ?? "physical_count") === "physical_count")
      .map((r) => String(r.description ?? "").trim().toLowerCase())
  );
  let promoted = 0;
  const out = rows.map((r) => {
    if (r.quantity_source_type !== "schedule_quantity") return r;
    const desc = String(r.description ?? "").trim().toLowerCase();
    if (physicalDescriptions.has(desc)) return r; // genuine cross-check, leave excluded
    promoted++;
    const note = "Quantity taken from the drawing's equipment schedule, which is the only source for this item (no independent symbol count was produced). Counted toward the BOQ total rather than treated as a validation-only reference, which would have excluded it entirely.";
    return {
      ...r,
      quantity_source_type: "physical_count",
      schedule_quantity_crosscheck: r.schedule_quantity_crosscheck ?? r.quantity ?? null,
      quantity_basis_notes: r.quantity_basis_notes ? `${r.quantity_basis_notes} | ${note}` : note,
    };
  });
  return { rows: out, promoted };
}

// describeError (2026-08-10). `String(err)` renders a plain object as the
// useless literal "[object Object]" -- which is precisely what a customer saw
// on a failed 2F re-analysis, and it destroyed our ability to diagnose it.
// Supabase/PostgREST rejections are plain objects ({message, details, hint,
// code}), NOT Error instances, so they hit exactly that path. This extracts
// something human-readable from every shape we can actually receive.
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as any;
    const parts = [e.message, e.details, e.hint, e.code ? `(code ${e.code})` : null]
      .filter((p) => typeof p === "string" && p.length);
    if (parts.length) return parts.join(" -- ");
    try { return JSON.stringify(err).slice(0, 500); } catch { /* fall through */ }
  }
  return String(err);
}

// sanitizeBoqRow (2026-08-10). Guards the insert against type mismatches
// between what the AI tool schema permits and what the table actually accepts.
// Concrete bug this fixes: schedule_quantity_crosscheck is an INTEGER column,
// but BOQ_ITEM_TOOL previously declared it as {type:"number"}, so a decimal
// from the model was legal in the tool call and fatal at insert time. Because
// rows are inserted as one batch, a single bad value discards the ENTIRE BOQ --
// 30+ good rows lost to one decimal, which is what happened to a customer's 2F
// re-analysis (Claude responded fine; zero rows were written). Coercing here is
// strictly safer than tightening the tool schema alone, since it also covers
// values that arrive as numeric strings.
function toIntOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function toNumOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Mirrors boq_items_quantity_source_type_check. Kept next to the sanitizer so
// the two move together; if the constraint gains a value and this does not,
// the only cost is that the new value is coerced to physical_count rather than
// the insert failing.
const VALID_QUANTITY_SOURCE_TYPES = new Set([
  "physical_count", "schedule_quantity", "key_plan_reference", "legend_reference",
  "typical_detail_reference", "note_reference", "calculated_quantity", "duplicate_reference",
]);

function coerceQuantitySourceType(v: any): string | null {
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  if (VALID_QUANTITY_SOURCE_TYPES.has(s)) return s;
  // Near-misses the model actually produces, mapped rather than dropped so the
  // provenance survives instead of every stray row claiming to be a hand count.
  if (s.includes("schedule")) return "schedule_quantity";
  if (s.includes("legend")) return "legend_reference";
  if (s.includes("note")) return "note_reference";
  if (s.includes("calc") || s.includes("estimat") || s.includes("derived")) return "calculated_quantity";
  if (s.includes("typical") || s.includes("detail")) return "typical_detail_reference";
  if (s.includes("key") || s.includes("plan")) return "key_plan_reference";
  if (s.includes("duplicate")) return "duplicate_reference";
  return "physical_count";
}

// Units that describe a countable thing. A device marker only makes sense on
// these: 350 metres of cable has a route, not 350 positions.
const MARKABLE_UNITS = /^(no|nos|nr|no\.|nos\.|nr\.|pcs|pc|each|ea|unit|units|point|points|set|sets)$/i;
// Eight times the largest legitimate device marker (0.03). Anything bigger is
// the model gesturing at the page, not locating a symbol.
const MAX_MARKER_FRACTION = 0.25;

function cleanPoint(p: any): { x: number; y: number; width?: number; height?: number } | null {
  if (!p || typeof p !== "object") return null;
  const x = Number(p.x), y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const out: any = { x, y };
  const w = Number(p.width), h = Number(p.height);
  if (Number.isFinite(w) && w > 0 && w <= MAX_MARKER_FRACTION) out.width = w;
  if (Number.isFinite(h) && h > 0 && h <= MAX_MARKER_FRACTION) out.height = h;
  return out;
}

function sanitizeCoordinates(coords: any, unit: any, quantity: any): any {
  if (!coords || typeof coords !== "object") return null;

  // A route, an area or a lump sum has no device positions.
  if (!MARKABLE_UNITS.test(String(unit ?? "").trim())) return null;

  const head = cleanPoint(coords);
  if (!head) return null;

  // The signature of an invented position: the exact geometric centre of the
  // sheet. Real measurement does not land on 0.5/0.5 exactly -- a model filling
  // in a field it could not read does. Rejected whatever the box size, because
  // a missing marker costs one absent box while a wrong marker costs confidence
  // in every box on the sheet.
  const w = Number(coords.width) || 0, h = Number(coords.height) || 0;
  if (Math.abs(head.x - 0.5) < 1e-9 && Math.abs(head.y - 0.5) < 1e-9) return null;

  // An oversized box on an otherwise plausible position: keep the position,
  // drop the size and let the viewer apply its own minimum marker box.
  if (w > MAX_MARKER_FRACTION) delete (head as any).width;
  if (h > MAX_MARKER_FRACTION) delete (head as any).height;

  const rest = Array.isArray(coords.instances)
    ? coords.instances.map(cleanPoint).filter(Boolean) as any[]
    : [];

  // Drop repeats of the same point -- they would stack markers on one symbol
  // and inflate the "located" count without locating anything more.
  const all = [head, ...rest];
  const unique: any[] = [];
  for (const p of all) {
    if (!unique.some((u) => Math.abs(u.x - p.x) < 0.002 && Math.abs(u.y - p.y) < 0.002)) unique.push(p);
  }

  // More positions than the item has units means some are wrong; which ones is
  // not knowable here, so the counted quantity wins.
  const qty = Number(quantity);
  const capped = Number.isFinite(qty) && qty > 0 ? unique.slice(0, Math.floor(qty)) : unique;

  const page = Number(coords.page);
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    ...capped[0],
    instances: capped.slice(1),
  };
}

// A dimension read off a material-specification table is not a quantity, and
// millimetres are never a BOQ quantity unit -- nobody buys "1450 mm of
// handrail", they buy a handrail that happens to be 1450 mm long. The model
// reads a table like "PIPE 50 / HANDRAIL / 60.30 OD x 3.91 / LENGTH 1450" and
// puts 1450 in the quantity column with unit "mm", which produces a BOQ a
// quantity surveyor rejects on sight. Seen live on a tunnel-walkway steel
// frame: eight rows, every one a length masquerading as a count, each tagged
// physical_count while its own basis note admitted no count was possible.
//
// Metres are deliberately NOT treated this way -- "850 m of cable" is a real
// and common BOQ line. Only mm and cm are unambiguous.
const DIMENSION_ONLY_UNITS = new Set(["mm", "millimetre", "millimeter", "cm", "centimetre", "centimeter"]);

function rescueDimensionMistakenForQuantity(row: any): any {
  const unit = String(row.unit ?? "").toLowerCase().trim();
  if (!DIMENSION_ONLY_UNITS.has(unit)) return row;
  const value = toNumOrNull(row.quantity);
  if (value == null || value <= 0) return row;

  const mm = unit.startsWith("c") ? value * 10 : value;
  const note = `Quantity not stated on the drawing. The figure ${value} ${unit} was read as a DIMENSION from the material/specification table and has been moved to the length field (${mm} mm); it was not a count of pieces. Enter the number of pieces before pricing this line.`;
  return {
    ...row,
    // Left at 0 on purpose rather than guessed at 1: a zero reads as
    // "to be confirmed" and cannot be priced by accident, where an invented
    // 1 silently becomes a real number in somebody's tender.
    quantity: 0,
    unit: "no",
    length_value: toNumOrNull(row.length_value) ?? mm,
    quantity_source_type: "typical_detail_reference",
    review_status: "pending",
    quantity_basis_notes: row.quantity_basis_notes ? `${note} Original note: ${row.quantity_basis_notes}` : note,
  };
}

function sanitizeBoqRow(row: any): any {
  const r = rescueDimensionMistakenForQuantity(row);
  return {
    ...r,
    coordinates: sanitizeCoordinates(r.coordinates, r.unit, r.quantity),
    quantity_source_type: coerceQuantitySourceType(r.quantity_source_type),
    quantity: toNumOrNull(r.quantity) ?? 0,
    length_value: toNumOrNull(r.length_value),
    area_value: toNumOrNull(r.area_value),
    confidence_score: toNumOrNull(r.confidence_score),
    schedule_quantity_crosscheck: toIntOrNull(r.schedule_quantity_crosscheck),
    revision_number: toIntOrNull(r.revision_number) ?? 1,
  };
}

function defaultOptimizationStatus(it: any): string {
  return it.quantity_source_type === "calculated_quantity" ? "calculated" : "drawing_requirement";
}

async function insertBoqRowsWithSupportingData(
  admin: any,
  rows: any[],
  result: { cost_optimizations?: any[]; assumptions?: any[]; review_items?: any[] },
  projectId: string,
) {
  let inserted: any[] = [];
  if (rows.length) {
    const { data, error } = await admin.from("boq_items").insert(rows).select();
    if (error) throw error;
    inserted = data ?? [];
  }
  const idFor = (itemRef: number | undefined | null) =>
    (itemRef !== undefined && itemRef !== null && inserted[itemRef]) ? inserted[itemRef].id : null;

  const opts = (result.cost_optimizations ?? []).filter((o: any) => o?.title).map((o: any) => ({
    project_id: projectId, boq_item_id: idFor(o.item_ref), title: o.title,
    original_approach: o.original_approach ?? null, optimized_approach: o.optimized_approach ?? null,
    estimated_savings_note: o.estimated_savings_note ?? null,
  }));
  if (opts.length) await admin.from("cost_optimizations").insert(opts);

  const assumps = (result.assumptions ?? []).filter((a: any) => a?.assumption_text).map((a: any) => ({
    project_id: projectId, boq_item_id: idFor(a.item_ref), assumption_text: a.assumption_text,
  }));
  if (assumps.length) await admin.from("boq_assumptions").insert(assumps);

  const reviews = (result.review_items ?? []).filter((r: any) => r?.reason).map((r: any) => ({
    project_id: projectId, boq_item_id: idFor(r.item_ref), reason: r.reason,
  }));
  if (reviews.length) await admin.from("boq_review_items").insert(reviews);

  return inserted;
}

// Email normalisation for the trial-abuse check moved into Postgres
// (normalize_email_for_abuse) on 2026-08-15, so the rule the guard applies
// and the rule this function applied cannot drift apart.


// Company auto-provisioning.
//
// 2026-08-15: this used to read "does a company exist?" and then insert one,
// with no lock. The frontend fires bootstrap_company from more than one place
// on sign-up, so four requests for the same brand-new account all read "no
// company" before any of them wrote one, and all four inserted. One signup
// produced four companies inside 190ms, and the trial-abuse guard was defeated
// the same way -- every request counted zero prior signups for that email.
//
// No rearrangement of this TypeScript can fix that: two concurrent requests can
// always both pass a check made in the application. So the whole thing now
// lives in one Postgres function holding a per-user advisory lock, backed by a
// unique index on companies.created_by_user_id. This helper is a thin call into
// it. That deliberately breaks this codebase's duplicated-per-function
// convention -- correctness here depends on there being exactly one
// implementation, and two copies is what caused the bug.
async function ensureCompanyForUser(admin: any, userId: string, userEmail: string | null | undefined, fullName: string | null | undefined, signupIp: string | null): Promise<string> {
  const { data, error } = await admin.rpc("bootstrap_company_for_user", {
    p_user_id: userId,
    p_email: userEmail ?? null,
    p_full_name: fullName ?? null,
    p_signup_ip: signupIp ?? null,
  });
  if (error) throw error;
  if (!data) throw new Error("bootstrap_company_for_user returned no company id");
  return data as string;
}


async function checkUsageLimit(admin: any, companyId: string, plan: any, kind: "analysis" | "request") {
  const limit = kind === "analysis" ? plan?.monthly_drawing_analyses : plan?.monthly_ai_requests;
  if (limit == null) return { ok: true as const, billing: "free_quota" as const };

  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  let query = admin.from("ai_usage").select("id", { count: "exact", head: true })
    .eq("company_id", companyId).gte("created_at", monthStart.toISOString()).eq("is_admin_assisted", false);
  if (kind === "analysis") query = query.in("action", ["analyze_drawing", "analyze_drawing_tiled", "design_system", "rework"]);
  // "request" counts every row, which would otherwise include price_boq. Those
  // runs are funded by separately purchased search credits, so counting them
  // here would charge the customer twice for one request -- once in searches
  // they paid for and again in the subscription allowance -- and would push
  // chat onto wallet billing early because of usage that was never on the plan.
  // The row is still written; it just is not a plan request.
  else query = query.neq("action", "price_boq");
  const { count } = await query;

  if ((count ?? 0) < limit) return { ok: true as const, billing: "free_quota" as const };

  const { data: co } = await admin.from("companies").select("credit_balance_cents").eq("id", companyId).maybeSingle();
  const creditBalanceCents = co?.credit_balance_cents ?? 0;
  if (creditBalanceCents > 0) return { ok: true as const, billing: "wallet" as const, creditBalanceCents };
  return { ok: false as const, planId: plan?.id, limit, used: count ?? 0, creditBalanceCents };
}

function computeWindowStart(plan: any, company: any): Date {
  if (plan?.quota_period === "trial_window") {
    return company?.trial_start_date ? new Date(company.trial_start_date) : new Date(company?.created_at ?? 0);
  }
  // A hand-granted plan is one gift with an end date, not a subscription that
  // renews, so its allowance must cover the WHOLE grant rather than resetting
  // on the 1st. Without this, granting Individual (30 pages) for 30 days from
  // the 25th would quietly hand over 60 pages.
  if (company?.billing_provider === "manual" && company?.manual_grant_at) {
    const grantStart = new Date(company.manual_grant_at);
    if (!Number.isNaN(grantStart.getTime())) return grantStart;
  }
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  return monthStart;
}

// True once a hand-granted plan has passed its end date. expire_manual_grants()
// reverts these on a schedule; this stops the few minutes in between being
// usable, the same way an expired trial is refused the moment it lapses.
function manualGrantExpired(company: any): boolean {
  if (company?.billing_provider !== "manual") return false;
  if (!company?.manual_grant_expires_at) return false;
  const ends = new Date(company.manual_grant_expires_at).getTime();
  return Number.isFinite(ends) && ends <= Date.now();
}

async function checkPlanLimit(
  admin: any,
  companyId: string,
  plan: any,
  company: any,
  dimension: "drawing_page" | "rework" | "chat",
  requestedUnits: number,
  projectId: string | null = null
): Promise<{ ok: boolean; current: number; limit: number | null; remaining: number; billing?: "wallet"; creditBalanceCents?: number }> {
  if (dimension === "rework") {
    const maxRework = plan?.max_rework_per_project;
    if (maxRework == null) return { ok: true, current: 0, limit: null, remaining: Infinity };
    const { data: drawingRows } = await admin.from("drawings").select("id").eq("project_id", projectId);
    const ids = (drawingRows ?? []).map((d: any) => d.id);
    let current = 0;
    if (ids.length) {
      const { count } = await admin.from("analysis_runs").select("id", { count: "exact", head: true })
        .in("drawing_id", ids).not("change_reason", "is", null).eq("is_admin_assisted", false);
      current = count ?? 0;
    }
    return { ok: current + requestedUnits <= maxRework, current, limit: maxRework, remaining: Math.max(0, maxRework - current) };
  }

  const planMaxValue = dimension === "drawing_page" ? plan?.max_drawing_pages : plan?.max_chat_requests;
  if (planMaxValue == null) return { ok: true, current: 0, limit: null, remaining: Infinity };
  const bonusPages = dimension === "drawing_page" ? Number(company?.bonus_drawing_pages || 0) : 0;
  const maxValue = planMaxValue + bonusPages;

  const windowStart = computeWindowStart(plan, company);
  let current = 0;
  if (dimension === "drawing_page") {
    const { data: rows } = await admin.from("ai_usage").select("page_count")
      // Every action that actually reads a drawing has to be counted here.
      // Until 2026-09-03 this list held only analyze_drawing and rework, so a
      // customer working through the tiled route -- which is the route the app
      // picks automatically for a dense sheet -- accumulated no pages at all
      // and the plan limit never bound. A trial account with a 5-page
      // allowance processed 8 pages that way, every one billed as free quota.
      .eq("company_id", companyId).gte("created_at", windowStart.toISOString())
      .in("action", ["analyze_drawing", "analyze_drawing_tiled", "analyze_drawings_combined", "rework"])
      .eq("is_admin_assisted", false);
    current = (rows ?? []).reduce((s: number, r: any) => s + (r.page_count ?? 0), 0);
  } else {
    const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).gte("created_at", windowStart.toISOString()).eq("action", "chat").eq("is_admin_assisted", false);
    current = count ?? 0;
  }
  const withinIncluded = current + requestedUnits <= maxValue;
  const trueRemaining = Math.max(0, maxValue - current);
  if (withinIncluded) return { ok: true, current, limit: maxValue, remaining: trueRemaining };

  if (plan?.quota_period === "trial_window") {
    return { ok: false, current, limit: maxValue, remaining: trueRemaining };
  }
  const { data: co } = await admin.from("companies").select("credit_balance_cents").eq("id", companyId).maybeSingle();
  const creditBalanceCents = co?.credit_balance_cents ?? 0;
  if (creditBalanceCents > 0) {
    return { ok: true, current, limit: maxValue, remaining: trueRemaining, billing: "wallet", creditBalanceCents };
  }
  return { ok: false, current, limit: maxValue, remaining: trueRemaining, creditBalanceCents };
}

async function recordUsageAndBill(
  admin: any,
  usage: { companyId: string; billing?: "free_quota" | "wallet" | "admin_comp" },
  userId: string,
  projectId: string,
  action: string,
  tokens: { input_tokens: number; output_tokens: number },
  pageCount: number | null = null,
  processingTimeMs: number | null = null,
  isAdminAssisted = false
) {
  const costCents = computeCostCents(tokens.input_tokens, tokens.output_tokens);
  const actualCostCents = computeActualCostCents(tokens.input_tokens, tokens.output_tokens);
  const { data: row } = await admin
    .from("ai_usage")
    .insert({
      company_id: usage.companyId,
      user_id: userId,
      project_id: projectId,
      action,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      cost_cents: costCents,
      actual_cost_cents: actualCostCents,
      page_count: pageCount,
      model_used: ANTHROPIC_MODEL,
      processing_time_ms: processingTimeMs,
      billed_from: usage.billing ?? null,
      is_admin_assisted: isAdminAssisted,
    })
    .select()
    .single();

  if (usage.billing === "wallet" && usage.companyId) {
    await admin.rpc("debit_company_credits", {
      p_company_id: usage.companyId,
      p_amount_cents: costCents,
      p_description: `${action} usage`,
      p_ai_usage_id: row?.id ?? null,
    });
  }
  return costCents;
}

const CALL_TIMEOUT_MS = 380_000;

// Concurrency gates (rewritten 2026-08-10 for real multi-tenant scale).
// The old platform-wide cap of 3 rejected the FOURTH simultaneous user
// anywhere on the platform. It was added after 10 runs failed together at
// ~110s, misread as contention on the shared Anthropic key -- but Anthropic's
// published limits for claude-sonnet-4-5 are 1,000 RPM / 2M ITPM / 400K OTPM
// on the ENTRY tier, so ten concurrent requests is nowhere near any of them.
// The real cause was the output-token truncation bug fixed separately.
// Sizing: each in-flight call emits <=16K output over ~4.5 min (~3,600 OTPM),
// so 400K OTPM is ~110 simultaneous calls; 40 keeps a wide margin.
const MAX_CONCURRENT_AI_CALLS_GLOBAL = 40;
const MAX_CONCURRENT_AI_CALLS_PER_COMPANY = 5;
// Must be LONGER than CALL_TIMEOUT_MS (380s ~= 6.3 min), or the gate stops
// counting runs that are genuinely still in flight. The old 3-minute window
// was SHORTER than the max run duration -- a real bug.
const INFLIGHT_WINDOW_MS = 8 * 60 * 1000;

async function checkConcurrencyGate(admin: any, companyId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const windowStart = new Date(Date.now() - INFLIGHT_WINDOW_MS).toISOString();

  const { count: globalCount } = await admin
    .from("analysis_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "processing")
    .gte("created_at", windowStart);
  if ((globalCount ?? 0) >= MAX_CONCURRENT_AI_CALLS_GLOBAL) {
    return {
      ok: false,
      error: `The AI engine is at full capacity right now (${globalCount} analyses running platform-wide). Your request was not started, and you have not been charged. Please try again in a minute or two.`,
    };
  }

  if (companyId) {
    const { data: companyProjects } = await admin
      .from("projects")
      .select("id")
      .eq("company_id", companyId);
    const projectIds = (companyProjects ?? []).map((p: any) => p.id);
    if (projectIds.length) {
      const { count: companyCount } = await admin
        .from("analysis_runs")
        .select("id", { count: "exact", head: true })
        .eq("status", "processing")
        .gte("created_at", windowStart)
        .in("project_id", projectIds);
      if ((companyCount ?? 0) >= MAX_CONCURRENT_AI_CALLS_PER_COMPANY) {
        return {
          ok: false,
          error: `Your organisation already has ${companyCount} analyses running at once (limit ${MAX_CONCURRENT_AI_CALLS_PER_COMPANY}). This request was not started, and you have not been charged. Wait for one to finish, then try again.`,
        };
      }
    }
  }

  return { ok: true };
}

const RECENT_FAILURE_LOOKBACK_HOURS = 6;
const RECENT_FAILURE_WARN_THRESHOLD = 2;
async function checkRecentFailureHistory(admin: any, drawingId: string, confirmRetry: boolean): Promise<{ ok: true } | { ok: false; error: string; recentFailures: number }> {
  const since = new Date(Date.now() - RECENT_FAILURE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("analysis_runs")
    .select("id", { count: "exact", head: true })
    .eq("drawing_id", drawingId)
    .eq("status", "failed")
    .ilike("error_message", "%timed out%")
    .gte("created_at", since);
  const n = count ?? 0;
  if (n >= RECENT_FAILURE_WARN_THRESHOLD && !confirmRetry) {
    return {
      ok: false,
      recentFailures: n,
      error: `This drawing has already timed out ${n} time${n === 1 ? "" : "s"} in the last ${RECENT_FAILURE_LOOKBACK_HOURS} hours -- each attempt runs the AI for up to ${Math.round(CALL_TIMEOUT_MS / 1000)}s before giving up, and very likely spends real AI cost even when it fails. Retrying the exact same file is unlikely to succeed. Consider splitting this drawing into smaller batches (Classify & Select Pages) or checking with your admin about a longer processing window. If you understand the cost risk and want to retry anyway, confirm to proceed.`,
    };
  }
  return { ok: true };
}

// One sentence, said the same way by every path that can come back empty.
// The tiled and single-sheet analysers already explained themselves; rework and
// combined analysis finished silently with item_count 0, which is what a
// customer reads as "it worked and my drawing has nothing on it".
function emptyResultExplanation(context: string): string {
  return `No BOQ lines came out of this ${context}. That normally means one of three things: the drawing type does not match the sheet -- an MEP or ELV type is read for devices and runs, while Civil, Structural and Architectural are measured for concrete, blockwork, finishes and the rest, so a finishes plan marked Plumbing finds nothing; or the file is a specification, schedule or material list rather than a drawing, in which case upload it on the Specification page where it is read as text; or the sheet is a title page, key plan or index with no devices drawn on it. Re-running the same file will produce the same result, so change the sheet rather than the button.`;
}

// OUT-OF-SCOPE DISCIPLINE GUARD (2026-09-03). Measured across every drawing
// uploaded so far: ELV sheets average 9.7 BOQ lines each (19 drawings, 185
// lines); structural and civil sheets produce either nothing or lines a
// quantity surveyor cannot use. Quantora reads MEP and ELV. Telling somebody
// that after they have spent a page of their trial is telling them too late,
// so this says it before the AI is called and lets them proceed anyway if they
// disagree -- a structural sheet can still carry containment or small power.
//
// Architectural is deliberately NOT gated: an architectural plan very often
// carries the lighting and small-power layout, and one customer's did.
// 2026-10-21: civil, structural and architectural are now taken off by the
// civil path (CIVIL_TAKEOFF_RULES), so nothing is out of scope any more. The
// gate is kept, empty, so the request shape the app knows does not change.
const OUT_OF_SCOPE_DISCIPLINES: string[] = [];

function checkDisciplineScope(
  drawing: any,
  confirmOutOfScope: boolean,
): { ok: true } | { ok: false; error: string; discipline: string } {
  if (confirmOutOfScope) return { ok: true };
  const d = String(drawing?.discipline ?? "").toLowerCase().trim();
  if (!d) return { ok: true };
  const hit = OUT_OF_SCOPE_DISCIPLINES.find((x) => d.includes(x));
  if (!hit) return { ok: true };
  return {
    ok: false,
    discipline: d,
    error: `This drawing is marked as a ${d} drawing. Quantora measures MEP and ELV systems -- electrical, lighting, small power, HVAC, plumbing, drainage, fire alarm, fire fighting, CCTV, access control, structured cabling and the rest. It does not measure structural steelwork, concrete, reinforcement or civil setting-out, so a purely ${d} sheet usually comes back empty or with lines you cannot price.\n\nIf this sheet also carries services -- containment, small power, lighting, or fire devices -- go ahead and confirm, and it will be read for those. If it is purely ${d}, pick an MEP or ELV sheet from the package instead; it will cost you a page either way.`,
  };
}

// EMPTY-RESULT RE-RUN GUARD (2026-09-03). Two trial customers between them
// burned 13 analyses that each returned zero BOQ lines. The engine already
// explains why in the run summary -- "nothing countable for the systems
// Quantora reads was found; if this is a civil, structural or architectural
// drawing, Quantora does not read those yet" -- but the run still finishes as
// "completed", which reads as success. One customer re-ran the same structural
// walkway sheet eight times in seven minutes, spending $0.88 and eight pages of
// a five-page trial allowance to be told nothing eight times.
//
// Re-running an unchanged file through an unchanged prompt cannot produce a
// different answer, so this refuses the second attempt and says what to do
// instead. It follows the same requires_confirmation shape as the timeout
// guard, so a customer who genuinely wants to retry still can.
async function checkEmptyRerun(
  admin: any,
  drawingId: string,
  confirmRerun: boolean,
  civilNow = false,
): Promise<{ ok: true } | { ok: false; error: string; emptyRuns: number }> {
  if (confirmRerun) return { ok: true };
  const { data: priors } = await admin
    .from("analysis_runs")
    .select("id, status, summary")
    .eq("drawing_id", drawingId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(3);
  const rows = priors ?? [];
  if (!rows.length) return { ok: true };

  const emptyRuns = rows.filter((r: any) => {
    const sum = r.summary ?? {};
    if (sum.found_nothing === true) return true;
    return Number(sum.item_count ?? -1) === 0;
  }).length;
  // Only block once the most recent completed run found nothing -- an earlier
  // empty run followed by a good one means the customer already fixed it.
  const latest = rows[0]?.summary ?? {};
  const latestWasEmpty = latest.found_nothing === true || Number(latest.item_count ?? -1) === 0;
  if (!latestWasEmpty) return { ok: true };
  // The type was changed to a civil one since that empty run, so this run is
  // read a different way and is not a repeat (the skirting plan read as Plumbing).
  if (civilNow && latest.civil !== true) return { ok: true };

  return {
    ok: false,
    emptyRuns,
    error: `This drawing has already been analysed ${emptyRuns === 1 ? "once" : `${emptyRuns} times`} and produced no BOQ lines. Running it again on the same file will produce the same empty result and will still cost a page from your allowance.\n\nThe usual reasons are: the drawing type does not match the sheet -- change it to Architectural, Structural or Civil for a sheet of civil works, or to the right MEP/ELV type for services; or the file is a specification, schedule or material list rather than a drawing, in which case upload it on the Specification page where it is read as text; or the drawing is a title sheet, key plan or index with no devices on it.\n\nTry a different sheet from the package, or open the previous run's notes to see exactly what was looked for. If you are sure and want to spend another page anyway, confirm to proceed.`,
  };
}

// AI RESULT CACHE + IDEMPOTENCY (2026-08-10). drawings.file_hash was computed
// client-side on every upload but the backend never consulted it, so identical
// files were re-sent to Claude and re-billed (GF/RF/5F/1F were each uploaded
// twice with byte-identical hashes). The cache key hashes the file bytes
// TOGETHER with the exact prompt text, because the BOQ depends on project
// city/building type/floors/scope and the drawing's discipline -- the same PDF
// in a different project must NOT share a result. Scoped to the same company;
// cross-tenant reuse would be a data leak. PROMPT_VERSION allows deliberate
// invalidation whenever extraction logic improves.
const PROMPT_VERSION = "2026-08-10.v2-equipment-specificity";

async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildCacheKey(fileBytes: Uint8Array, systemPrompt: string, userText: string): Promise<string> {
  const fileHash = await sha256Hex(fileBytes);
  // Separator built via String.fromCharCode rather than a unicode escape: the
  // escape collapses into a real control character when this file is
  // transported as JSON to the deploy API, putting an unprintable byte in the
  // deployed source. This form survives any round-trip and stays plain ASCII.
  const SEP = String.fromCharCode(0);
  return await sha256Hex([fileHash, systemPrompt, userText].join(SEP));
}

async function findCachedRun(admin: any, cacheKey: string, companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const { data: companyProjects } = await admin.from("projects").select("id").eq("company_id", companyId);
  const projectIds = (companyProjects ?? []).map((p: any) => p.id);
  if (!projectIds.length) return null;

  const { data: hit } = await admin
    .from("analysis_runs")
    .select("id")
    .eq("source_file_hash", cacheKey)
    .eq("prompt_version", PROMPT_VERSION)
    .eq("status", "completed")
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return hit?.id ?? null;
}

// Copies EVERY row including engineering_rule-derived ones, and deliberately
// does NOT re-run deriveEngineeringItems afterwards -- re-deriving on top of
// already-copied derived rows would double every accessory.
async function copyCachedResults(
  admin: any,
  cachedRunId: string,
  newRunId: string,
  projectId: string,
  drawingId: string | null,
  revisionNumber: number,
): Promise<number> {
  const { data: cachedItems } = await admin.from("boq_items").select("*").eq("analysis_run_id", cachedRunId);
  if (!cachedItems || !cachedItems.length) return 0;
  const rows = cachedItems.map((it: any) => {
    const copy: any = { ...it };
    delete copy.id;
    delete copy.created_at;
    delete copy.updated_at;
    copy.project_id = projectId;
    copy.drawing_id = drawingId;
    copy.analysis_run_id = newRunId;
    copy.revision_number = revisionNumber;
    return copy;
  });
  const { error } = await admin.from("boq_items").insert(rows);
  if (error) throw error;
  return rows.length;
}

async function findInFlightRun(admin: any, drawingId: string): Promise<{ id: string; revision_number: number } | null> {
  const windowStart = new Date(Date.now() - INFLIGHT_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("analysis_runs")
    .select("id, revision_number")
    .eq("drawing_id", drawingId)
    .eq("status", "processing")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

function runInBackground(work: () => Promise<void>, onFatalError?: (err: unknown) => Promise<void>) {
  const guarded = async () => {
    try {
      await work();
    } catch (err) {
      console.error("Unhandled error in background AI task:", err);
      if (onFatalError) {
        try {
          await onFatalError(err);
        } catch (writeErr) {
          console.error("Also failed to record the fatal background error to the DB:", writeErr);
        }
      }
    }
  };
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") {
    rt.waitUntil(guarded());
  } else {
    guarded();
  }
}

// Raised 8000 -> 16000 after GF.pdf produced EXACTLY 8000 output tokens, i.e.
// hit the old ceiling precisely, truncating Claude's tool-call JSON mid-way.
// Measured throughput is ~59 output tokens/sec, so the 380s budget permits
// roughly 22,000 tokens; 16000 (~270s) doubles capacity with ~110s of headroom.
const MAX_OUTPUT_TOKENS = 16000;

// Anthropic returns 429 when rate-limited and 529 when overloaded, both with a
// retry-after header. Previously either became an immediate hard failure and a
// wasted paid run. ONE retry only, budget-aware: unbounded retries would turn a
// recoverable rate-limit into a hard timeout.
const RETRYABLE_STATUSES = new Set([429, 529]);
const MAX_RETRY_WAIT_MS = 45_000;


// Anthropic's hosted web search. Version string per the current API docs; the
// tool is billed per search ($10 / 1,000) on top of tokens, which is why
// price_boq bounds both the number of lines and max_uses rather than letting a
// large BOQ turn one button into an open-ended bill.
function WEB_SEARCH_TOOL(project: any, maxUses = 12) {
  const tool: any = {
    type: "web_search_20260318",
    name: "web_search",
    // Capped to the paid balance by the caller, so a run can never spend more
    // searches than the customer has bought.
    max_uses: Math.max(1, Math.min(12, Number(maxUses) || 12)),
  };
  // Localised results matter here: a UAE project priced off a US retailer is a
  // different number. Sent only when we actually know where the project is.
  if (project?.country) {
    tool.user_location = {
      type: "approximate",
      country: COUNTRY_TO_ISO2[String(project.country)] ?? undefined,
      city: project.city ?? undefined,
    };
    if (!tool.user_location.country) delete tool.user_location;
  }
  return tool;
}

// Only the countries the compliance library already covers. An unknown country
// simply omits user_location rather than guessing a code, because a wrong
// country code silently prices the job in the wrong market.
const COUNTRY_TO_ISO2: Record<string, string> = {
  "UAE": "AE", "United Arab Emirates": "AE", "Saudi Arabia": "SA", "Qatar": "QA",
  "Kuwait": "KW", "Bahrain": "BH", "Oman": "OM", "India": "IN", "Pakistan": "PK",
  "Sri Lanka": "LK", "Bangladesh": "BD", "Singapore": "SG", "Malaysia": "MY",
  "Indonesia": "ID", "Philippines": "PH", "Thailand": "TH", "Vietnam": "VN",
  "Hong Kong": "HK", "United Kingdom": "GB", "UK": "GB", "United States": "US",
  "USA": "US", "Australia": "AU",
};

const BOQ_PRICE_TOOL = {
  name: "record_boq_prices",
  description: "Record the researched market unit rate for each BOQ line, with the page each price came from.",
  input_schema: {
    type: "object",
    properties: {
      prices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_key: { type: "string", description: "The line_key exactly as given in the request." },
            unit_rate: { type: ["number", "null"], description: "Supply rate per unit in the requested currency. null if no real advertised price was found." },
            source_url: { type: ["string", "null"], description: "The page the price was actually seen on." },
            source_title: { type: ["string", "null"], description: "Name of the supplier or site." },
            matched_product: { type: ["string", "null"], description: "The actual product priced, so a QS can check the match." },
            search_query: { type: ["string", "null"], description: "The search that found it." },
            basis_note: { type: ["string", "null"], description: "What the price excludes (VAT, duty, freight, installation), and any mismatch against the specification." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["line_key", "unit_rate", "confidence"],
        },
      },
    },
    required: ["prices"],
  },
};

async function callClaude(apiKey: string, systemPrompt: string, userContent: any[], tool: any = BOQ_ITEM_TOOL, maxTokens = MAX_OUTPUT_TOKENS, purpose: "drawing" | "design" = "drawing") {
  const overallDeadline = Date.now() + CALL_TIMEOUT_MS;
  const requestBody = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: userContent }],
  });

  const attemptOnce = async (): Promise<Response> => {
    const remainingMs = overallDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Anthropic API call timed out after ${CALL_TIMEOUT_MS / 1000}s. This usually means the request was too large (e.g. too many drawings combined at once, or a very large file) -- try analyzing fewer/smaller drawings at a time.`);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remainingMs);
    try {
      return await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (fetchErr: any) {
      if (fetchErr?.name === "AbortError") {
        throw new Error(`Anthropic API call timed out after ${CALL_TIMEOUT_MS / 1000}s. This usually means the request was too large (e.g. too many drawings combined at once, or a very large file) -- try analyzing fewer/smaller drawings at a time.`);
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let res = await attemptOnce();

  if (RETRYABLE_STATUSES.has(res.status)) {
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfterMs = retryAfterRaw && !Number.isNaN(Number(retryAfterRaw))
      ? Number(retryAfterRaw) * 1000
      : 5_000;
    const budgetLeftMs = overallDeadline - Date.now();
    if (retryAfterMs <= MAX_RETRY_WAIT_MS && budgetLeftMs > retryAfterMs + 60_000) {
      console.warn(`Anthropic returned ${res.status}; retrying once after ${retryAfterMs}ms per retry-after.`);
      await new Promise((r) => setTimeout(r, retryAfterMs));
      res = await attemptOnce();
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      throw new Error(`The AI service is rate-limited right now and did not complete your analysis. You have not been charged for a result. Please try again in a few minutes. (Anthropic 429: ${errText.slice(0, 300)})`);
    }
    if (res.status === 529) {
      throw new Error(`The AI service is temporarily overloaded and did not complete your analysis. You have not been charged for a result. Please try again shortly. (Anthropic 529)`);
    }
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const toolUse = data.content?.find((c: any) => c.type === "tool_use");
  if (!toolUse) throw new Error("AI did not return structured data.");

  // Truncation guard. When Claude runs out of output budget mid-tool-call,
  // Anthropic sets stop_reason="max_tokens" and returns partial JSON. The
  // dangerous case is not the loud TypeError -- it is SILENT DATA LOSS, where
  // the partial JSON still parses into a valid but SHORT items array and the
  // run "completes" with a BOQ quietly missing line items. Refuse entirely.
  const isClassification = tool === PAGE_CLASSIFICATION_TOOL;
  const isLegend = tool === TILE_LEGEND_TOOL;
  const expectedArrayKey = isClassification ? "pages" : isLegend ? "legend_entries" : "items";

  if (data.stop_reason === "max_tokens") {
    const err = new Error(
      isLegend
        ? `Reading this sheet's symbol legend produced more output than fits in a single AI response (hit the ${maxTokens.toLocaleString()}-token output limit). The legend was rejected rather than used half-read.`
        : isClassification
        ? `This drawing package has too many pages to classify in a single AI response (hit the ${maxTokens.toLocaleString()}-token output limit), so the page list came back incomplete and was rejected rather than saved with pages missing. Please split the package into smaller files before uploading.`
        : purpose === "design"
        // A design run has no drawing, so telling the customer to split one is
        // advice they cannot act on. This is what wiqarbaig was shown.
        ? `This design produced more Bill of Quantities detail than fits in a single AI response (hit the ${maxTokens.toLocaleString()}-token output limit), so it was rejected rather than saved as a partial BOQ. Narrow the brief and run it again: untick areas that are out of scope, or design one system at a time rather than a whole package in a single run.`
        : `This drawing produced more Bill of Quantities detail than fits in a single AI response (hit the ${maxTokens.toLocaleString()}-token output limit), so the result was incomplete and has been rejected rather than saved as a partial BOQ. Use "Classify & Select Pages" to analyze fewer pages per run, or split this drawing by system (e.g. run CCTV and fire alarm separately) so each analysis returns a complete list.`
    );
    // Anthropic charged for every one of those tokens. Attaching the usage to
    // the error is what lets the caller bill a failed run instead of losing it.
    (err as any).usage = { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 };
    throw err;
  }

  const payload = toolUse.input as any;
  if (!payload || !Array.isArray(payload[expectedArrayKey])) {
    throw new Error(
      `The AI response was incomplete or malformed (expected a "${expectedArrayKey}" list and did not get one), so nothing was saved. Please try again; if it keeps happening on the same drawing, analyze fewer pages at a time.`
    );
  }

  return {
    result: payload,
    usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
  };
}

function planLimitMessage(usage: any, kind: "analysis" | "request") {
  const noun = kind === "analysis" ? "drawing analyses/designs" : "AI requests";
  const balance = ((usage.creditBalanceCents ?? 0) / 100).toFixed(2);
  return `You've used your ${usage.used}/${usage.limit} free ${noun} this month on the ${usage.planId} plan, and your AI credit balance is $${balance}. Buy credits to continue.`;
}

function pageLimitMessage(check: { current: number; limit: number | null; remaining: number; creditBalanceCents?: number }, requestedPages: number, plan?: any) {
  if (check.limit == null) return "";
  const isTrial = plan?.quota_period === "trial_window";
  if (isTrial) {
    const days = plan?.trial_duration_days ?? 2;
    if (check.current >= check.limit) {
      return `You've used all ${check.limit} AI-processed pages included in your ${days}-day free trial (${check.current}/${check.limit} used). Upgrade to a paid plan to keep processing pages.`;
    }
    return `Your ${days}-day free trial includes ${check.limit} AI-processed pages total (${check.current}/${check.limit} used, ${check.remaining} remaining). This request needs ${requestedPages} pages — please select fewer pages, or upgrade to a paid plan to continue.`;
  }
  if (check.current >= check.limit) {
    const balance = ((check.creditBalanceCents ?? 0) / 100).toFixed(2);
    return `You've used your plan's included AI page allowance (${check.current}/${check.limit} pages) and your pay-as-you-go credit balance is $${balance}. Add credits to keep processing pages, or upgrade your plan.`;
  }
  return `Your plan includes ${check.limit} AI-processed pages/month (${check.current}/${check.limit} used, ${check.remaining} remaining). This request needs ${requestedPages} pages — please select fewer pages, add pay-as-you-go credits, or upgrade your plan.`;
}

function reworkLimitMessage(check: { current: number; limit: number | null }) {
  return `You've reached your plan's rework limit for this project (${check.current}/${check.limit} cycles used). Upgrade to continue revising this analysis.`;
}

function chatLimitMessage(check: { current: number; limit: number | null; creditBalanceCents?: number }, plan?: any) {
  if (plan?.quota_period === "trial_window") {
    const days = plan?.trial_duration_days ?? 2;
    return `You've used all ${check.limit} AI chat requests included in your ${days}-day free trial (${check.current}/${check.limit} used). Upgrade to a paid plan to keep chatting.`;
  }
  const balance = ((check.creditBalanceCents ?? 0) / 100).toFixed(2);
  return `You've used your plan's included AI chat allowance (${check.current}/${check.limit} requests) and your pay-as-you-go credit balance is $${balance}. Add credits to keep chatting, or upgrade your plan.`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const userId = userData.user.id;
    const userEmail = userData.user.email;
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: secretRow, error: secretErr } = await admin
      .from("app_secrets")
      .select("value")
      .eq("key", "ANTHROPIC_API_KEY")
      .maybeSingle();
    if (secretErr || !secretRow) {
      return jsonResponse({ error: "AI engine not configured: ANTHROPIC_API_KEY secret missing." }, 500);
    }
    const anthropicKey = secretRow.value;

    const body = await req.json();
    const action = body.action as string;

    const isAdminOverride = body.admin_override === true;
    let companyId: string, project: any, company: any, plan: any;

    if (isAdminOverride) {
      const { data: adminRow } = await admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
      if (!adminRow) {
        return jsonResponse({ error: "Forbidden: platform admin access only." }, 403);
      }
      const targetProjectId = body.target_project_id as string;
      if (!targetProjectId) {
        return jsonResponse({ error: "target_project_id is required for admin_override requests." }, 400);
      }
      const { data: proj, error: projErr } = await admin.from("projects").select("*").eq("id", targetProjectId).maybeSingle();
      if (projErr || !proj) {
        return jsonResponse({ error: "Project not found." }, 404);
      }
      project = proj;
      companyId = proj.company_id;
      if (!companyId) {
        return jsonResponse({ error: "This project has no associated company on record, so Admin Assist can't run against it." }, 400);
      }
      const { data: co } = await admin.from("companies").select("*").eq("id", companyId).maybeSingle();
      company = co;
      const { data: pl } = await admin.from("plans").select("*").eq("id", company?.plan ?? "free").maybeSingle();
      plan = pl;
    } else {
      companyId = await ensureCompanyForUser(admin, userId, userEmail, null, clientIp);
      const { data: co } = await admin.from("companies").select("*").eq("id", companyId).maybeSingle();
      company = co;
      const { data: pl } = await admin.from("plans").select("*").eq("id", company?.plan ?? "free").maybeSingle();
      plan = pl;

      if (manualGrantExpired(company)) {
        return jsonResponse({
          error: `The complimentary ${plan?.name ?? "plan"} access on this account ended on `
            + `${new Date(company.manual_grant_expires_at).toLocaleDateString()}. `
            + `Subscribe to continue using AI features.`,
          code: "plan-limit-reached",
        }, 429);
      }

      if (plan?.is_trial && company?.trial_end_date && new Date(company.trial_end_date).getTime() < Date.now()) {
        return jsonResponse({
          error: `Your ${plan?.trial_duration_days ?? 2}-day Quantora free trial ended on ${new Date(company.trial_end_date).toLocaleDateString()}. Upgrade to continue using AI features.`,
        }, 403);
      }

      const { data: proj, error: projErr } = await admin
        .from("projects")
        .select("*")
        .eq("id", body.project_id)
        .eq("owner_id", userId)
        .maybeSingle();
      if (projErr || !proj) {
        return jsonResponse({ error: "Project not found or access denied." }, 404);
      }
      project = proj;
    }

    const projectContext = `Project context:\n- Project name: ${project.project_name}\n- Building type: ${project.building_type}\n- Location: ${project.city}, ${project.country}\n- Number of floors: ${project.number_of_floors ?? "unspecified"}\n- Area size: ${project.area_size ?? "unspecified"} ${project.area_unit ?? ""}\n- Project scope: ${project.project_scope ?? "unspecified"}\n- Required systems: ${(project.required_systems ?? []).join(", ") || "unspecified"}\nUse local UAE/regional norms (DEWA, Dubai Civil Defence, SIRA, TRA, ADDC, etc. as applicable to the stated city/country) to inform coverage, spacing, and specification choices when relevant.`;

    if (action === "classify_pages") {
      const { drawing_id, force } = body as { drawing_id: string; force?: boolean };
      const { data: drawing, error: dErr } = await admin.from("drawings").select("*").eq("id", drawing_id).eq("project_id", project.id).maybeSingle();
      if (dErr || !drawing) throw new Error("Drawing not found.");

      if (!force && drawing.classification_status === "classified") {
        const { data: pages } = await admin.from("drawing_pages").select("*").eq("drawing_id", drawing_id).order("page_number");
        return jsonResponse({ cached: true, total_pages: drawing.total_pages_detected, pages: pages ?? [] });
      }

      const { data: fileBlob, error: dlErr } = await admin.storage.from("drawings").download(drawing.storage_path);
      if (dlErr || !fileBlob) throw new Error("Could not read drawing file from storage.");
      const arrayBuf = await fileBlob.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuf);
      if (fileBytes.length > MAX_FILE_BYTES) {
        throw new Error(`This file is ${(fileBytes.length / 1024 / 1024).toFixed(1)}MB, which is over the ${MAX_FILE_BYTES / 1024 / 1024}MB per-file limit for AI processing. Please split it into smaller files before uploading.`);
      }
      const isPdf = drawing.file_name.toLowerCase().endsWith(".pdf");

      if (!isPdf) {
        await admin.from("drawing_pages").delete().eq("drawing_id", drawing_id);
        await admin.from("drawing_pages").insert({
          drawing_id, page_number: 1, detected_system_category: drawing.discipline ?? "general", page_label: drawing.file_name,
        });
        await admin.from("drawings").update({ total_pages_detected: 1, classification_status: "classified" }).eq("id", drawing_id);
        return jsonResponse({ cached: false, total_pages: 1, pages: [{ page_number: 1, detected_system_category: drawing.discipline ?? "general" }] });
      }

      const estimatedPages = estimatePageCount(fileBytes, true);
      if (estimatedPages > MAX_CLASSIFY_PAGES) {
        return jsonResponse({ error: `This drawing package has an estimated ${estimatedPages} pages, which is over the ${MAX_CLASSIFY_PAGES}-page classification limit. Please split it into smaller packages before uploading.` }, 400);
      }

      await admin.from("drawings").update({ classification_status: "classifying" }).eq("id", drawing_id);

      runInBackground(async () => {
        const b64 = bytesToBase64(fileBytes);
        const systemPrompt = `You are classifying every page of a multi-page construction drawing set by which building system or discipline it primarily depicts. Be precise and consistent — use the same category for pages that clearly belong to the same system (e.g. all CCTV layout pages get "cctv"). Use "architectural" or "structural" for base/architectural drawings with no specific MEP/ELV system, and "general" only if truly indeterminate.`;
        const userContent = [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
          { type: "text", text: `Classify all ${estimatedPages} (approx.) pages of this drawing package via record_page_classifications.` },
        ];

        const startTime = Date.now();
        let classifyResult;
        try {
          classifyResult = await callClaude(anthropicKey, systemPrompt, userContent, PAGE_CLASSIFICATION_TOOL, 4000);
        } catch (aiErr) {
          console.error(`classify_pages failed for drawing ${drawing_id}:`, aiErr);
          await admin.from("drawings").update({ classification_status: "failed" }).eq("id", drawing_id);
          return;
        }
        const elapsedMs = Date.now() - startTime;

        const { total_pages, pages } = classifyResult.result as { total_pages: number; pages: any[] };
        await admin.from("drawing_pages").delete().eq("drawing_id", drawing_id);
        if (pages?.length) {
          await admin.from("drawing_pages").insert(
            pages.map((p: any) => ({
              drawing_id, page_number: p.page_number, detected_system_category: p.system_category, page_label: p.page_label ?? null,
            }))
          );
        }
        await admin.from("drawings").update({ total_pages_detected: total_pages ?? pages?.length ?? estimatedPages, classification_status: "classified" }).eq("id", drawing_id);

        await recordUsageAndBill(admin, { companyId, billing: isAdminOverride ? "admin_comp" : "free_quota" }, userId, project.id, "classify_pages", classifyResult.usage, total_pages ?? pages?.length ?? estimatedPages, elapsedMs, isAdminOverride);
      }, async () => {
        await admin.from("drawings").update({ classification_status: "failed" }).eq("id", drawing_id).eq("classification_status", "classifying");
      });

      return jsonResponse({ cached: false, background: true, status: "classifying", drawing_id, estimated_pages: estimatedPages });
    }

    if (action === "analyze_drawing") {
      const legacyUsage = isAdminOverride ? { ok: true as const, billing: "admin_comp" as const } : await checkUsageLimit(admin, companyId, plan, "analysis");
      if (!legacyUsage.ok) {
        return jsonResponse({ error: planLimitMessage(legacyUsage, "analysis") }, 429);
      }
      const concurrencyCheck = await checkConcurrencyGate(admin, companyId);
      if (!concurrencyCheck.ok) {
        return jsonResponse({ error: concurrencyCheck.error }, 429);
      }
      const { drawing_id, page_selection, confirm_retry_after_failures, confirm_rerun, confirm_out_of_scope } = body as { drawing_id: string; page_selection?: number[]; confirm_retry_after_failures?: boolean; confirm_rerun?: boolean; confirm_out_of_scope?: boolean };
      const { data: drawing, error: dErr } = await admin.from("drawings").select("*").eq("id", drawing_id).eq("project_id", project.id).maybeSingle();
      if (dErr || !drawing) throw new Error("Drawing not found.");

      const failureHistoryCheck = isAdminOverride ? { ok: true as const } : await checkRecentFailureHistory(admin, drawing_id, !!confirm_retry_after_failures);
      if (!failureHistoryCheck.ok) {
        return jsonResponse({ error: failureHistoryCheck.error, requires_confirmation: true, recent_failures: failureHistoryCheck.recentFailures }, 429);
      }

      const emptyRerunCheck = isAdminOverride ? { ok: true as const } : await checkEmptyRerun(admin, drawing_id, !!confirm_rerun, isCivilDrawing(drawing));
      if (!emptyRerunCheck.ok) {
        return jsonResponse({ error: emptyRerunCheck.error, requires_confirmation: true, confirm_field: "confirm_rerun", empty_runs: emptyRerunCheck.emptyRuns }, 429);
      }

      const scopeCheck = isAdminOverride ? { ok: true as const } : checkDisciplineScope(drawing, !!confirm_out_of_scope);
      if (!scopeCheck.ok) {
        return jsonResponse({ error: scopeCheck.error, requires_confirmation: true, confirm_field: "confirm_out_of_scope", discipline: scopeCheck.discipline }, 429);
      }

      const { data: fileBlob, error: dlErr } = await admin.storage.from("drawings").download(drawing.storage_path);
      if (dlErr || !fileBlob) throw new Error("Could not read drawing file from storage.");
      const arrayBuf = await fileBlob.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuf);
      if (fileBytes.length > MAX_FILE_BYTES) {
        throw new Error(`This file is ${(fileBytes.length / 1024 / 1024).toFixed(1)}MB, which is over the ${MAX_FILE_BYTES / 1024 / 1024}MB per-file limit for AI processing. Please split it into smaller files before uploading.`);
      }
      const isPdf = drawing.file_name.toLowerCase().endsWith(".pdf");

      const hasSelection = isPdf && Array.isArray(page_selection) && page_selection.length > 0;
      const requestedPages = hasSelection ? page_selection!.length : estimatePageCount(fileBytes, isPdf);

      const pageCheck = isAdminOverride ? { ok: true, current: 0, limit: null, remaining: Infinity } : await checkPlanLimit(admin, companyId, plan, company, "drawing_page", requestedPages);
      if (!pageCheck.ok) {
        return jsonResponse({ error: pageLimitMessage(pageCheck, requestedPages, plan) }, 429);
      }

      const alreadyRunning = await findInFlightRun(admin, drawing_id);
      if (alreadyRunning) {
        return jsonResponse({
          run_id: alreadyRunning.id,
          revision_number: alreadyRunning.revision_number,
          background: true,
          status: "processing",
          reused_existing_run: true,
          pages_processed: requestedPages,
        });
      }

      const { data: priorRuns } = await admin.from("analysis_runs").select("revision_number").eq("drawing_id", drawing_id).order("revision_number", { ascending: false }).limit(1);
      const nextRevision = (priorRuns && priorRuns[0]?.revision_number ? priorRuns[0].revision_number : 0) + 1;

      const { data: run, error: runErr } = await admin.from("analysis_runs").insert({
        project_id: project.id, drawing_id, revision_number: nextRevision, status: "processing", triggered_by: userId,
        is_admin_assisted: isAdminOverride, prompt_version: PROMPT_VERSION,
      }).select().single();
      if (runErr) throw runErr;

      runInBackground(async () => {
        let processingBytes = fileBytes;
        let usingSelection = false;
        if (hasSelection) {
          try {
            processingBytes = await extractSelectedPages(fileBytes, page_selection!);
            usingSelection = true;
          } catch (splitErr) {
            console.error("pdf-lib page split failed, falling back to full document:", splitErr);
          }
        }
        const fileContent = buildFileContentBlock(drawing.file_name, processingBytes);
        const coordsInstruction = (fileContent.kind === "dxf" || fileContent.kind === "ifc")
          ? `This is raw ${fileContent.kind.toUpperCase()} exchange-format text, not a rendered drawing image, so omit "coordinates" for every item (there is no page image to reference).`
          : MARKUP_COORDS_INSTRUCTION;
        let civil = isCivilDrawing(drawing);
        let autoTypedNote = "";
        if (!civil && requestedPages <= 2 && (fileContent.kind === "pdf" || fileContent.kind === "image")) {
          const sheet = await detectSheetKind(anthropicKey, fileContent.block);
          if (sheet && ["architectural", "structural", "civil"].includes(sheet.kind)) {
            civil = true;
            autoTypedNote = `This sheet was uploaded as ${drawing.discipline ?? "unspecified"} but shows ${sheet.kind} work and no MEP or ELV items (${sheet.reason}), so it was measured as civil works and its type was changed to ${sheet.kind}. `;
            await admin.from("drawings").update({ discipline: sheet.kind }).eq("id", drawing_id);
            drawing.discipline = sheet.kind;
          }
        }
        const takeoffTool = civil ? CIVIL_BOQ_TOOL : BOQ_ITEM_TOOL;
        const userContent = [
          fileContent.block,
          {
            type: "text",
            text: civil
              ? civilUserText(drawing, usingSelection, page_selection?.length ?? 0, (fileContent.kind === "dxf" || fileContent.kind === "ifc") ? coordsInstruction : CIVIL_COORDS_INSTRUCTION)
              : `Analyze this ${drawing.discipline ?? "construction"} drawing${drawing.floor_label ? ` for ${drawing.floor_label}` : ""}${usingSelection ? ` (${page_selection!.length} selected pages)` : ""}. Identify every relevant system item (equipment, fixtures, devices, cable/pipe runs, symbols, schedules, legends). Count quantities precisely from what is visible/present in the data. Produce Bill of Quantities line items via the record_boq_items tool, following standard BOQ conventions (item description, technical spec, qty, unit, length/area where relevant, location, accessories, consumables, testing & commissioning requirements). Assign an honest confidence_score per item — lower it whenever the source is unclear, cropped, low resolution, or ambiguous. ${coordsInstruction}`,
          },
        ];
        const systemPrompt = civil ? civilSystemPrompt(projectContext) : `You are an expert AI Quantity Surveyor and MEP/ELV design engineer analyzing construction drawings to produce accurate Bills of Quantities. ${projectContext}${QUANTITY_RECONCILIATION_RULES}${MASTER_BOQ_ENGINE_RULES}`;

        const userTextForKey = (userContent[1] as any)?.text ?? "";
        const cacheKey = await buildCacheKey(processingBytes, systemPrompt, userTextForKey);
        await admin.from("analysis_runs").update({ source_file_hash: cacheKey }).eq("id", run.id);

        const cachedRunId = isAdminOverride ? null : await findCachedRun(admin, cacheKey, companyId);
        if (cachedRunId) {
          const copied = await copyCachedResults(admin, cachedRunId, run.id, project.id, drawing_id, nextRevision);
          await admin.from("analysis_runs").update({
            status: "completed", completed_at: new Date().toISOString(),
            summary: {
              item_count: copied,
              derived_item_count: 0,
              notes: "Reused the result of an earlier identical analysis of this exact file and project settings. No AI charge was incurred for this run.",
              served_from_cache: true,
              cached_from_run_id: cachedRunId,
            },
          }).eq("id", run.id);
          await admin.from("drawings").update({ pages_ai_processed: (drawing.pages_ai_processed ?? 0) + requestedPages }).eq("id", drawing_id);
          if (usingSelection) {
            await admin.from("drawing_pages").update({ selected: true, ai_processed: true }).eq("drawing_id", drawing_id).in("page_number", page_selection!);
          }
          return;
        }

        const startTime = Date.now();
        let parsed;
        try {
          parsed = await callClaude(anthropicKey, systemPrompt, userContent, takeoffTool);
        } catch (aiErr) {
          await admin.from("analysis_runs").update({ status: "failed", error_message: describeError(aiErr) }).eq("id", run.id);
          return;
        }
        const elapsedMs = Date.now() - startTime;
        const result = parsed.result as { items: any[]; analysis_notes: string; document_kind?: string; cost_optimizations?: any[]; assumptions?: any[]; review_items?: any[] };
        const civilNote = civil ? applyCivilFinalize(result) : "";
        if (civilNote) result.analysis_notes = `${result.analysis_notes ?? ""}${civilNote}`;

        // Right reasoning, wrong field: the model describes a typical detail in its
        // own basis note and then files the row as a physical count.
        // The wrong kind of file entirely. Stop here rather than reporting a
        // successful run that counted nothing out of prose.
        const wrongKind = wrongFileKindMessage(String(result.document_kind ?? "drawing"), result.analysis_notes);
        if (wrongKind && !(result.items || []).length) {
          await admin.from("analysis_runs").update({ status: "failed", error_message: wrongKind }).eq("id", run.id);
          return;
        }

        const typicalFixed = reclassifyTypicalDetailRows(result.items || []);
        if (typicalFixed) console.warn(`reclassifyTypicalDetailRows: ${typicalFixed} row(s) moved to typical_detail_reference.`);

        const rows = result.items.map((it: any) => ({
          project_id: project.id, drawing_id, analysis_run_id: run.id, revision_number: nextRevision,
          system_category: it.system_category ?? "other", floor_label: it.floor_label ?? drawing.floor_label,
          zone: it.zone, room: it.room, area_label: it.area_label, item_no: it.item_no,
          description: it.description, technical_specification: it.technical_specification,
          manufacturer: it.manufacturer ?? null, model_number: it.model_number ?? null,
          subsystem: it.subsystem ?? null, building: it.building ?? null,
          from_location: it.from_location ?? null, to_location: it.to_location ?? null,
          optimization_status: it.optimization_status ?? defaultOptimizationStatus(it), optimization_note: it.optimization_note ?? null,
          quantity: it.quantity ?? 0, unit: it.unit ?? "nos", length_value: it.length_value, area_value: it.area_value,
          location: it.location, installation_accessories: it.installation_accessories, consumables: it.consumables,
          testing_requirements: it.testing_requirements, commissioning_requirements: it.commissioning_requirements,
          confidence_score: it.confidence_score ?? 70, source: "ai_drawing_analysis",
          coordinates: it.coordinates ?? null,
          quantity_source_type: it.quantity_source_type ?? "physical_count",
          schedule_quantity_crosscheck: it.schedule_quantity_crosscheck ?? null,
          quantity_basis_notes: it.quantity_basis_notes ?? null,
        }));
        const { rows: promotedRows, promoted: promotedScheduleRows } = promoteSoleSourceScheduleRows(rows);
        if (promotedScheduleRows > 0) {
          console.warn(`promoteSoleSourceScheduleRows: reclassified ${promotedScheduleRows} schedule-only row(s) to physical_count so they count toward the BOQ.`);
        }
        const safeRows = promotedRows.map(sanitizeBoqRow);
        const inserted = await insertBoqRowsWithSupportingData(admin, safeRows, result, project.id);
        const derived = await deriveEngineeringItems(admin, inserted);

        await admin.from("analysis_runs").update({
          status: "completed", completed_at: new Date().toISOString(),
          summary: {
            item_count: safeRows.length, derived_item_count: derived.length,
            typical_detail_rows: typicalFixed,
            found_nothing: safeRows.length === 0,
            civil,
            notes: autoTypedNote + (safeRows.length === 0 && civil
              ? `No BOQ items were produced. No measurable civil, structural or architectural work (concrete, blockwork, finishes, skirting, doors, external works) with readable dimensions was found on this sheet. ${result.analysis_notes ?? ""}`.trim()
              : safeRows.length === 0
              ? `No BOQ items were produced. Nothing countable for the systems Quantora reads (MEP and ELV — cameras, readers, detectors, luminaires, panels, cable, containment, ducting, pipework) was found in this file. If it is a civil, structural or architectural drawing, set its type to Civil, Structural or Architectural so it is measured as civil works. If it is a specification or a schedule rather than a drawing, upload it on the Specification page instead. What the AI saw: ${result.analysis_notes ?? "(no notes)"}`
              : (typicalFixed
                  ? `${result.analysis_notes ?? ""} ${typicalFixed} row(s) were recorded as typical-detail references rather than counted quantities: a typical detail shows how an item is built once, not how many the project contains.`.trim()
                  : result.analysis_notes)),
          },
        }).eq("id", run.id);
        await recordUsageAndBill(admin, { companyId, billing: pageCheck.billing === "wallet" ? "wallet" : legacyUsage.billing }, userId, project.id, "analyze_drawing", parsed.usage, requestedPages, elapsedMs, isAdminOverride);
        await admin.from("drawings").update({ pages_ai_processed: (drawing.pages_ai_processed ?? 0) + requestedPages }).eq("id", drawing_id);
        if (usingSelection) {
          await admin.from("drawing_pages").update({ selected: true, ai_processed: true }).eq("drawing_id", drawing_id).in("page_number", page_selection!);
        }
      }, async (err) => {
        await admin.from("analysis_runs").update({
          status: "failed",
          error_message: `Unexpected error while finishing this analysis (Claude responded, but saving the results failed): ${describeError(err)}`,
        }).eq("id", run.id).eq("status", "processing");
      });

      return jsonResponse({ run_id: run.id, revision_number: nextRevision, background: true, status: "processing", pages_processed: requestedPages });
    }

    if (action === "analyze_drawing_tiled") {
      const legacyUsage = isAdminOverride ? { ok: true as const, billing: "admin_comp" as const } : await checkUsageLimit(admin, companyId, plan, "analysis");
      if (!legacyUsage.ok) {
        return jsonResponse({ error: planLimitMessage(legacyUsage, "analysis") }, 429);
      }
      const concurrencyCheck = await checkConcurrencyGate(admin, companyId);
      if (!concurrencyCheck.ok) {
        return jsonResponse({ error: concurrencyCheck.error }, 429);
      }

      const { drawing_id, page_number, tiles: rawTiles, grid, confirm_retry_after_failures, confirm_rerun, confirm_out_of_scope } = body as {
        drawing_id: string; page_number?: number; tiles: any[]; grid?: { rows: number; cols: number };
        confirm_retry_after_failures?: boolean; confirm_rerun?: boolean; confirm_out_of_scope?: boolean;
      };
      const { data: drawing, error: dErr } = await admin.from("drawings").select("*").eq("id", drawing_id).eq("project_id", project.id).maybeSingle();
      if (dErr || !drawing) throw new Error("Drawing not found.");
      // Civil sheets are measured from the whole sheet: a tile cuts dimension
      // strings and room outlines in half. The app sends them to analyze_drawing.
      if (isCivilDrawing(drawing)) {
        return jsonResponse({ error: "Civil, structural and architectural drawings are measured from the whole sheet, not in tiles. Reload the page and press Analyze again." }, 400);
      }

      let tiles: TileSpec[];
      try {
        tiles = validateTiles(rawTiles);
      } catch (vErr) {
        return jsonResponse({ error: describeError(vErr) }, 400);
      }

      // Tiles are uploaded by the browser into the caller's own project folder.
      // Storage RLS already enforces that on write; this re-checks it on read so
      // a hand-crafted request cannot point the analyser at another tenant's
      // files and have the service-role client happily fetch them.
      const badPath = tiles.find((t) => !t.path.startsWith(`${project.id}/`));
      if (badPath) {
        return jsonResponse({ error: "Tile paths must sit inside this project's own storage folder." }, 400);
      }

      const failureHistoryCheck = isAdminOverride ? { ok: true as const } : await checkRecentFailureHistory(admin, drawing_id, !!confirm_retry_after_failures);
      if (!failureHistoryCheck.ok) {
        return jsonResponse({ error: failureHistoryCheck.error, requires_confirmation: true, recent_failures: failureHistoryCheck.recentFailures }, 429);
      }

      const emptyRerunCheck = isAdminOverride ? { ok: true as const } : await checkEmptyRerun(admin, drawing_id, !!confirm_rerun, isCivilDrawing(drawing));
      if (!emptyRerunCheck.ok) {
        return jsonResponse({ error: emptyRerunCheck.error, requires_confirmation: true, confirm_field: "confirm_rerun", empty_runs: emptyRerunCheck.emptyRuns }, 429);
      }

      const scopeCheck = isAdminOverride ? { ok: true as const } : checkDisciplineScope(drawing, !!confirm_out_of_scope);
      if (!scopeCheck.ok) {
        return jsonResponse({ error: scopeCheck.error, requires_confirmation: true, confirm_field: "confirm_out_of_scope", discipline: scopeCheck.discipline }, 429);
      }

      // One sheet is one page against the customer's quota, however many tiles
      // it took to read it. The extra tiles are our cost of doing the job
      // properly, not something to bill the customer twice for.
      const requestedPages = 1;
      const pageCheck = isAdminOverride ? { ok: true, current: 0, limit: null, remaining: Infinity } : await checkPlanLimit(admin, companyId, plan, company, "drawing_page", requestedPages);
      if (!pageCheck.ok) {
        return jsonResponse({ error: pageLimitMessage(pageCheck, requestedPages, plan) }, 429);
      }

      const alreadyRunning = await findInFlightRun(admin, drawing_id);
      if (alreadyRunning) {
        return jsonResponse({
          run_id: alreadyRunning.id, revision_number: alreadyRunning.revision_number,
          background: true, status: "processing", reused_existing_run: true, pages_processed: requestedPages,
        });
      }

      const { data: priorRuns } = await admin.from("analysis_runs").select("revision_number").eq("drawing_id", drawing_id).order("revision_number", { ascending: false }).limit(1);
      const nextRevision = (priorRuns && priorRuns[0]?.revision_number ? priorRuns[0].revision_number : 0) + 1;

      const { data: run, error: runErr } = await admin.from("analysis_runs").insert({
        project_id: project.id, drawing_id, revision_number: nextRevision, status: "processing", triggered_by: userId,
        is_admin_assisted: isAdminOverride, prompt_version: PROMPT_VERSION, run_kind: "tiled",
      }).select().single();
      if (runErr) throw runErr;

      const pageNo = Math.max(1, Number(page_number) || 1);

      runInBackground(async () => {
        const startTime = Date.now();
        const totalUsage = { input_tokens: 0, output_tokens: 0 };
        const addUsage = (u: any) => {
          totalUsage.input_tokens += u?.input_tokens ?? 0;
          totalUsage.output_tokens += u?.output_tokens ?? 0;
        };

        // ---- fetch every tile image once ---------------------------------
        let tileBlocks: { tile: TileSpec; block: any; bytes: number }[];
        try {
          tileBlocks = await mapWithConcurrency(tiles, 6, async (t) => {
            const { data: blob, error } = await admin.storage.from("drawings").download(t.path);
            if (error || !blob) throw new Error(`Could not read tile ${t.row},${t.col} from storage: ${error?.message ?? "missing"}`);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return {
              tile: t,
              bytes: bytes.length,
              block: { type: "image", source: { type: "base64", media_type: "image/png", data: bytesToBase64(bytes) } },
            };
          });
        } catch (fetchErr) {
          await admin.from("analysis_runs").update({ status: "failed", error_message: describeError(fetchErr) }).eq("id", run.id);
          return;
        }

        const systemPrompt = `You are an expert AI Quantity Surveyor and MEP/ELV design engineer analyzing construction drawings to produce accurate Bills of Quantities. ${projectContext}${QUANTITY_RECONCILIATION_RULES}${MASTER_BOQ_ENGINE_RULES}`;

        // ---- pass 1: read the symbol legend at full resolution ------------
        // The legend is usually in the title block on the right or along the
        // bottom, so tiles are offered to this call in that order and cut off
        // at a byte budget. Sending all of them would routinely exceed
        // Anthropic's request-size ceiling on a 12-tile A0 sheet.
        const LEGEND_BUDGET_BYTES = 12 * 1024 * 1024;
        const legendOrder = [...tileBlocks].sort((a, b) => {
          const score = (t: TileSpec) => t.x0 * 2 + t.y0;   // right-most first, then lowest
          return score(b.tile) - score(a.tile);
        });
        const legendPicked: typeof tileBlocks = [];
        let legendBytes = 0;
        for (const tb of legendOrder) {
          if (legendBytes + tb.bytes > LEGEND_BUDGET_BYTES && legendPicked.length > 0) break;
          legendPicked.push(tb); legendBytes += tb.bytes;
        }

        let legend: any = null;
        try {
          const legendContent = [
            ...legendPicked.map((tb) => tb.block),
            {
              type: "text",
              text: `These are high-resolution tiles of a single ${drawing.discipline ?? "construction"} drawing sheet${drawing.floor_label ? ` (${drawing.floor_label})` : ""}, in the order they were cut from the sheet. ` +
                `Find the symbol legend / key / schedule of symbols and read it. Record every legend row you can genuinely read via record_drawing_legend. ` +
                `Set legend_legible to false if the legend is absent, cropped or still unreadable -- an invented legend is far worse than none, because everything counted afterwards would be mislabelled. ` +
                `Do NOT count devices in this step.`,
            },
          ];
          const legendCall = await callClaude(anthropicKey, systemPrompt, legendContent, TILE_LEGEND_TOOL, 3000);
          addUsage(legendCall.usage);
          legend = legendCall.result;
        } catch (legendErr) {
          // A legend is an accelerator, not a prerequisite. Counting still works
          // from symbol shape and adjacent text, so this degrades rather than fails.
          console.error("tiled legend pass failed, continuing without a legend:", legendErr);
        }
        const legendText = legendToPromptText(legend);

        // ---- pass 2: count devices, one call per tile ---------------------
        const tileResults = await mapWithConcurrency(tileBlocks, TILE_CONCURRENCY, async (tb) => {
          const t = tb.tile;
          const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
          const prompt =
            `This image is ONE TILE of a larger ${drawing.discipline ?? "construction"} drawing sheet${drawing.floor_label ? ` for ${drawing.floor_label}` : ""}, ` +
            `rendered at high resolution so that individual device symbols are legible. ` +
            `It is tile row ${t.row + 1}, column ${t.col + 1} of a ${grid?.rows ?? "?"} x ${grid?.cols ?? "?"} grid, ` +
            `covering the region from ${pct(t.x0)}-${pct(t.x1)} across and ${pct(t.y0)}-${pct(t.y1)} down the full sheet.\n\n` +
            `${legendText}\n\n` +
            `COUNTING RULE -- read this twice. Tiles deliberately overlap their neighbours. You must count ONLY items whose ` +
            `symbol CENTRE falls inside this tile's core region, which is x from ${pct(t.core_x0)} to ${pct(t.core_x1)} and ` +
            `y from ${pct(t.core_y0)} to ${pct(t.core_y1)} OF THIS IMAGE. Symbols outside that core belong to the neighbouring ` +
            `tile and will be counted there. Counting them here would double them in the final BOQ.\n\n` +
            `COORDINATES: give every position as a fraction of THIS TILE image (0.0-1.0), not of the whole sheet. ` +
            `Put one position in coordinates.x/y and every further occurrence of the same item in coordinates.instances[]. ` +
            `An item with quantity 12 must carry 12 positions. Keep boxes tight around the symbol.\n\n` +
            `REFERENCE PANELS -- this matters as much as the count. Construction sheets carry a legend/symbol key, a title ` +
            `block, schedules and note blocks, and those panels contain DRAWN SYMBOLS that are references, not installed ` +
            `devices. If any part of such a panel is visible in this image, report its bounding box in reference_panels. ` +
            `Never record a symbol inside one of those panels as an installed device with a position on the plan: a camera ` +
            `drawn in the legend key is not a camera in the building.\n\n` +
            `Record what you can actually see in this tile via record_boq_items: devices, fixtures, equipment, and any cable/ ` +
            `containment run whose route is visible here. If this tile contains a schedule or legend table rather than plan ` +
            `content, record its rows with quantity_source_type "schedule_quantity" and no coordinates. ` +
            `If this tile contains no countable items at all, return an empty items list -- that is a valid and useful answer, ` +
            `do not invent content to fill it.`;

          const content = [tb.block, { type: "text", text: prompt }];
          let out;
          try {
            out = await callClaude(anthropicKey, systemPrompt, content, BOQ_ITEM_TOOL, TILE_MAX_OUTPUT_TOKENS);
          } catch (firstErr) {
            // One retry. Tile calls run four-wide, so a transient 429 or 529 is
            // the single most likely way an otherwise good run dies.
            console.warn(`tile ${t.row},${t.col} failed once, retrying:`, describeError(firstErr));
            await new Promise((r) => setTimeout(r, 4000 + Math.floor(Math.random() * 3000)));
            out = await callClaude(anthropicKey, systemPrompt, content, BOQ_ITEM_TOOL, TILE_MAX_OUTPUT_TOKENS);
          }
          addUsage(out.usage);
          return { tile: t, result: out.result };
        }).catch((tileErr) => {
          return { __failed: describeError(tileErr) } as any;
        });

        if ((tileResults as any).__failed) {
          // Deliberately fatal. A BOQ silently missing one quadrant of a sheet
          // is more dangerous than no BOQ, because nothing on screen shows the
          // gap. Same reasoning as the truncation guard in callClaude.
          await admin.from("analysis_runs").update({
            status: "failed",
            error_message: `One or more tiles of this sheet could not be analysed, so the take-off was rejected rather than saved with part of the sheet missing. ${(tileResults as any).__failed}`,
          }).eq("id", run.id);
          return;
        }

        // ---- merge ---------------------------------------------------------
        const merged: any[] = [];
        const notesParts: string[] = [];
        const panels: { x0: number; y0: number; x1: number; y1: number }[] = [];
        let emptyTiles = 0;
        for (const tr of tileResults as { tile: TileSpec; result: any }[]) {
          for (const p of (Array.isArray(tr.result?.reference_panels) ? tr.result.reference_panels : [])) {
            const rect = panelToPageRect(p, tr.tile);
            if (rect) panels.push(rect);
          }
          const items = Array.isArray(tr.result?.items) ? tr.result.items : [];
          if (!items.length) emptyTiles++;
          for (const it of items) {
            merged.push({
              ...it,
              coordinates: tileToPageCoords(it.coordinates, tr.tile, pageNo),
              __tile: `${tr.tile.row + 1},${tr.tile.col + 1}`,
            });
          }
          if (tr.result?.analysis_notes) notesParts.push(`[tile ${tr.tile.row + 1},${tr.tile.col + 1}] ${tr.result.analysis_notes}`);
        }

        // Before de-duplicating: a phantom position inside the legend could
        // otherwise merge with a real one and drag its quantity along.
        const panelDropped = stripPositionsInPanels(merged, panels);
        if (panelDropped) {
          console.log(`tiled run ${run.id}: discarded ${panelDropped} position(s) falling inside ${panels.length} legend/title-block panel(s).`);
        }

        const typicalFixedTiled = reclassifyTypicalDetailRows(merged);
        if (typicalFixedTiled) console.warn(`reclassifyTypicalDetailRows (tiled): ${typicalFixedTiled} row(s) moved to typical_detail_reference.`);

        const { items: deduped, removed } = mergeTileRows(merged);
        const legendFlagged = crossCheckAgainstLegend(deduped, legend);
        if (legendFlagged) {
          console.log(`tiled run ${run.id}: ${legendFlagged} line(s) disagree with the sheet legend's stated quantity.`);
        }

        const rows = deduped.map((it: any) => ({
          project_id: project.id, drawing_id, analysis_run_id: run.id, revision_number: nextRevision,
          system_category: it.system_category ?? "other", floor_label: it.floor_label ?? drawing.floor_label,
          zone: it.zone, room: it.room, area_label: it.area_label, item_no: it.item_no,
          description: it.description, technical_specification: it.technical_specification,
          manufacturer: it.manufacturer ?? null, model_number: it.model_number ?? null,
          subsystem: it.subsystem ?? null, building: it.building ?? null,
          from_location: it.from_location ?? null, to_location: it.to_location ?? null,
          optimization_status: it.optimization_status ?? defaultOptimizationStatus(it), optimization_note: it.optimization_note ?? null,
          quantity: it.quantity ?? 0, unit: it.unit ?? "nos", length_value: it.length_value, area_value: it.area_value,
          location: it.location, installation_accessories: it.installation_accessories, consumables: it.consumables,
          testing_requirements: it.testing_requirements, commissioning_requirements: it.commissioning_requirements,
          confidence_score: it.confidence_score ?? 70, source: "ai_drawing_analysis",
          coordinates: it.coordinates ?? null,
          quantity_source_type: it.quantity_source_type ?? "physical_count",
          schedule_quantity_crosscheck: it.schedule_quantity_crosscheck ?? null,
          quantity_basis_notes: it.quantity_basis_notes ?? null,
        }));

        const { rows: promotedRows } = promoteSoleSourceScheduleRows(rows);
        const safeRows = promotedRows.map(sanitizeBoqRow);
        const synthetic = {
          items: deduped,
          analysis_notes: notesParts.join("\n"),
          cost_optimizations: [], assumptions: [], review_items: [],
        };
        const inserted = await insertBoqRowsWithSupportingData(admin, safeRows, synthetic, project.id);
        const derived = await deriveEngineeringItems(admin, inserted);

        const legendLine = legend?.legend_legible
          ? `Symbol legend read at full resolution: ${(legend.legend_entries ?? []).length} symbols decoded.`
          : `No readable symbol legend was found on this sheet; devices were identified from symbol shape and adjacent labels.`;

        await admin.from("analysis_runs").update({
          status: "completed", completed_at: new Date().toISOString(),
          summary: {
            item_count: safeRows.length,
            derived_item_count: derived.length,
            tiled: true,
            tile_count: tiles.length,
            empty_tiles: emptyTiles,
            duplicates_merged: removed,
            legend_mismatches: legendFlagged,
            typical_detail_rows: typicalFixedTiled,
            found_nothing: safeRows.length === 0,
            reference_panels: panels.length,
            positions_discarded_in_panels: panelDropped,
            notes: (safeRows.length === 0
              ? `No BOQ items were produced from this sheet. Every tile was read and nothing countable for the systems Quantora reads (MEP and ELV) was found. If this is a civil, structural or architectural drawing, set its type to Civil, Structural or Architectural so it is measured as civil works — and if it is a specification or schedule rather than a drawing, upload it on the Specification page instead. Per-tile detail follows.\n\n`
              : ``) + `High-resolution tiled take-off: the sheet was rendered at full scale and read as ${tiles.length} overlapping tiles, so device symbols too small to resolve on a whole-sheet pass are legible. ${legendLine} ${removed} per-tile row(s) were merged into one line per device, so a device counted on several tiles is one BOQ line and not several. ${legendFlagged} line(s) disagree with the quantity printed in the sheet's own legend and are flagged for review rather than silently adjusted. ${panelDropped} marker position(s) landing inside a legend, schedule or title block were discarded, because a symbol drawn in a key is a reference and not a device in the building. ${emptyTiles} tile(s) contained no countable items.\n\n${notesParts.join("\n")}`,
          },
        }).eq("id", run.id);

        await recordUsageAndBill(
          admin,
          { companyId, billing: pageCheck.billing === "wallet" ? "wallet" : legacyUsage.billing },
          userId, project.id, "analyze_drawing_tiled", totalUsage, requestedPages, Date.now() - startTime, isAdminOverride
        );
        await admin.from("drawings").update({ pages_ai_processed: (drawing.pages_ai_processed ?? 0) + requestedPages }).eq("id", drawing_id);

        // The results are saved, so the tile images have done their job. Left
        // behind they would accumulate in the customer's own storage folder
        // with every re-run. Only reached on success: after a failure they are
        // the only record of what the AI was shown, and deleting them would
        // make the next identical failure undiagnosable.
        try {
          await admin.storage.from("drawings").remove(tiles.map((t) => t.path));
        } catch (cleanupErr) {
          // Never fail a completed analysis over housekeeping.
          console.warn(`tiled run ${run.id}: tile cleanup failed, leaving ${tiles.length} tile(s) in storage:`, cleanupErr);
        }
      }, async (err) => {
        await admin.from("analysis_runs").update({
          status: "failed",
          error_message: `Unexpected error while finishing this tiled analysis: ${describeError(err)}`,
        }).eq("id", run.id).eq("status", "processing");
      });

      return jsonResponse({
        run_id: run.id, revision_number: nextRevision, background: true, status: "processing",
        pages_processed: requestedPages, tiles: tiles.length,
      });
    }

    if (action === "design_system") {
      // The structured brief. Written by the frontend from the question bank,
      // already rendered to human-readable lines so this function does not have
      // to carry a second copy of the bank and drift from it.
      const briefId = body.system_brief_id ?? null;
      let brief: any = null;
      if (briefId) {
        const { data: b } = await admin.from("system_briefs")
          .select("id, project_id, system_category, answers, bank_version")
          .eq("id", briefId).eq("project_id", project.id).maybeSingle();
        brief = b || null;
      }

      const legacyUsage = isAdminOverride ? { ok: true as const, billing: "admin_comp" as const } : await checkUsageLimit(admin, companyId, plan, "analysis");
      if (!legacyUsage.ok) {
        return jsonResponse({ error: planLimitMessage(legacyUsage, "analysis") }, 429);
      }
      const concurrencyCheck = await checkConcurrencyGate(admin, companyId);
      if (!concurrencyCheck.ok) {
        return jsonResponse({ error: concurrencyCheck.error }, 429);
      }
      const { system_category, requirements_text } = body;

      // Requirement 1: never start a design that has nothing to size against.
      // This is the check whose absence produced the 2026-08-22 failure --
      // a project with no floors and no area gave the model an unbounded
      // building and it generated until the response ceiling stopped it.
      const floors = project.number_of_floors;
      const area   = project.area_size;
      if (floors == null || area == null) {
        return jsonResponse({
          error: "This project does not say how many floors it has or how big it is, so there is nothing to size a design against. Open the project, fill in the floor count and gross floor area, and run the design again.",
        }, 400);
      }

      const { data: run, error: runErr } = await admin.from("analysis_runs").insert({
        project_id: project.id, drawing_id: null, revision_number: 1, status: "processing", triggered_by: userId,
        is_admin_assisted: isAdminOverride, run_kind: "design_system", prompt_version: PROMPT_VERSION,
        system_brief_id: brief ? brief.id : null,
      }).select().single();
      if (runErr) throw runErr;
      await supersedePriorNoDrawingRuns(admin, project.id, "design_system", run.id);

      runInBackground(async () => {
        const a = (brief && brief.answers) || {};
        const answered: any[] = Array.isArray(a.answered) ? a.answered : [];
        const aiCalc:   any[] = Array.isArray(a.ai_calc)  ? a.ai_calc  : [];
        const sections: any[] = Array.isArray(a.boq_sections) ? a.boq_sections : [];
        const expected: number = Number(a.expected_lines) || 0;

        // The building, stated once and plainly. Everything the design is sized
        // from lives in this block.
        const buildingBlock = [
          `Floors above ground: ${floors}`,
          project.basement_levels != null ? `Basement / parking levels: ${project.basement_levels}` : null,
          `Gross floor area: ${area} ${project.area_unit || "sqm"}`,
          `Building type: ${project.building_type}`,
          project.project_type ? `Project type: ${project.project_type}` : null,
          `Location: ${[project.city, project.country].filter(Boolean).join(", ")}`,
          project.scope_of_works ? `Scope of works: ${project.scope_of_works}` : null,
          project.spec_grade ? `Specification grade: ${project.spec_grade}` : null,
        ].filter(Boolean).join("\n");

        const answeredBlock = answered.length
          ? answered.map((x: any) => `- ${x.q}: ${x.a}`).join("\n")
          : "(the customer answered none of the system questions)";
        const calcBlock = aiCalc.length
          ? aiCalc.map((x: any) => `- ${x.q} — you must calculate this. Basis: ${x.basis}`).join("\n")
          : "(nothing left for you to calculate)";
        const shapeBlock = sections.length
          ? sections.map((s: any) => `- ${s[0]}: about ${s[1]} line item(s)`).join("\n")
          : "";

        // Requirement 2: a hard output budget derived from the brief. The
        // expected line count is what makes an overrun impossible rather than
        // merely unlikely -- roughly 380 output tokens per fully-specified BOQ
        // row, plus headroom, floored and capped so a strange brief cannot
        // produce a useless budget or an unbounded one.
        const designBudget = expected > 0
          ? Math.min(MAX_OUTPUT_TOKENS, Math.max(4000, Math.round(expected * 380 * 1.6)))
          : MAX_OUTPUT_TOKENS;

        const systemPrompt = brief
          ? `You are an expert AI Design Engineer and MEP/ELV consultant. You design building systems from a written brief (there are no drawings) and produce a full Bill of Quantities. ${projectContext}

THE BUILDING
${buildingBlock}

Since there are no source drawings, set quantity_source_type="calculated_quantity" on every item (these are engineering-calculated quantities, not physical counts or schedule references) and state the calculation basis in quantity_basis_notes.

STAY INSIDE THE BRIEF. The customer has told you what is in scope. Do not add systems, areas or equipment they did not ask for, and do not design anything the brief excludes. A complete answer to the brief is worth far more than an exhaustive one that runs out of room and gets rejected.${MASTER_BOQ_ENGINE_RULES}`
          : `You are an expert AI Design Engineer and MEP/ELV consultant who designs building systems from requirements alone (no drawings available) and produces a full Bill of Quantities. ${projectContext}

THE BUILDING
${buildingBlock}

Since there are no source drawings, set quantity_source_type="calculated_quantity" on every item (these are engineering-calculated quantities, not physical counts or schedule references) and briefly note the calculation basis in quantity_basis_notes.${MASTER_BOQ_ENGINE_RULES}`;

        const userContent = [{
          type: "text",
          text: brief
            ? `Design the "${a.system_label || system_category}" system for this building and produce a complete BOQ via the record_boq_items tool.

WHAT THE CUSTOMER TOLD YOU
${answeredBlock}

WHAT YOU MUST WORK OUT YOURSELF
${calcBlock}
${body.brief_notes ? `\nADDITIONAL NOTES FROM THE CUSTOMER\n${body.brief_notes}\n` : ""}
EXPECTED SHAPE OF THE ANSWER
${shapeBlock}
Aim for approximately ${expected || 25} line items in total. If you cannot fit the whole scope, cover the main equipment and cabling first and say so in analysis_notes — a complete short BOQ is useful, a truncated long one is worthless.

Perform the engineering calculations the brief leaves to you (coverage, capacity, sizing, cable lengths, storage) and distribute items across the ${floors} floor(s)${project.basement_levels ? ` and ${project.basement_levels} basement level(s)` : ""} sensibly. Include installation accessories, consumables, testing and commissioning. Set confidence_score high (85-98) for items that follow directly from the brief, and lower it where you had to assume.`
            : `Design the "${system_category}" system for this project from these requirements: "${requirements_text}". Perform the necessary engineering calculations (coverage, quantities, storage/network sizing, cable lengths, capacity, etc. as applicable to this system type) and produce a complete BOQ via the record_boq_items tool. Distribute items across floors/zones reasonably given the project's floor count and area. Include installation accessories, consumables, testing and commissioning requirements. Set confidence_score high (85-98) since this is an AI-native design rather than a drawing extraction, unless an assumption is particularly uncertain.`,
        }];

        const startTime = Date.now();
        let parsed;
        try {
          parsed = await callClaude(anthropicKey, systemPrompt, userContent, BOQ_ITEM_TOOL, designBudget, "design");
        } catch (aiErr) {
          // Requirement 3: a failed run still costs money. Recording it here is
          // the difference between knowing the real AI spend and not — nine
          // failed runs before this change recorded nothing at all.
          const spent = (aiErr as any)?.usage;
          if (spent && (spent.input_tokens || spent.output_tokens)) {
            try {
              await recordUsageAndBill(admin, { companyId, billing: legacyUsage.billing }, userId, project.id,
                "design_system", spent, null, Date.now() - startTime, isAdminOverride);
            } catch (billErr) {
              console.error("failed-run usage not recorded:", billErr);
            }
          }
          await admin.from("analysis_runs").update({ status: "failed", error_message: describeError(aiErr) }).eq("id", run.id);
          return;
        }
        const elapsedMs = Date.now() - startTime;
        const result = parsed.result as { items: any[]; analysis_notes: string; document_kind?: string; cost_optimizations?: any[]; assumptions?: any[]; review_items?: any[] };

        // Right reasoning, wrong field: the model describes a typical detail in its
        // own basis note and then files the row as a physical count.
        const typicalFixed = reclassifyTypicalDetailRows(result.items || []);
        if (typicalFixed) console.warn(`reclassifyTypicalDetailRows: ${typicalFixed} row(s) moved to typical_detail_reference.`);

        const rows = result.items.map((it: any) => ({
          project_id: project.id, drawing_id: null, analysis_run_id: run.id, revision_number: 1,
          system_category: it.system_category ?? system_category, floor_label: it.floor_label, zone: it.zone, room: it.room,
          area_label: it.area_label, item_no: it.item_no, description: it.description, technical_specification: it.technical_specification,
          manufacturer: it.manufacturer ?? null, model_number: it.model_number ?? null,
          subsystem: it.subsystem ?? null, building: it.building ?? null,
          from_location: it.from_location ?? null, to_location: it.to_location ?? null,
          optimization_status: it.optimization_status ?? defaultOptimizationStatus(it), optimization_note: it.optimization_note ?? null,
          quantity: it.quantity ?? 0, unit: it.unit ?? "nos", length_value: it.length_value, area_value: it.area_value,
          location: it.location, installation_accessories: it.installation_accessories, consumables: it.consumables,
          testing_requirements: it.testing_requirements, commissioning_requirements: it.commissioning_requirements,
          confidence_score: it.confidence_score ?? 90, source: "ai_system_design",
          quantity_source_type: it.quantity_source_type ?? "calculated_quantity",
          schedule_quantity_crosscheck: null,
          quantity_basis_notes: it.quantity_basis_notes ?? null,
        }));
        const { rows: promotedRows, promoted: promotedScheduleRows } = promoteSoleSourceScheduleRows(rows);
        if (promotedScheduleRows > 0) {
          console.warn(`promoteSoleSourceScheduleRows: reclassified ${promotedScheduleRows} schedule-only row(s) to physical_count so they count toward the BOQ.`);
        }
        const safeRows = promotedRows.map(sanitizeBoqRow);
        const inserted = await insertBoqRowsWithSupportingData(admin, safeRows, result, project.id);
        const derived = await deriveEngineeringItems(admin, inserted);

        await admin.from("analysis_runs").update({
          status: "completed", completed_at: new Date().toISOString(),
          summary: {
            item_count: safeRows.length, derived_item_count: derived.length,
            typical_detail_rows: typicalFixed,
            found_nothing: safeRows.length === 0,
            notes: safeRows.length === 0
              ? `No BOQ items were produced. Nothing countable for the systems Quantora reads (MEP and ELV — cameras, readers, detectors, luminaires, panels, cable, containment, ducting, pipework) was found in this file. If it is a civil, structural or architectural drawing, set its type to Civil, Structural or Architectural so it is measured as civil works. If it is a specification or a schedule rather than a drawing, upload it on the Specification page instead. What the AI saw: ${result.analysis_notes ?? "(no notes)"}`
              : (typicalFixed
                  ? `${result.analysis_notes ?? ""} ${typicalFixed} row(s) were recorded as typical-detail references rather than counted quantities: a typical detail shows how an item is built once, not how many the project contains.`.trim()
                  : result.analysis_notes),
          },
        }).eq("id", run.id);
        await recordUsageAndBill(admin, { companyId, billing: legacyUsage.billing }, userId, project.id, "design_system", parsed.usage, null, elapsedMs, isAdminOverride);
      }, async (err) => {
        await admin.from("analysis_runs").update({
          status: "failed",
          error_message: `Unexpected error while finishing this design (Claude responded, but saving the results failed): ${describeError(err)}`,
        }).eq("id", run.id).eq("status", "processing");
      });

      return jsonResponse({ run_id: run.id, background: true, status: "processing" });
    }

    if (action === "rework") {
      const legacyUsage = isAdminOverride ? { ok: true as const, billing: "admin_comp" as const } : await checkUsageLimit(admin, companyId, plan, "analysis");
      if (!legacyUsage.ok) {
        return jsonResponse({ error: planLimitMessage(legacyUsage, "analysis") }, 429);
      }
      const concurrencyCheck = await checkConcurrencyGate(admin, companyId);
      if (!concurrencyCheck.ok) {
        return jsonResponse({ error: concurrencyCheck.error }, 429);
      }
      const reworkCheck = isAdminOverride ? { ok: true, current: 0, limit: null } : await checkPlanLimit(admin, companyId, plan, company, "rework", 1, project.id);
      if (!reworkCheck.ok) {
        return jsonResponse({ error: reworkLimitMessage(reworkCheck) }, 429);
      }

      const { drawing_id, comments, page_selection, confirm_retry_after_failures, confirm_rerun } = body as { drawing_id: string; comments: string[]; page_selection?: number[]; confirm_retry_after_failures?: boolean; confirm_rerun?: boolean };
      const { data: drawing, error: dErr } = await admin.from("drawings").select("*").eq("id", drawing_id).eq("project_id", project.id).maybeSingle();
      if (dErr || !drawing) throw new Error("Drawing not found.");

      const failureHistoryCheck = isAdminOverride ? { ok: true as const } : await checkRecentFailureHistory(admin, drawing_id, !!confirm_retry_after_failures);
      if (!failureHistoryCheck.ok) {
        return jsonResponse({ error: failureHistoryCheck.error, requires_confirmation: true, recent_failures: failureHistoryCheck.recentFailures }, 429);
      }

      const { data: existingItems } = await admin.from("boq_items").select("*").eq("drawing_id", drawing_id).order("revision_number", { ascending: false });
      const latestRevision = existingItems && existingItems.length ? Math.max(...existingItems.map((i: any) => i.revision_number)) : 0;
      const currentItems = (existingItems ?? []).filter((i: any) => i.revision_number === latestRevision);
      const nextRevision = latestRevision + 1;

      const { data: fileBlob, error: dlErr } = await admin.storage.from("drawings").download(drawing.storage_path);
      if (dlErr || !fileBlob) throw new Error("Could not read drawing file from storage.");
      const arrayBuf = await fileBlob.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuf);
      if (fileBytes.length > MAX_FILE_BYTES) {
        throw new Error(`This file is ${(fileBytes.length / 1024 / 1024).toFixed(1)}MB, which is over the ${MAX_FILE_BYTES / 1024 / 1024}MB per-file limit for AI processing. Please split it into smaller files before uploading.`);
      }
      const isPdf = drawing.file_name.toLowerCase().endsWith(".pdf");

      const hasSelection = isPdf && Array.isArray(page_selection) && page_selection.length > 0;
      const requestedPages = hasSelection ? page_selection!.length : estimatePageCount(fileBytes, isPdf);

      const pageCheck = isAdminOverride ? { ok: true, current: 0, limit: null, remaining: Infinity } : await checkPlanLimit(admin, companyId, plan, company, "drawing_page", requestedPages);
      if (!pageCheck.ok) {
        return jsonResponse({ error: pageLimitMessage(pageCheck, requestedPages, plan) }, 429);
      }

      const reworkInFlight = await findInFlightRun(admin, drawing_id);
      if (reworkInFlight) {
        return jsonResponse({
          error: "An analysis is already running for this drawing. Wait for it to finish before requesting a rework -- your comments have not been submitted and you have not been charged.",
        }, 429);
      }

      const { data: run, error: runErr } = await admin.from("analysis_runs").insert({
        project_id: project.id, drawing_id, revision_number: nextRevision, status: "processing", triggered_by: userId,
        change_reason: comments.join("; ").slice(0, 2000),
        is_admin_assisted: isAdminOverride, prompt_version: PROMPT_VERSION,
      }).select().single();
      if (runErr) throw runErr;

      runInBackground(async () => {
        let processingBytes = fileBytes;
        let usingSelection = false;
        if (hasSelection) {
          try {
            processingBytes = await extractSelectedPages(fileBytes, page_selection!);
            usingSelection = true;
          } catch (splitErr) {
            console.error("pdf-lib page split failed, falling back to full document:", splitErr);
          }
        }
        const fileContent = buildFileContentBlock(drawing.file_name, processingBytes);
        const coordsInstruction = (fileContent.kind === "dxf" || fileContent.kind === "ifc")
          ? `This is raw ${fileContent.kind.toUpperCase()} exchange-format text, not a rendered drawing image, so omit "coordinates" for every item.`
          : (isCivilDrawing(drawing) ? CIVIL_COORDS_INSTRUCTION : MARKUP_COORDS_INSTRUCTION);
        const civil = isCivilDrawing(drawing);
        const takeoffTool = civil ? CIVIL_BOQ_TOOL : BOQ_ITEM_TOOL;
        const systemPrompt = civil
          ? `You are revising a previous civil, structural and architectural Bill of Quantities take-off based on user feedback. Do NOT discard correct prior items — reproduce the FULL corrected item list (including unchanged items) so this becomes the new authoritative revision. ${projectContext}${CIVIL_TAKEOFF_RULES}`
          : `You are revising a previous Bill of Quantities extraction based on user feedback. Do NOT discard correct prior items — reproduce the FULL corrected item list (including unchanged items) so this becomes the new authoritative revision. ${projectContext}${QUANTITY_RECONCILIATION_RULES}${MASTER_BOQ_ENGINE_RULES}`;
        const userContent = [
          fileContent.block,
          {
            type: "text",
            text: `Previous revision ${latestRevision} extracted these items:\n${JSON.stringify(currentItems.map((i: any) => civil
              ? ({ system_category: i.system_category, description: i.description, quantity: i.quantity, unit: i.unit, room: i.room, location: i.location, working: i.quantity_basis_notes })
              : ({ system_category: i.system_category, description: i.description, quantity: i.quantity, unit: i.unit, location: i.location })), null, 2)}\n\nUser correction comments to address:\n${comments.map((c, idx) => `${idx + 1}. ${c}`).join("\n")}\n\nRe-examine the source, apply these corrections, and output the COMPLETE corrected item list via record_boq_items (previous correct items plus fixes for what was flagged). ${coordsInstruction}`,
          },
        ];

        const startTime = Date.now();
        let parsed;
        try {
          parsed = await callClaude(anthropicKey, systemPrompt, userContent, takeoffTool);
        } catch (aiErr) {
          await admin.from("analysis_runs").update({ status: "failed", error_message: describeError(aiErr) }).eq("id", run.id);
          return;
        }
        const elapsedMs = Date.now() - startTime;
        const result = parsed.result as { items: any[]; analysis_notes: string; document_kind?: string; cost_optimizations?: any[]; assumptions?: any[]; review_items?: any[] };
        const civilNote = civil ? applyCivilFinalize(result) : "";
        if (civilNote) result.analysis_notes = `${result.analysis_notes ?? ""}${civilNote}`;

        // Right reasoning, wrong field: the model describes a typical detail in its
        // own basis note and then files the row as a physical count.
        // The wrong kind of file entirely. Stop here rather than reporting a
        // successful run that counted nothing out of prose.
        const wrongKind = wrongFileKindMessage(String(result.document_kind ?? "drawing"), result.analysis_notes);
        if (wrongKind && !(result.items || []).length) {
          await admin.from("analysis_runs").update({ status: "failed", error_message: wrongKind }).eq("id", run.id);
          return;
        }

        const typicalFixed = reclassifyTypicalDetailRows(result.items || []);
        if (typicalFixed) console.warn(`reclassifyTypicalDetailRows: ${typicalFixed} row(s) moved to typical_detail_reference.`);

        const rows = result.items.map((it: any) => ({
          project_id: project.id, drawing_id, analysis_run_id: run.id, revision_number: nextRevision,
          system_category: it.system_category ?? "other", floor_label: it.floor_label ?? drawing.floor_label,
          zone: it.zone, room: it.room, area_label: it.area_label, item_no: it.item_no,
          description: it.description, technical_specification: it.technical_specification,
          manufacturer: it.manufacturer ?? null, model_number: it.model_number ?? null,
          subsystem: it.subsystem ?? null, building: it.building ?? null,
          from_location: it.from_location ?? null, to_location: it.to_location ?? null,
          optimization_status: it.optimization_status ?? defaultOptimizationStatus(it), optimization_note: it.optimization_note ?? null,
          quantity: it.quantity ?? 0, unit: it.unit ?? "nos", length_value: it.length_value, area_value: it.area_value,
          location: it.location, installation_accessories: it.installation_accessories, consumables: it.consumables,
          testing_requirements: it.testing_requirements, commissioning_requirements: it.commissioning_requirements,
          confidence_score: it.confidence_score ?? 70, source: "ai_drawing_analysis",
          coordinates: it.coordinates ?? null,
          quantity_source_type: it.quantity_source_type ?? "physical_count",
          schedule_quantity_crosscheck: it.schedule_quantity_crosscheck ?? null,
          quantity_basis_notes: it.quantity_basis_notes ?? null,
        }));
        const { rows: promotedRows, promoted: promotedScheduleRows } = promoteSoleSourceScheduleRows(rows);
        if (promotedScheduleRows > 0) {
          console.warn(`promoteSoleSourceScheduleRows: reclassified ${promotedScheduleRows} schedule-only row(s) to physical_count so they count toward the BOQ.`);
        }
        const safeRows = promotedRows.map(sanitizeBoqRow);
        const inserted = await insertBoqRowsWithSupportingData(admin, safeRows, result, project.id);
        const derived = await deriveEngineeringItems(admin, inserted);

        await admin.from("analysis_runs").update({
          status: "completed", completed_at: new Date().toISOString(),
          summary: {
            item_count: safeRows.length, derived_item_count: derived.length,
            found_nothing: safeRows.length === 0,
            notes: (safeRows.length === 0 ? emptyResultExplanation("rework") + "\n\n" : "") + (result.analysis_notes ?? ""),
            revised_from: latestRevision,
          },
        }).eq("id", run.id);
        await recordUsageAndBill(admin, { companyId, billing: pageCheck.billing === "wallet" ? "wallet" : legacyUsage.billing }, userId, project.id, "rework", parsed.usage, requestedPages, elapsedMs, isAdminOverride);
        await admin.from("drawings").update({ pages_ai_processed: (drawing.pages_ai_processed ?? 0) + requestedPages }).eq("id", drawing_id);
        if (usingSelection) {
          await admin.from("drawing_pages").update({ selected: true, ai_processed: true }).eq("drawing_id", drawing_id).in("page_number", page_selection!);
        }
      }, async (err) => {
        await admin.from("analysis_runs").update({
          status: "failed",
          error_message: `Unexpected error while finishing this rework (Claude responded, but saving the results failed): ${describeError(err)}`,
        }).eq("id", run.id).eq("status", "processing");
      });

      return jsonResponse({ run_id: run.id, revision_number: nextRevision, background: true, status: "processing", pages_processed: requestedPages });
    }

    if (action === "analyze_drawings_combined") {
      const legacyUsage = isAdminOverride ? { ok: true as const, billing: "admin_comp" as const } : await checkUsageLimit(admin, companyId, plan, "analysis");
      if (!legacyUsage.ok) {
        return jsonResponse({ error: planLimitMessage(legacyUsage, "analysis") }, 429);
      }
      const concurrencyCheck = await checkConcurrencyGate(admin, companyId);
      if (!concurrencyCheck.ok) {
        return jsonResponse({ error: concurrencyCheck.error }, 429);
      }
      const { drawing_ids } = body as { drawing_ids: string[] };
      if (!Array.isArray(drawing_ids) || drawing_ids.length < 2) {
        return jsonResponse({ error: "Select at least 2 drawings for combined analysis." }, 400);
      }
      const MAX_COMBINE = 10;
      if (drawing_ids.length > MAX_COMBINE) {
        return jsonResponse({ error: `Combined analysis supports up to ${MAX_COMBINE} drawings at a time. Please select fewer, or run them as separate analyses.` }, 400);
      }

      const { data: candidateDrawings } = await admin.from("drawings").select("*").eq("project_id", project.id).in("id", drawing_ids);
      const NEEDS_EXPORT_TYPES = ["dwg", "revit"];
      const skipped: { file_name: string; reason: string }[] = [];
      const included: any[] = [];
      for (const id of drawing_ids) {
        const d = (candidateDrawings ?? []).find((x: any) => x.id === id);
        if (!d) { skipped.push({ file_name: id, reason: "Drawing not found in this project." }); continue; }
        if (d.discipline === "specification") { skipped.push({ file_name: d.file_name, reason: "Specification documents aren't AI-analyzed." }); continue; }
        const directlyAnalyzable = ["pdf", "image", "scan", "dxf", "ifc"].includes(d.file_type);
        const hasExport = NEEDS_EXPORT_TYPES.includes(d.file_type) && d.analysis_source_path;
        if (!directlyAnalyzable && !hasExport) { skipped.push({ file_name: d.file_name, reason: "No PDF/image export attached for this DWG/Revit file." }); continue; }
        included.push(d);
      }
      if (included.length < 2) {
        return jsonResponse({ error: "Fewer than 2 of the selected drawings are eligible for AI analysis. " + (skipped.length ? "Skipped: " + skipped.map(s => `${s.file_name} (${s.reason})`).join("; ") : "") }, 400);
      }

      const fetched: { drawing: any; bytes: Uint8Array; content: { block: any; kind: string }; pages: number }[] = [];
      for (const d of included) {
        const useExport = NEEDS_EXPORT_TYPES.includes(d.file_type) && d.analysis_source_path;
        const path = useExport ? d.analysis_source_path : d.storage_path;
        const { data: fileBlob, error: dlErr } = await admin.storage.from("drawings").download(path);
        if (dlErr || !fileBlob) { skipped.push({ file_name: d.file_name, reason: "Could not read file from storage." }); continue; }
        const bytes = new Uint8Array(await fileBlob.arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES) { skipped.push({ file_name: d.file_name, reason: `File is over the ${MAX_FILE_BYTES / 1024 / 1024}MB per-file limit for AI processing.` }); continue; }
        const nameForContent = useExport ? (d.analysis_source_type === "pdf" ? `${d.file_name}.pdf` : `${d.file_name}.jpg`) : d.file_name;
        const content = buildFileContentBlock(nameForContent, bytes);
        fetched.push({ drawing: d, bytes, content, pages: estimatePageCount(bytes, content.kind === "pdf") });
      }
      if (fetched.length < 2) {
        return jsonResponse({ error: "Fewer than 2 of the selected drawings could be read for combined analysis.", skipped }, 400);
      }

      const totalPages = fetched.reduce((s, f) => s + f.pages, 0);
      const pageCheck = isAdminOverride ? { ok: true, current: 0, limit: null, remaining: Infinity } : await checkPlanLimit(admin, companyId, plan, company, "drawing_page", totalPages);
      if (!pageCheck.ok) {
        return jsonResponse({ error: pageLimitMessage(pageCheck, totalPages, plan) }, 429);
      }

      const estimatedRequestBytes = fetched.reduce((sum, f) => {
        if (f.content.kind === "pdf" || f.content.kind === "image") {
          return sum + Math.ceil(f.bytes.length / 3) * 4;
        }
        return sum + f.bytes.length;
      }, 0);
      if (estimatedRequestBytes + REQUEST_SIZE_SAFETY_MARGIN_BYTES > ANTHROPIC_MAX_REQUEST_BYTES) {
        const approxMb = (estimatedRequestBytes / 1024 / 1024).toFixed(1);
        return jsonResponse({
          error: `Combining these ${fetched.length} drawings would send roughly ${approxMb}MB to the AI, which is over Anthropic's 32MB hard limit per request. Please combine fewer drawings at a time (try 3-4 floors per batch instead of all at once), or use "Analyze" individually per drawing -- a single drawing is always well under this limit.`,
        }, 413);
      }

      const { data: run, error: runErr } = await admin.from("analysis_runs").insert({
        project_id: project.id, drawing_id: null, revision_number: 1, status: "processing", triggered_by: userId,
        is_admin_assisted: isAdminOverride, run_kind: "combined_analysis", prompt_version: PROMPT_VERSION,
      }).select().single();
      if (runErr) throw runErr;
      await supersedePriorNoDrawingRuns(admin, project.id, "combined_analysis", run.id);

      runInBackground(async () => {
        const anyVisual = fetched.some(f => f.content.kind === "pdf" || f.content.kind === "image");
        const userContent: any[] = [];
        fetched.forEach((f, idx) => {
          userContent.push({ type: "text", text: `Drawing ${idx + 1} of ${fetched.length}: "${f.drawing.file_name}" (${f.drawing.discipline ?? "unspecified discipline"}${f.drawing.floor_label ? `, ${f.drawing.floor_label}` : ""}).` });
          userContent.push(f.content.block);
        });
        userContent.push({
          type: "text",
          text: `Analyze all ${fetched.length} drawings above TOGETHER as one connected drawing set for this project. Identify every relevant system item across all of them. Critically: if the SAME physical item (e.g. the same camera, device, fixture, or run) appears on more than one drawing (e.g. an architectural plan and a matching MEP/ELV layout for the same floor/zone), count it ONCE, not once per drawing. Produce a single deduplicated Bill of Quantities via the record_boq_items tool, following standard BOQ conventions (item description, technical spec, qty, unit, length/area where relevant, location, accessories, consumables, testing & commissioning requirements). Assign an honest confidence_score per item.${anyVisual ? ` ${MARKUP_COORDS_INSTRUCTION} Coordinates are relative to the specific page/drawing the item was found on (1-indexed page number within that document). Items sourced from a raw DXF/IFC text drawing have no page image, so omit coordinates for those.` : ` None of these files are rendered drawing images (they are raw DXF/IFC text), so omit "coordinates" for every item.`}`,
        });
        const systemPrompt = `You are an expert AI Quantity Surveyor and MEP/ELV design engineer analyzing a combined, multi-drawing construction set to produce one accurate, deduplicated Bill of Quantities. ${projectContext}${QUANTITY_RECONCILIATION_RULES}\n\nThis is a MULTI-drawing combined analysis -- the same equipment is especially likely to appear across several of the drawings you were given (e.g. an ELV plan, a schedule sheet, and a key plan for the same floor). Apply the quantity_source_type classification per item and use duplicate_reference for any occurrence you recognize as the same physical item already counted from another of the supplied drawings.${MASTER_BOQ_ENGINE_RULES}`;

        const startTime = Date.now();
        let parsed;
        try {
          parsed = await callClaude(anthropicKey, systemPrompt, userContent);
        } catch (aiErr) {
          await admin.from("analysis_runs").update({ status: "failed", error_message: describeError(aiErr) }).eq("id", run.id);
          return;
        }
        const elapsedMs = Date.now() - startTime;
        const result = parsed.result as { items: any[]; analysis_notes: string; document_kind?: string; cost_optimizations?: any[]; assumptions?: any[]; review_items?: any[] };

        // Right reasoning, wrong field: the model describes a typical detail in its
        // own basis note and then files the row as a physical count.
        const typicalFixed = reclassifyTypicalDetailRows(result.items || []);
        if (typicalFixed) console.warn(`reclassifyTypicalDetailRows: ${typicalFixed} row(s) moved to typical_detail_reference.`);

        const rows = result.items.map((it: any) => ({
          project_id: project.id, drawing_id: null, analysis_run_id: run.id, revision_number: 1,
          system_category: it.system_category ?? "other", floor_label: it.floor_label,
          zone: it.zone, room: it.room, area_label: it.area_label, item_no: it.item_no,
          description: it.description, technical_specification: it.technical_specification,
          manufacturer: it.manufacturer ?? null, model_number: it.model_number ?? null,
          subsystem: it.subsystem ?? null, building: it.building ?? null,
          from_location: it.from_location ?? null, to_location: it.to_location ?? null,
          optimization_status: it.optimization_status ?? defaultOptimizationStatus(it), optimization_note: it.optimization_note ?? null,
          quantity: it.quantity ?? 0, unit: it.unit ?? "nos", length_value: it.length_value, area_value: it.area_value,
          location: it.location, installation_accessories: it.installation_accessories, consumables: it.consumables,
          testing_requirements: it.testing_requirements, commissioning_requirements: it.commissioning_requirements,
          confidence_score: it.confidence_score ?? 70, source: "ai_combined_drawing_analysis",
          coordinates: it.coordinates ?? null,
          quantity_source_type: it.quantity_source_type ?? "physical_count",
          schedule_quantity_crosscheck: it.schedule_quantity_crosscheck ?? null,
          quantity_basis_notes: it.quantity_basis_notes ?? null,
        }));
        const { rows: promotedRows, promoted: promotedScheduleRows } = promoteSoleSourceScheduleRows(rows);
        if (promotedScheduleRows > 0) {
          console.warn(`promoteSoleSourceScheduleRows: reclassified ${promotedScheduleRows} schedule-only row(s) to physical_count so they count toward the BOQ.`);
        }
        const safeRows = promotedRows.map(sanitizeBoqRow);
        const inserted = await insertBoqRowsWithSupportingData(admin, safeRows, result, project.id);
        const derived = await deriveEngineeringItems(admin, inserted);

        await admin.from("analysis_runs").update({
          status: "completed", completed_at: new Date().toISOString(),
          summary: {
            item_count: safeRows.length, derived_item_count: derived.length,
            found_nothing: safeRows.length === 0,
            notes: (safeRows.length === 0 ? emptyResultExplanation("combined analysis") + "\n\n" : "") + (result.analysis_notes ?? ""),
            combined_drawing_ids: fetched.map(f => f.drawing.id),
            combined_file_names: fetched.map(f => f.drawing.file_name),
          },
        }).eq("id", run.id);
        await recordUsageAndBill(admin, { companyId, billing: pageCheck.billing === "wallet" ? "wallet" : legacyUsage.billing }, userId, project.id, "analyze_drawings_combined", parsed.usage, totalPages, elapsedMs, isAdminOverride);
        for (const f of fetched) {
          await admin.from("drawings").update({ pages_ai_processed: (f.drawing.pages_ai_processed ?? 0) + f.pages }).eq("id", f.drawing.id);
        }
      }, async (err) => {
        await admin.from("analysis_runs").update({
          status: "failed",
          error_message: `Unexpected error while finishing this combined analysis (Claude responded, but saving the results failed): ${describeError(err)}`,
        }).eq("id", run.id).eq("status", "processing");
      });

      return jsonResponse({ run_id: run.id, background: true, status: "processing", drawings_included: fetched.length, skipped });
    }

    if (action === "chat") {
      const legacyUsage = isAdminOverride ? { ok: true as const, billing: "admin_comp" as const } : await checkUsageLimit(admin, companyId, plan, "request");
      if (!legacyUsage.ok) {
        return jsonResponse({ error: planLimitMessage(legacyUsage, "request") }, 429);
      }
      const chatCheck = isAdminOverride ? { ok: true, current: 0, limit: null } : await checkPlanLimit(admin, companyId, plan, company, "chat", 1);
      if (!chatCheck.ok) {
        return jsonResponse({ error: chatLimitMessage(chatCheck, plan) }, 429);
      }

      const { message } = body as { message: string };

      const { data: items } = await admin.from("boq_items").select("system_category, quantity, unit, review_status, confidence_score").eq("project_id", project.id);
      const bySystem: Record<string, { qty: number; count: number }> = {};
      for (const it of items ?? []) {
        bySystem[it.system_category] = bySystem[it.system_category] ?? { qty: 0, count: 0 };
        bySystem[it.system_category].qty += Number(it.quantity ?? 0);
        bySystem[it.system_category].count += 1;
      }
      const avgConfidence = items && items.length ? (items.reduce((s: number, i: any) => s + Number(i.confidence_score ?? 0), 0) / items.length).toFixed(1) : "n/a";
      const pendingCount = (items ?? []).filter((i: any) => i.review_status === "pending").length;

      const { data: complianceRows } = await admin.from("compliance_rules").select("*").eq("country", project.country).ilike("city", project.city);

      const dataSnapshot = `BOQ summary by system (quantity, line-item count): ${JSON.stringify(bySystem)}\nTotal line items: ${items?.length ?? 0}. Pending review: ${pendingCount}. Average AI confidence: ${avgConfidence}%.\nApplicable compliance rules for ${project.city}, ${project.country}: ${JSON.stringify(complianceRows ?? [])}`;

      const systemPrompt = `You are the AI Construction Assistant for this specific project. Answer ONLY using the data snapshot and project context provided — never invent quantities or facts not derivable from it. Be concise and precise, like a senior estimator/QS would be. If asked to "reduce cost", suggest concrete, generic levers (value-engineered alternates, quantity optimization, spec tiering) without claiming specific priced savings you cannot compute. ${projectContext}\n\n${dataSnapshot}`;

      const startTime = Date.now();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL, max_tokens: 1024, system: systemPrompt,
          messages: [{ role: "user", content: message }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      const elapsedMs = Date.now() - startTime;
      const text = data.content?.find((c: any) => c.type === "text")?.text ?? "(no response)";
      await recordUsageAndBill(admin, { companyId, billing: chatCheck.billing === "wallet" ? "wallet" : legacyUsage.billing }, userId, project.id, "chat", {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      }, null, elapsedMs, isAdminOverride);
      return jsonResponse({ reply: text });
    }


    // -----------------------------------------------------------------
    // price_boq — indicative market unit rates, with the source shown.
    //
    // Uses Anthropic's web_search server tool, so the rates come from pages
    // that exist and can be opened, not from the model's memory of what a
    // camera used to cost. Anthropic requires citations to be shown to the
    // end user; an estimator requires the same thing for a different reason,
    // which is that a rate with no source cannot be checked.
    //
    // Written to be honest about what it is. It returns a REFERENCE price and
    // writes it to boq_price_lookups, never to boq_items.unit_cost_cents --
    // the rate someone actually bids at stays a decision a person makes. A
    // list price found online is not a project rate: it usually excludes
    // duty, freight, VAT, waste, and the trade discount a contractor would
    // actually get, and it may be for a different specification entirely.
    // Saying so in the UI is part of the feature, not a disclaimer bolted on.
    // -----------------------------------------------------------------
    if (action === "price_boq") {
      // NO plan-quota check here, deliberately. Market lookups are a separate
      // paid product: the customer buys searches, and those searches are the
      // only thing that funds this action. Charging it against the plan's AI
      // allowance as well would be billing twice for one request -- once in
      // money and once in quota -- and would let a subscription run out because
      // of searches the customer had already paid for separately.
      const lines = Array.isArray((body as any).lines) ? (body as any).lines : [];
      if (!lines.length) {
        return jsonResponse({ error: "No BOQ lines were sent to price." }, 400);
      }

      // Pay as you go. The market lookup calls a metered third-party search, so
      // it does not run on a plan quota -- it runs on searches the customer has
      // actually paid for. Read from the database, never from the request: the
      // browser has no say in whether this is switched on.
      const { data: creditRow } = await admin.from("companies")
        .select("search_credits_remaining, pricing_search_enabled").eq("id", companyId).maybeSingle();
      const creditsLeft = Number(creditRow?.search_credits_remaining ?? 0);
      const searchEnabled = !!creditRow?.pricing_search_enabled;
      if (!isAdminOverride && (!searchEnabled || creditsLeft <= 0)) {
        return jsonResponse({
          error: creditsLeft <= 0
            ? "Your market search balance is empty, so Pricing BOQ lookups are switched off. Top up in Settings to switch it back on."
            : "Market search lookups are switched off for this account. Enable them in Settings and add a search top-up.",
          code: "search_credits_exhausted",
          search_credits_remaining: creditsLeft,
        }, 402);
      }
      // Never start a run that could spend more than has been paid for.
      const searchBudget = isAdminOverride ? 12 : Math.max(1, Math.min(12, creditsLeft));
      // Bounded on purpose. Each search costs money and each line adds tokens;
      // an unbounded BOQ would turn one click into an unpredictable bill.
      const MAX_LINES = 40;
      const priced = lines.slice(0, MAX_LINES);
      const currency = String((body as any).currency ?? "USD").toUpperCase().slice(0, 3);

      const lineList = priced.map((l: any, i: number) =>
        `${i + 1}. [${l.line_key}] ${l.description}` +
        (l.specification ? ` | spec: ${String(l.specification).slice(0, 300)}` : "") +
        ` | unit: ${l.unit ?? "No."} | qty: ${l.quantity ?? ""}` +
        (l.system_category ? ` | system: ${l.system_category}` : "")
      ).join("\n");

      const region = [project.city, project.country].filter(Boolean).join(", ") || "the project location";

      const systemPrompt =
        `You are a procurement researcher for a construction estimating team. For each BOQ line you are given, ` +
        `search the web for a currently advertised supply price for a product that genuinely matches the ` +
        `specification, and report the LOWEST credible price you can actually find on a real page.\n\n` +
        `Market: ${region}. Report every rate in ${currency}.\n\n` +
        `Rules you must follow:\n` +
        `- Only report a price you actually saw on a page you searched. Never estimate, never infer from memory, ` +
        `never average. If you cannot find a real advertised price for a line, return it with unit_rate null and ` +
        `say why in basis_note. A missing price is a correct answer; an invented one is not.\n` +
        `- source_url must be the page the price was on, and matched_product must name the actual product you ` +
        `priced, so a quantity surveyor can open it and check whether it really matches the specification.\n` +
        `- Say in basis_note whether the price excludes VAT, duty, freight or installation where the page says so, ` +
        `and flag it when the product you found is a close substitute rather than an exact match.\n` +
        `- Set confidence to "low" when the match is loose, the source is a marketplace listing rather than a ` +
        `supplier, or the price looks like a consumer-grade product being compared against a specified commercial one.\n` +
        `- Prefer suppliers and distributors serving ${region}. A price from another market is still useful, but say ` +
        `so in basis_note.\n` +
        `- Group your searches sensibly. You do not need one search per line if several lines are the same family ` +
        `of product.\n\n` +
        `When you have finished searching, call record_boq_prices exactly once with a row for every line you were ` +
        `given, using the same line_key you were given.`;

      const startTime = Date.now();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 8000,
          system: systemPrompt,
          tools: [WEB_SEARCH_TOOL(project, searchBudget), BOQ_PRICE_TOOL],
          // Not forced to one tool: the model has to be free to search first
          // and only then report. Forcing tool_choice to record_boq_prices --
          // which every other call in this file does -- would make it answer
          // without ever searching, which is exactly the failure this feature
          // exists to avoid.
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content: `Price these BOQ lines:\n\n${lineList}` }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      const elapsedMs = Date.now() - startTime;

      const blocks = Array.isArray(data.content) ? data.content : [];
      const searchesUsed = blocks.filter((c: any) => c.type === "server_tool_use" && c.name === "web_search").length;
      const toolBlock = blocks.find((c: any) => c.type === "tool_use" && c.name === "record_boq_prices");
      const rows = toolBlock?.input?.prices ?? [];

      if (!Array.isArray(rows) || rows.length === 0) {
        const said = blocks.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ").slice(0, 400);
        return jsonResponse({
          error: "The search ran but came back without any usable prices"
            + (said ? `: ${said}` : ". Try a smaller selection of lines, or lines with a clearer specification."),
          searches_used: searchesUsed,
        }, 502);
      }

      const byKey = new Map(priced.map((l: any) => [String(l.line_key), l]));
      const toStore: any[] = [];
      for (const r of rows) {
        const src = byKey.get(String(r.line_key));
        if (!src) continue;                       // never store a line we did not ask about
        const rate = Number(r.unit_rate);
        const cents = Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) : null;
        toStore.push({
          project_id: project.id,
          line_key: String(r.line_key),
          system_category: src.system_category ?? null,
          description: src.description ?? String(r.line_key),
          unit: src.unit ?? null,
          quantity: src.quantity ?? null,
          unit_rate_cents: cents,
          currency,
          // A price with no page behind it is not a sourced price, so the URL
          // is dropped rather than stored half-true.
          source_url: cents != null ? (r.source_url ?? null) : null,
          source_title: cents != null ? (r.source_title ?? null) : null,
          matched_product: r.matched_product ?? null,
          search_query: r.search_query ?? null,
          basis_note: r.basis_note ?? null,
          confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
          region,
          fetched_at: new Date().toISOString(),
        });
      }

      if (toStore.length) {
        const { error: upErr } = await admin.from("boq_price_lookups")
          .upsert(toStore, { onConflict: "project_id,line_key" });
        if (upErr) throw upErr;
      }
      const found = toStore.filter((r) => r.unit_rate_cents != null).length;
      await admin.from("boq_price_runs").insert({
        project_id: project.id,
        lines_requested: priced.length,
        lines_priced: found,
        searches_used: searchesUsed,
        region,
        currency,
        note: lines.length > MAX_LINES
          ? `Only the first ${MAX_LINES} of ${lines.length} lines were priced in this run.`
          : null,
      });

      // Charged on searches actually performed, not on searches budgeted. A run
      // that answered from two searches costs the customer two. consume_search_
      // credits also flips the switch off when this empties the balance, so the
      // off state is decided in one place rather than in every caller.
      let creditsAfter = creditsLeft;
      if (!isAdminOverride && searchesUsed > 0) {
        const { data: took } = await admin.rpc("consume_search_credits", {
          p_company_id: companyId,
          p_searches: searchesUsed,
          p_project_id: project.id,
          p_description: `Pricing BOQ — ${priced.length} lines`,
        });
        creditsAfter = Math.max(0, creditsLeft - Number(took ?? searchesUsed));
      }

      // Recorded so the real cost per search stays measurable, but billed_from
      // is left null: no wallet debit, no plan consumption. The searches the
      // customer bought have already been decremented above, and that is the
      // whole and only charge for this action.
      await recordUsageAndBill(admin, { companyId }, userId, project.id, "price_boq", {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      }, null, elapsedMs, isAdminOverride);

      return jsonResponse({
        lines_requested: priced.length,
        lines_priced: found,
        searches_used: searchesUsed,
        truncated: lines.length > MAX_LINES ? lines.length - MAX_LINES : 0,
        currency,
        region,
        search_credits_remaining: creditsAfter,
        search_credits_enabled: creditsAfter > 0,
      });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResponse({ error: describeError(err) }, 500);
  }
});