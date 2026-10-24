// ===========================================================================
// Quantora — design-engine edge function
//
// Generates a code-driven MEP and ELV design for a project: per-floor device
// schedule, cable, containment and pipework, a riser drawing, and BOQ rows that
// land in the same tables the drawing-analysis path writes to, so Estimation,
// Markup and Export all work on them unchanged.
//
// This function makes NO AI CALL. It is arithmetic over published code rules,
// which means it is free to run, instant, and gives the same answer twice. The
// AI paths read drawings; this one designs from requirements.
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { BuildingSpec, FloorSpec } from "./rules.ts";
import { runDesign, renderRiserSvg } from "./engine.ts";
import { ALL_SYSTEMS } from "./systems.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

const describe = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const x = e as any;
    return [x.message, x.details, x.hint].filter(Boolean).join(" — ") || JSON.stringify(e).slice(0, 300);
  }
  return String(e);
};

/**
 * A default space mix per building type, used when the customer has not
 * described each floor. It is a starting point they can correct, not a guess
 * presented as fact — the UI shows these numbers and lets them be edited, and
 * the basis on every line says they came from the template.
 */
const TEMPLATES: Record<string, (a: number) => Record<string, number>> = {
  residential_building: (a) => ({ apartment: a * 0.78, corridor: a * 0.12, lobby: a * 0.05, toilet: a * 0.05 }),
  villa:                (a) => ({ apartment: a * 0.85, corridor: a * 0.08, toilet: a * 0.07 }),
  office_building:      (a) => ({ office: a * 0.72, corridor: a * 0.13, lobby: a * 0.07, toilet: a * 0.05, plant_room: a * 0.03 }),
  commercial_building:  (a) => ({ office: a * 0.60, retail: a * 0.20, corridor: a * 0.12, lobby: a * 0.05, toilet: a * 0.03 }),
  retail_mall:          (a) => ({ retail: a * 0.68, corridor: a * 0.18, lobby: a * 0.07, toilet: a * 0.04, kitchen: a * 0.03 }),
  hospital:             (a) => ({ office: a * 0.55, corridor: a * 0.22, lobby: a * 0.08, toilet: a * 0.08, plant_room: a * 0.07 }),
  school:               (a) => ({ office: a * 0.62, corridor: a * 0.20, lobby: a * 0.06, toilet: a * 0.08, kitchen: a * 0.04 }),
  warehouse:            (a) => ({ warehouse: a * 0.86, office: a * 0.08, toilet: a * 0.03, plant_room: a * 0.03 }),
  hotel:                (a) => ({ apartment: a * 0.70, corridor: a * 0.16, lobby: a * 0.06, toilet: a * 0.04, kitchen: a * 0.04 }),
};
const BASEMENT = (a: number) => ({ car_park: a * 0.88, plant_room: a * 0.08, stair: a * 0.04 });

