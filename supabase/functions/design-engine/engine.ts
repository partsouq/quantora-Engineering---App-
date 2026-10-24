// ===========================================================================
// The engine: runs the selected systems over the building, adds containment,
// and renders the riser drawing.
// ===========================================================================
import type { BuildingSpec, FloorSpec, Line } from "./rules.ts";
import { AUTHORITIES, authorityFor, ceil, localiseLine } from "./rules.ts";
import type { SystemDef } from "./systems.ts";
import { ALL_SYSTEMS } from "./systems.ts";

export interface DesignResult {
  building: BuildingSpec;
  authorityKey: string;
  authority: any;
  families: Record<string, { def: SystemDef; lines: Line[]; total: number }>;
  lines: Line[];
  totals: { devices: number; lines: number; clientDirected: number };
}

/** Containment and cable, estimated from the envelope. Stated as an estimate. */
function containment(b: BuildingSpec, key: string, lines: Line[]): Line[] {
  // How a system is wired decides its cable length, and getting this wrong is
  // the fastest way to lose an engineer's trust:
  //
  //   homerun — every device has its own cable back to the floor IDF. True for
  //             CCTV and access control, where each camera and each door is an
  //             individual run.
  //   loop    — devices sit on a shared loop that leaves the panel and returns
  //             to it. True for an addressable fire alarm; home-running 380
  //             detectors would have claimed 15 km of FP200 for a building that
  //             needs about 7.
  //   circuit — points are looped in and out along a final circuit of about ten
  //             devices. True for lighting and small power; home-running 2,994
  //             luminaires claimed 120 km of cable, which is roughly eight times
  //             the real figure and would have been visible in the first BOQ.
  const spec: Record<string, { cable: string; conduit: string; conduitPerDevice: number;
                               model: "homerun" | "loop" | "circuit"; perPoint?: number }> = {
    cctv:           { cable: "CAT6A U/FTP LSZH data cable", conduit: "25 mm GI conduit, final drop",
                      conduitPerDevice: 6, model: "homerun" },
    access_control: { cable: "Composite access control cable, LSZH", conduit: "25 mm GI conduit, door loop",
                      conduitPerDevice: 8, model: "homerun" },
    fire_alarm:     { cable: "Fire-resistant cable, 2 core 1.5 mm², FP200 equivalent", conduit: "20 mm GI conduit, device drop",
                      conduitPerDevice: 4, model: "loop", perPoint: 18 },
    lighting:       { cable: "LSZH lighting circuit cable, 3 core 1.5 mm²", conduit: "20 mm PVC conduit, concealed",
                      conduitPerDevice: 7, model: "circuit", perPoint: 14 },
    power_distribution: { cable: "LSZH power circuit cable, 3 core 2.5 mm²", conduit: "25 mm PVC conduit, concealed",
                      conduitPerDevice: 7, model: "circuit", perPoint: 16 },
    structured_cabling: { cable: "CAT6A U/FTP LSZH horizontal cable", conduit: "25 mm PVC conduit, outlet drop",
                      conduitPerDevice: 6, model: "homerun" },
    wifi:           { cable: "CAT6A U/FTP LSZH data cable, access point", conduit: "25 mm GI conduit, ceiling drop",
                      conduitPerDevice: 5, model: "homerun" },
    intercom:       { cable: "Intercom cable, CAT6 / composite, LSZH", conduit: "20 mm PVC conduit, station drop",
                      conduitPerDevice: 5, model: "homerun" },
    iptv:           { cable: "Coaxial RG6 / CAT6A distribution cable, LSZH", conduit: "20 mm PVC conduit, outlet drop",
                      conduitPerDevice: 5, model: "homerun" },
    audio_visual:   { cable: "AV cable set — HDMI over CAT6A, USB and control", conduit: "32 mm PVC conduit, table route",
                      conduitPerDevice: 8, model: "homerun" },
    grms:           { cable: "Guest room bus cable, 2 pair shielded, LSZH", conduit: "20 mm PVC conduit, concealed",
                      conduitPerDevice: 6, model: "homerun" },
    public_address: { cable: "100 V line speaker cable, 2 core 1.5 mm², fire rated", conduit: "20 mm GI conduit, speaker drop",
                      conduitPerDevice: 4, model: "loop", perPoint: 20 },
    bms:            { cable: "BMS field bus cable, 2 core shielded, LSZH", conduit: "20 mm PVC conduit, device drop",
                      conduitPerDevice: 5, model: "loop", perPoint: 22 },
    parking_management: { cable: "Parking sensor bus cable, 4 core shielded", conduit: "25 mm GI conduit, surface, car park",
                      conduitPerDevice: 4, model: "loop", perPoint: 12 },
    pabx:           { cable: "Voice cable, CAT6 U/UTP LSZH", conduit: "20 mm PVC conduit, outlet drop",
                      conduitPerDevice: 5, model: "homerun" },
    nurse_call:     { cable: "Nurse call bus cable, 4 core shielded, LSZH", conduit: "20 mm PVC conduit, device drop",
                      conduitPerDevice: 5, model: "loop", perPoint: 16 },
    gas_suppression: { cable: "Fire-resistant cable, 2 core 1.5 mm², FP200 equivalent", conduit: "20 mm GI conduit, device drop",
                      conduitPerDevice: 5, model: "homerun" },
    smoke_management: { cable: "Fire-resistant control cable, 4 core 1.5 mm², damper and fan", conduit: "25 mm GI conduit, damper drop",
                      conduitPerDevice: 6, model: "homerun" },
    ups:            { cable: "LSZH power circuit cable, 3 core 2.5 mm², UPS final circuit", conduit: "25 mm PVC conduit, concealed",
                      conduitPerDevice: 7, model: "circuit", perPoint: 16 },
    gate_barrier:   { cable: "Barrier control and power cable, multicore, armoured", conduit: "32 mm GI conduit, buried, external",
                      conduitPerDevice: 10, model: "homerun" },
  };
  const s = spec[key];
  if (!s) return [];
  const devices = lines.filter(l => l.unit === "no" && !/^(head end|Head end)/.test(l.floor))
                       .reduce((t, l) => t + l.qty, 0);
  if (!devices) return [];

  const f2f = (b.floorToFloorMm ?? 3600) / 1000;
  let cableM = 0;
  let basisText = "";

  if (s.model === "homerun") {
    for (const f of b.floors) {
      const n = lines.filter(l => l.floor === f.name).reduce((t, l) => t + (l.unit === "no" ? l.qty : 0), 0);
      if (!n) continue;
      const a = Object.values(f.spaces).reduce((t, v) => t + v, 0);
      const diag = Math.sqrt(Math.max(a, 1)) * 1.414;
      cableM += n * (diag / 3 + Math.abs(f.level) * f2f + 5);
    }
    basisText = "Each device has its own cable back to its floor IDF. The average horizontal run is taken as a third of the floor-plate diagonal, plus the riser drop and 5 m for slack and terminations.";
  } else {
    // Loop and circuit both run between devices rather than back to the panel.
    const per = s.perPoint ?? 15;
    cableM = devices * per;
    // plus the loop return / circuit home run from each floor to its board
    for (const f of b.floors) {
      const n = lines.filter(l => l.floor === f.name).reduce((t, l) => t + (l.unit === "no" ? l.qty : 0), 0);
      if (!n) continue;
      const a = Object.values(f.spaces).reduce((t, v) => t + v, 0);
      const circuits = Math.max(1, ceil(n / 10));
      cableM += circuits * (Math.sqrt(Math.max(a, 1)) * 0.8 + Math.abs(f.level) * f2f);
    }
    basisText = s.model === "loop"
      ? `Addressable loop: ${per} m of cable between consecutive devices, not a separate run per device, plus the loop return from each floor to the panel. Home-running every device would overstate this several times over.`
      : `Final circuits looped in and out at about ten points per circuit, ${per} m between points, plus the circuit home run from each floor to its distribution board.`;
  }
  cableM *= 1.10;

  const f0: FloorSpec = { name: "All floors", level: 0, spaces: {} };
  const out: Line[] = [{
    floor: f0.name, level: 0, system: "cable_sizing", device: "cable", label: s.cable,
    qty: Math.round(cableM), unit: "m", mountingMm: null, source: "code",
    basis: `ESTIMATE, not a measured run. ${basisText} Plus 10% wastage. Supply an IFC model and this line becomes a measured length.`,
  }, {
    floor: f0.name, level: 0, system: "containment", device: "conduit", label: s.conduit,
    qty: Math.round(devices * s.conduitPerDevice), unit: "m", mountingMm: null, source: "code",
    basis: `${devices} devices at ${s.conduitPerDevice} m of conduit each, from the device to the nearest trunking, loop or circuit.`,
  }, {
    floor: f0.name, level: 0, system: "containment", device: "trunking",
    label: "50x50 mm GI trunking, with covers and supports",
    qty: Math.round(b.floors.reduce((t, f) =>
      t + Math.sqrt(Math.max(Object.values(f.spaces).reduce((x, v) => x + v, 0), 1)) * 1.2, 0)), unit: "m",
    mountingMm: null, source: "code",
    basis: "Corridor and riser spine taken as 1.2 x the square root of each floor plate, summed over every floor.",
  }];
  return out;
}

export function runDesign(b: BuildingSpec, selected: string[]): DesignResult {
  const key = authorityFor(b.country, b.city);
  const families: DesignResult["families"] = {};
  const all: Line[] = [];

  for (const def of ALL_SYSTEMS) {
    if (!selected.includes(def.key)) continue;
    let lines: Line[] = [];
    for (const f of b.floors) lines = lines.concat(def.build(b, f));
    if (def.buildingWide) lines = lines.concat(def.buildingWide(b, lines));
    lines = lines.concat(containment(b, def.key, lines));
    families[def.key] = { def, lines, total: lines.filter(l => l.unit === "no").reduce((t, l) => t + l.qty, 0) };
    all.push(...lines);
  }

  for (const l of all) {
    l.label = localiseLine(l.label, key);
    l.basis = localiseLine(l.basis, key);
  }

  return {
    building: b, authorityKey: key, authority: AUTHORITIES[key], families, lines: all,
    totals: {
      devices: all.filter(l => l.unit === "no").reduce((t, l) => t + l.qty, 0),
      lines: all.length,
      clientDirected: all.filter(l => l.source === "client").length,
    },
  };
}

// ===========================================================================
// Riser drawing. SVG, so it renders in the browser and prints to PDF.
// ===========================================================================
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderRiserSvg(res: DesignResult): string {
  const b = res.building;
  const fams = Object.values(res.families);
  const floors = [...b.floors].sort((x, y) => y.level - x.level);
  const W = 240 + fams.length * 250;
  const LEFT = 60, SPINE = 230, ROW = 86, GAP = 10, TOP = 162;
  const H = TOP + floors.length * (ROW + GAP) + 300;
  const colW = (W - LEFT - SPINE - 70) / Math.max(1, fams.length);
  const p: string[] = [];
  const T = (x: number, y: number, s: string, size = 12, fill = "#1b2430", weight = "normal", anchor = "start") =>
    p.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="DejaVu Sans, Arial, sans-serif">${esc(s)}</text>`);
  const R = (x: number, y: number, w: number, h: number, fill: string, extra = "") =>
    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`);

  p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  R(0, 0, W, H, "#ffffff");

  // title block
  R(LEFT, 28, W - 2 * LEFT, 92, "#0d1119", 'rx="6"');
  T(LEFT + 22, 60, b.name, 21, "#ffffff", "bold");
  T(LEFT + 22, 83, `${b.city}, ${b.country}  ·  ${b.floors.length} levels  ·  ${Math.round(b.floors.reduce((s, f) => s + Object.values(f.spaces).reduce((a, v) => a + v, 0), 0)).toLocaleString()} m² gross`, 12.5, "#93a0b4");
  T(LEFT + 22, 103, `Authority: ${res.authority.name}`, 12.5, "#63a4e8");
  T(W - LEFT - 22, 60, "SYSTEM RISER DIAGRAM", 13, "#ffffff", "bold", "end");
  T(W - LEFT - 22, 83, "Schematic — not to scale", 11.5, "#93a0b4", "normal", "end");
  T(W - LEFT - 22, 103, `${res.totals.devices.toLocaleString()} devices · ${res.totals.lines} BOQ lines`, 11.5, "#93a0b4", "normal", "end");

  // spine
  const y0 = TOP - 16, y1 = TOP + floors.length * (ROW + GAP) + 6;
  R(SPINE - 16, y0, 32, y1 - y0, "#eef1f6", 'stroke="#c3ccda" rx="4"');
  T(SPINE, y0 - 8, "RISER", 10.5, "#5c6676", "bold", "middle");

  fams.forEach((fam, i) => {
    const cx = SPINE + 46 + i * colW;
    R(cx, TOP - 46, colW - 14, 28, fam.def.colour, 'rx="4"');
    T(cx + (colW - 14) / 2, TOP - 27, fam.def.label.toUpperCase(), 11, "#ffffff", "bold", "middle");
  });

  floors.forEach((f, fi) => {
    const y = TOP + fi * (ROW + GAP);
    R(LEFT, y, W - 2 * LEFT, ROW, fi % 2 === 0 ? "#f6f7f9" : "#ffffff", 'stroke="#dde2ea"');
    const fa = Object.values(f.spaces).reduce((a, v) => a + v, 0);
    T(LEFT + 14, y + 26, f.name, 13.5, "#131820", "bold");
    T(LEFT + 14, y + 45, `${Math.round(fa).toLocaleString()} m²`, 11, "#5c6676");
    if (f.doors) T(LEFT + 14, y + 61, `${f.doors} controlled doors`, 10, "#8892a2");

    R(SPINE - 26, y + 20, 52, 34, "#131820", 'rx="4"');
    T(SPINE, y + 41, "IDF", 11, "#ffffff", "bold", "middle");
    p.push(`<line x1="${SPINE}" y1="${y + 54}" x2="${SPINE}" y2="${y + ROW + GAP + 20}" stroke="#131820" stroke-width="2.5"/>`);

    const act = fams.map((fam, i) => ({ i, fam })).filter(({ fam }) => fam.lines.some(l => l.floor === f.name));
    if (act.length) {
      const endX = SPINE + 46 + Math.max(...act.map(a => a.i)) * colW + 20;
      p.push(`<line x1="${SPINE + 10}" y1="${y + ROW - 6}" x2="${endX}" y2="${y + ROW - 6}" stroke="#8892a2" stroke-width="1.4"/>`);
    }

    fams.forEach((fam, i) => {
      const cx = SPINE + 46 + i * colW;
      const rows = fam.lines.filter(l => l.floor === f.name);
      if (!rows.length) { T(cx + 8, y + 42, "—", 12, "#c3ccda"); return; }
      const total = rows.filter(l => l.unit === "no").reduce((t, l) => t + l.qty, 0);
      R(cx, y + 12, colW - 14, ROW - 26, "#ffffff", `stroke="${fam.def.colour}" stroke-width="1.4" rx="5"`);
      R(cx, y + 12, 4, ROW - 26, fam.def.colour, 'rx="2"');
      T(cx + 12, y + 31, String(total), 16, fam.def.colour, "bold");
      T(cx + 12 + 11 * String(total).length, y + 31, "devices", 10, "#5c6676");

      const budget = Math.floor((colW - 38) / 5.1);
      const parts: string[] = []; let used = 0;
      for (const r of rows) {
        if (r.unit !== "no") continue;
        const piece = `${r.qty}×${r.device.replace(/_/g, " ")}`;
        if (used + piece.length + 2 > budget - 6) break;
        parts.push(piece); used += piece.length + 2;
      }
      const shown = rows.filter(r => r.unit === "no").length;
      T(cx + 12, y + 47, parts.join(", ") + (parts.length < shown ? ` +${shown - parts.length}` : ""), 9.5, "#5c6676");
      const m = rows.filter(r => r.unit === "m" || r.unit === "m²");
      if (m.length) T(cx + 12, y + 62, m.slice(0, 2).map(r => `${r.qty.toLocaleString()} ${r.unit}`).join(" · "), 9, "#8892a2");
      if (rows.some(r => r.source === "client")) {
        R(cx + colW - 72, y + 16, 54, 15, "#fde8e8", 'rx="3"');
        T(cx + colW - 45, y + 27, "CLIENT", 8.5, "#b23c39", "bold", "middle");
      }
      p.push(`<line x1="${cx + 20}" y1="${y + ROW - 6}" x2="${cx + 20}" y2="${y + ROW - 14}" stroke="${fam.def.colour}" stroke-width="1.8"/>`);
      p.push(`<circle cx="${cx + 20}" cy="${y + ROW - 14}" r="2.8" fill="${fam.def.colour}"/>`);
    });
  });

  // head end
  const hy = TOP + floors.length * (ROW + GAP) + 16;
  R(LEFT, hy, W - 2 * LEFT, 96, "#0d1119", 'rx="6"');
  T(LEFT + 20, hy + 25, "HEAD END / PLANT", 12.5, "#ffffff", "bold");
  let hx = LEFT + 20;
  const withHead = fams.filter(f => f.lines.some(l => /head end/i.test(l.floor)));
  withHead.forEach(fam => {
    const items = fam.lines.filter(l => /head end/i.test(l.floor));
    R(hx, hy + 38, 6, 42, fam.def.colour, 'rx="2"');
    T(hx + 14, hy + 51, fam.def.label, 10.5, "#ffffff", "bold");
    items.slice(0, 3).forEach((it, j) =>
      T(hx + 14, hy + 65 + j * 11, `${it.qty}× ${it.label.split(",")[0]}`.slice(0, 40), 8.8, "#93a0b4"));
    hx += (W - 2 * LEFT - 40) / Math.max(1, withHead.length);
  });

  // legend
  const ly = hy + 116;
  T(LEFT, ly, "LEGEND — MOUNTING HEIGHTS", 11, "#5c6676", "bold");
  let lx = LEFT;
  fams.forEach(fam => {
    R(lx, ly + 12, 12, 12, fam.def.colour, 'rx="2"');
    T(lx + 20, ly + 22, fam.def.label, 10.5, "#131820", "bold");
    const seen = new Set<string>(); let j = 0;
    for (const l of fam.lines) {
      if (!l.mountingMm || seen.has(l.device) || j >= 4) continue;
      seen.add(l.device);
      T(lx + 20, ly + 38 + j * 12, `${l.device.replace(/_/g, " ")} — ${l.mountingMm} mm AFF`, 8.8, "#5c6676");
      j++;
    }
    lx += (W - 2 * LEFT) / fams.length;
  });
  T(LEFT, ly + 104, "Quantities marked CLIENT follow a stated client requirement; everything else is the authority minimum for this city, with the clause recorded against every BOQ line.", 9.5, "#8892a2");
  T(LEFT, ly + 119, "Cable, pipe and duct lengths are engineered allowances from the building envelope, not measured runs. Supply an IFC model and they become measured.", 9.5, "#8892a2");
  p.push("</svg>");
  return p.join("\n");
}