function buildFromProject(p: any, body: any): BuildingSpec {
  if (Array.isArray(body.floors) && body.floors.length) {
    return {
      name: p.project_name, country: p.country, city: p.city,
      floors: body.floors as FloorSpec[],
      floorToFloorMm: body.floor_to_floor_mm ?? 3600,
      mainEntrances: body.main_entrances ?? 1,
      carParkLanes: body.car_park_lanes ?? 0,
    };
  }
  const levels = Math.max(1, Number(p.number_of_floors) || 1);
  const basements = Math.max(0, Number(p.basement_levels) || 0);
  // Area is held in the project's own unit. Everything downstream is metric, so
  // square feet are converted here rather than silently designing a building
  // ten times too big.
  const rawArea = Math.max(1, Number(p.area_size) || 0);
  const unit = String(p.area_unit ?? "sqm").toLowerCase();
  const gross = unit.includes("ft") ? rawArea * 0.092903 : rawArea;
  const perFloor = gross / (levels + basements);
  const tmpl = TEMPLATES[p.building_type] ?? TEMPLATES.residential_building;

  const floors: FloorSpec[] = [];
  for (let i = basements; i >= 1; i--)
    floors.push({ name: `Basement ${i}`, level: -i, spaces: BASEMENT(perFloor), doors: 4, lifts: 2 });
  for (let i = 0; i < levels; i++)
    floors.push({
      name: i === 0 ? "Ground" : `Level ${String(i).padStart(2, "0")}`, level: i,
      spaces: tmpl(perFloor), doors: i === 0 ? 8 : 3, lifts: 2,
    });
  return {
    name: p.project_name, country: p.country, city: p.city, floors,
    floorToFloorMm: body.floor_to_floor_mm ?? 3600,
    mainEntrances: body.main_entrances ?? 1,
    carParkLanes: basements > 0 ? 1 : 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const startedAt = Date.now();
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in." }, 401);
    const { data: ud, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !ud?.user) return json({ error: "Not signed in." }, 401);
    const userId = ud.user.id;

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "generate_design");
    if (!["capabilities", "preview", "generate_design"].includes(action))
      return json({ error: `Unknown action: ${action}` }, 400);

    if (action === "capabilities") {
      return json({
        systems: ALL_SYSTEMS.map(s => ({ key: s.key, label: s.label, family: s.family, colour: s.colour })),
      });
    }

    const projectId = String(body.project_id ?? "");
    if (!projectId) return json({ error: "project_id is required." }, 400);

    const { data: project } = await admin.from("projects").select("*").eq("id", projectId).maybeSingle();
    const { data: access } = project
      ? await admin.rpc("project_access_for", { p_user: userId, p_project: project.id })
      : { data: null };
    if (!project || !access) return json({ error: "Project not found, or not on your team." }, 404);
    if (access !== "edit" && action !== "preview") {
      return json({ error: "Your role on this team can view this project but not design on it. Ask an admin to change your role." }, 403);
    }

    const selected: string[] = Array.isArray(body.systems) && body.systems.length
      ? body.systems : ALL_SYSTEMS.map(s => s.key);
    const known = new Set(ALL_SYSTEMS.map(s => s.key));
    const unknown = selected.filter(s => !known.has(s));
    if (unknown.length) return json({ error: `Unknown system(s): ${unknown.join(", ")}` }, 400);

    if (!project.number_of_floors || !project.area_size) {
      return json({ error: "This project does not say how many floors it has or how big it is. Both are needed before anything can be designed — open the project and fill them in." }, 400);
    }

    // A sanity check on the numbers before designing anything from them. Some
    // projects were saved with 200 floors and 5,000 m² in total, which is 25 m²
    // a floor — a typing slip, not a building. Designing from it would produce a
    // confident BOQ for something that cannot exist, which is worse than
    // refusing.
    const plausLevels = Math.max(1, Number(project.number_of_floors) || 1)
                      + Math.max(0, Number(project.basement_levels) || 0);
    const plausUnit = String(project.area_unit ?? "sqm").toLowerCase();
    const plausArea = (Number(project.area_size) || 0) * (plausUnit.includes("ft") ? 0.092903 : 1);
    const perFloorArea = plausArea / plausLevels;
    if (perFloorArea < 25) {
      return json({
        error: `These figures work out at ${Math.round(perFloorArea)} m² a floor — ${Math.round(plausArea).toLocaleString()} m² spread over ${plausLevels} levels. That is smaller than one room, so the floor count or the area is probably a typing slip. Correct them in the project and try again.`,
      }, 400);
    }

    const building = buildFromProject(project, body);
    const res = runDesign(building, selected);
    if (!res.lines.length) return json({ error: "Nothing was produced. Check the selected systems against the building description." }, 400);

    // A dry run: the customer sees the floor mix the template produced and the
    // headline quantities, and can correct them, before anything is written.
    if (action === "preview") {
      return json({
        authority: res.authority.name,
        floors: building.floors.map((f) => ({
          name: f.name, level: f.level, spaces: f.spaces,
          doors: f.doors ?? 0, lifts: f.lifts ?? 0, overrides: f.overrides ?? {},
        })),
        systems: Object.fromEntries(Object.entries(res.families).map(([k, f]) => [k, f.total])),
        item_count: res.lines.length,
        devices: res.totals.devices,
      });
    }

    // ---- supersede any earlier design run so re-running replaces, not doubles
    const { data: prior } = await admin.from("analysis_runs").select("id")
      .eq("project_id", projectId).is("drawing_id", null).eq("run_kind", "design_drawing");
    const priorIds = (prior ?? []).map((r: any) => r.id);
    if (priorIds.length) {
      await admin.from("boq_items").delete().in("analysis_run_id", priorIds);
      await admin.from("analysis_runs").update({ status: "superseded" }).in("id", priorIds);
    }

    const { data: last } = await admin.from("analysis_runs")
      .select("revision_number").eq("project_id", projectId)
      .order("revision_number", { ascending: false }).limit(1);
    const revision = ((last && last[0]?.revision_number) || 0) + 1;

    const { data: run, error: runErr } = await admin.from("analysis_runs").insert({
      project_id: projectId, drawing_id: null, revision_number: revision,
      status: "processing", triggered_by: userId, run_kind: "design_drawing",
    }).select().single();
    if (runErr) throw runErr;

    // ---- BOQ rows, into the same table every other path writes to
    const rows = res.lines.map((l) => ({
      project_id: projectId, drawing_id: null, analysis_run_id: run.id,
      revision_number: revision,
      system_category: l.system,
      description: l.label,
      quantity: l.qty, unit: l.unit,
      location: l.floor,
      floor_label: l.floor,
      confidence_score: l.source === "client" ? 99 : 90,
      source: "engineering_rule",
      quantity_source_type: "calculated_quantity",
      optimization_status: "engineered",
      review_status: "pending",
      quantity_basis_notes: l.basis,
      technical_specification: l.mountingMm ? `Mounting height ${l.mountingMm} mm AFF.` : null,
    }));
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await admin.from("boq_items").insert(rows.slice(i, i + 400));
      if (error) throw error;
    }

    // ---- the drawing
    const svg = renderRiserSvg(res);
    const path = `${projectId}/design/riser-${run.id}.svg`;
    const up = await admin.storage.from("drawings")
      .upload(path, new Blob([svg], { type: "image/svg+xml" }), { upsert: true, contentType: "image/svg+xml" });
    const stored = up.error ? null : path;
    let signedUrl: string | null = null;
    if (stored) {
      const { data: sig } = await admin.storage.from("drawings").createSignedUrl(stored, 60 * 60 * 24 * 7);
      signedUrl = sig?.signedUrl ?? null;
    }

    const summary = {
      item_count: rows.length,
      devices: res.totals.devices,
      client_directed: res.totals.clientDirected,
      authority: res.authority.name,
      systems: Object.fromEntries(Object.entries(res.families).map(([k, f]) => [k, f.total])),
      drawing_path: stored,
      spec: {
        floors: building.floors.map((f) => ({
          name: f.name, level: f.level, spaces: f.spaces,
          doors: f.doors ?? 0, lifts: f.lifts ?? 0, overrides: f.overrides ?? {},
        })),
        floor_to_floor_mm: building.floorToFloorMm,
        selected_systems: selected,
        from_template: !(Array.isArray(body.floors) && body.floors.length),
      },
      notes:
        `Rules-based design against ${res.authority.name}. ${res.totals.devices.toLocaleString()} devices across ` +
        `${selected.length} systems and ${building.floors.length} levels, producing ${rows.length} BOQ lines. ` +
        `No AI call was made and no AI cost was incurred — every quantity comes from a published code rule or a ` +
        `stated client requirement, and each line carries the rule it came from. ` +
        `Cable, pipe and duct lengths are engineered allowances from the building envelope, not measured runs.`,
    };
    await admin.from("analysis_runs").update({
      status: "completed", completed_at: new Date().toISOString(), summary,
    }).eq("id", run.id);

    // Recorded so the design runs are visible in admin usage alongside the AI
    // ones. cost_cents is zero because no model was called — the cost of this
    // feature is the code that computes it, not a per-run charge.
    await admin.from("ai_usage").insert({
      company_id: project.company_id ?? null, user_id: userId, project_id: projectId,
      action: "generate_design", input_tokens: 0, output_tokens: 0, total_tokens: 0,
      cost_cents: 0, actual_cost_cents: 0, page_count: 0,
      model_used: "rules-engine", processing_time_ms: Date.now() - startedAt,
    });

    return json({
      run_id: run.id, revision_number: revision, ...summary,
      svg_path: stored, svg_url: signedUrl, svg: body.include_svg ? svg : undefined,
    });
  } catch (err) {
    console.error("design-engine error:", describe(err));
    return json({ error: describe(err) }, 500);
  }
});
