// run-doctor (2026-10-30): the agent that looks after failed and empty runs.
//
// Every few minutes (pg_cron) or on demand from Admin → Platform alerts ("Run check now") it reads the
// take-off runs (analysis_runs) and Draftsman jobs (draftsman_jobs) of the last few hours and, for each
// one that failed or came back empty:
//   - fixes it when a re-run can fix it (AI busy / timed out, server restarted): Draftsman jobs are put
//     back in the queue once; a whole-sheet take-off is run again once through ai-engine (doctor_retry,
//     no page charged). When the re-run finishes the user gets a "Fixed for you" message.
//   - tells the user exactly what to do when the cause is their file (specification uploaded as a
//     drawing, DWG with no PDF export, title sheet, page allowance used up, location missing ...).
//   - raises an admin alert for anything else (a platform bug) and tells the user "we're looking into it".
// It never changes code, drawings or BOQs. Two separate outputs: user_messages (the user's own pop-ups)
// and admin_alerts (platform admins only). Every source row is handled once (unique source + kind).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const LOOKBACK_HOURS = 6;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const TRANSIENT = /timed out|timeout|overloaded|\b529\b|\b429\b|rate.?limit|ECONNRESET|\b50[234]\b|temporarily|restarted for an update|connection (reset|closed|refused)|network/i;

type Msg = { kind: "fixed" | "action" | "info" | "investigating"; title: string; what_happened: string; what_we_did: string;
  what_to_do: string[]; action_label?: string; action_target?: Record<string, unknown>; must_read?: boolean };

function classifyRunError(err: string): { cause: string; msg?: Omit<Msg, "kind"> & { kind?: Msg["kind"] } } {
  if (TRANSIENT.test(err)) return { cause: "transient" };
  if (/page limit|pages? (left|remaining)|allowance|upgrade your plan|wallet|credit/i.test(err)) return { cause: "limit", msg: {
    title: "Your page allowance is used up", what_happened: "This drawing needs more AI pages than your plan has left this month.",
    what_we_did: "Nothing was charged for this attempt.", what_to_do: ["Open Billing & Subscription and choose a plan or a page pack.", "Then run the drawing again."],
    action_label: "See plans", action_target: { view: "billing" } } };
  if (/MB per-file limit|split it into smaller/i.test(err)) return { cause: "too_big", msg: {
    title: "This file is too large to read in one go", what_happened: "The file is over the size the AI can read at once.",
    what_we_did: "Nothing was charged for this attempt.", what_to_do: ["Split the PDF into smaller files (a few sheets each), or use Classify & Select Pages to pick the sheets you need.", "Upload and run them again."] } };
  if (/DWG|Revit|\.rvt|attach a PDF|export/i.test(err)) return { cause: "dwg", msg: {
    title: "Attach a PDF export of this drawing", what_happened: "DWG and Revit files can't be read directly.",
    what_we_did: "Nothing was charged for this attempt.", what_to_do: ["In AutoCAD or Revit, export the sheet to PDF (File → Export / Plot to PDF).", "Attach the PDF to this drawing and run it again."] } };
  return { cause: "bug" };
}

function classifyEmpty(notes: string, civil: boolean): { cause: string; msg?: Omit<Msg, "kind"> } {
  const seen = (notes.split(/What the AI saw:|Per-tile detail follows\./)[1] || notes).toLowerCase();
  if (/\bspecification\b|\bclause|\bmethod statement|material (list|schedule)/.test(seen) && !/\bplan\b|layout/.test(seen.slice(0, 400))) return { cause: "spec", msg: {
    title: "This file is a specification, not a drawing", what_happened: "There was nothing on it to count, because it is written text, not a drawing.",
    what_we_did: "We read every page. Nothing was charged.", what_to_do: ["Open your project, go to Specification and upload this file there.", "Run the take-off on the drawings; the BOQ will follow the specification."],
    action_label: "Go to Specification", action_target: { view: "specification" } } };
  if (/title sheet|cover sheet|drawing (list|index)|key ?plan|legend sheet|general notes/.test(seen)) return { cause: "cover", msg: {
    title: "This sheet has nothing to measure", what_happened: "It is a title, index, legend or notes sheet, with no devices or rooms to measure.",
    what_we_did: "We read the whole sheet. Nothing was charged.", what_to_do: ["Run the take-off on the plan sheets (layouts) of the package instead."] } };
  if (!civil && /architectural|floor plan|room (names|layout)|partition|structural|civil|site plan|elevation|section/.test(seen)) return { cause: "wrong_type", msg: {
    title: "This looks like an architectural or civil sheet", what_happened: "It was uploaded as an MEP / ELV drawing, so the AI looked for devices and found none.",
    what_we_did: "Nothing was charged for this attempt.", what_to_do: ["Open the drawing, change its type to Architectural, Structural or Civil.", "Run it again: it will be measured as civil works (finishes, blockwork, doors, plaster and more)."] } };
  if (civil) return { cause: "civil_empty" };
  return { cause: "nothing", msg: {
    title: "No items were found on this drawing", what_happened: "The AI read the sheet but found nothing countable for the selected discipline.",
    what_we_did: "Nothing was charged for this attempt.", what_to_do: ["Check the drawing type matches the sheet (e.g. Fire Alarm for a fire alarm layout).", "If the sheet is a scan, upload the original CAD PDF for the best result.", "Open the run notes to see what the AI looked for."] } };
}

const INVESTIGATING: Omit<Msg, "kind"> = { title: "We're looking into this run", what_happened: "Your run stopped because of a problem on our side, not with your file.",
  what_we_did: "Our team has been alerted with the details. Nothing was charged for this attempt.", what_to_do: ["You don't need to do anything now. We'll message you here when it's fixed.", "If it's urgent, try the run again later or contact support from Help."] };

function fingerprint(service: string, err: string) {
  return service + ":" + err.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "#").replace(/https?:\/\/\S+/g, "URL").replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 160);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  const admin = createClient(url, serviceKey);
  // who may run it: the scheduler (x-cron-secret = app_secrets.RUN_DOCTOR_SECRET, the same way
  // welcome-cleanup is scheduled), the service role, or a platform admin
  const cronHdr = req.headers.get("x-cron-secret") ?? "";
  let cronOk = false;
  if (cronHdr) {
    const { data: sec } = await admin.from("app_secrets").select("value").eq("key", "RUN_DOCTOR_SECRET").maybeSingle();
    cronOk = !!sec?.value && sec.value === cronHdr;
  }
  if (!cronOk && auth !== `Bearer ${serviceKey}`) {
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u } = await caller.auth.getUser();
    const { data: pa } = u?.user ? await admin.from("platform_admins").select("user_id").eq("user_id", u.user.id).maybeSingle() : { data: null };
    if (!pa) return json({ error: "Forbidden" }, 403);
  }
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* cron sends {} */ }
  const dry = body.dry_run === true;
  const since = new Date(Date.now() - (Number(body.hours) || LOOKBACK_HOURS) * 3600e3).toISOString();
  const report: any[] = [];

  const { data: handledRows } = await admin.from("user_messages").select("source_kind, source_id, kind").gte("created_at", new Date(Date.now() - 3 * 864e5).toISOString());
  const handled = new Set((handledRows ?? []).map((m: any) => `${m.source_kind}:${m.source_id}:${m.kind}`));
  const has = (sk: string, id: string, ...kinds: string[]) => kinds.some((k) => handled.has(`${sk}:${id}:${k}`));

  async function message(userId: string | null, sk: string, id: string, projectId: string | null, m: Msg) {
    report.push({ to: userId, source: `${sk}:${id}`, kind: m.kind, title: m.title });
    if (dry || !userId) return;
    await admin.from("user_messages").upsert({ user_id: userId, kind: m.kind, title: m.title, what_happened: m.what_happened, what_we_did: m.what_we_did,
      what_to_do: m.what_to_do, action_label: m.action_label ?? null, action_target: m.action_target ? { ...m.action_target, project_id: projectId } : (projectId ? { view: "project", project_id: projectId } : null),
      source_kind: sk, source_id: id, project_id: projectId, must_read: m.must_read ?? true }, { onConflict: "source_kind,source_id,kind", ignoreDuplicates: true });
    handled.add(`${sk}:${id}:${m.kind}`);
  }
  async function alertAdmin(service: string, title: string, err: string, example: Record<string, unknown>) {
    const fp = fingerprint(service, err);
    report.push({ alert: title, fingerprint: fp });
    if (dry) return;
    const { data: ex } = await admin.from("admin_alerts").select("id, occurrences, examples, status").eq("fingerprint", fp).maybeSingle();
    if (ex) {
      const examples = [...(ex.examples ?? []), example].slice(-10);
      await admin.from("admin_alerts").update({ occurrences: ex.occurrences + 1, last_seen: new Date().toISOString(), examples,
        status: ex.status === "fixed" ? "open" : ex.status, updated_at: new Date().toISOString() }).eq("id", ex.id);
    } else {
      await admin.from("admin_alerts").insert({ fingerprint: fp, service, title, error_text: err.slice(0, 4000), examples: [example] });
    }
  }
  async function who(userId: string | null) {
    if (!userId) return {};
    const { data } = await admin.auth.admin.getUserById(userId);
    return { user_email: data?.user?.email ?? null };
  }

  // ---------------------------------------------------------------- take-off runs
  const { data: runs } = await admin.from("analysis_runs")
    .select("id, project_id, drawing_id, status, run_kind, triggered_by, is_admin_assisted, error_message, summary, created_at")
    .gte("created_at", since).in("status", ["failed", "completed"]).not("drawing_id", "is", null).order("created_at", { ascending: true }).limit(300);
  for (const r of runs ?? []) {
    const sk = "analysis_run";
    const sum = r.summary ?? {};
    const empty = r.status === "completed" && Number(sum.item_count ?? 1) === 0;
    // a doctor re-run that finished: tell the user it is fixed
    if (sum.doctor_retry_of && r.status === "completed" && !empty && !has(sk, sum.doctor_retry_of, "fixed")) {
      const { data: orig } = await admin.from("analysis_runs").select("triggered_by").eq("id", sum.doctor_retry_of).maybeSingle();
      await message(orig?.triggered_by ?? null, sk, sum.doctor_retry_of, r.project_id, { kind: "fixed", title: "Your take-off is ready",
        what_happened: "The AI service was busy when you ran this drawing, so the take-off stopped before it finished.",
        what_we_did: `We ran it again automatically and it finished with ${sum.item_count} BOQ lines. No extra page was taken from your allowance.`,
        what_to_do: ["Open the BOQ and check the lines marked for review."], action_label: "Open BOQ", action_target: { view: "boq" } });
      continue;
    }
    if (r.is_admin_assisted || sum.doctor_retry_of) continue;          // admin and doctor runs are watched by the admin
    if (!(r.status === "failed" || empty)) continue;
    if (has(sk, r.id, "fixed", "action", "info", "investigating")) continue;
    // a newer successful run of the same drawing means the user already sorted it
    const { data: later } = await admin.from("analysis_runs").select("id, summary, status").eq("drawing_id", r.drawing_id).gt("created_at", r.created_at).eq("status", "completed").limit(5);
    if ((later ?? []).some((x: any) => Number(x.summary?.item_count ?? 0) > 0)) continue;
    const { data: dr } = await admin.from("drawings").select("file_name, discipline").eq("id", r.drawing_id).maybeSingle();
    const file = dr?.file_name ?? "drawing";
    if (r.status === "failed") {
      const err = String(r.error_message ?? "");
      const c = classifyRunError(err);
      if (c.cause === "transient" && r.run_kind !== "tiled") {
        report.push({ retry: r.id });
        if (!dry) {
          await message(r.triggered_by, sk, r.id, r.project_id, { kind: "investigating", must_read: false, title: "Re-running your drawing",
            what_happened: `The AI service was busy when you ran ${file}.`, what_we_did: "We are running it again for you now, free.", what_to_do: ["Nothing. We'll show you a message when it's ready."] });
          const res = await fetch(`${url}/functions/v1/ai-engine`, { method: "POST", headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "analyze_drawing", doctor_retry: true, doctor_retry_of: r.id, user_id: r.triggered_by, target_project_id: r.project_id, project_id: r.project_id, drawing_id: r.drawing_id }) }).catch(() => null);
          if (!res || !res.ok) {                // the retry itself could not start: a platform problem, not the user's
            const t = res ? `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` : "no response";
            await alertAdmin("run-doctor", "Automatic retry could not start", t, { ...(await who(r.triggered_by)), project_id: r.project_id, file, source_kind: sk, source_id: r.id, at: r.created_at });
          }
        }
        continue;
      }
      if (c.cause === "transient") {          // tiled sheets are rendered in the browser: the user presses Run again
        await message(r.triggered_by, sk, r.id, r.project_id, { kind: "action", title: "Please run this drawing again",
          what_happened: `The AI service was busy while reading ${file} in high resolution, so the run stopped.`, what_we_did: "Nothing was charged for this attempt.",
          what_to_do: ["Open the drawing and press Run AI take-off again. It usually finishes on the second try."], action_label: "Open drawing", action_target: { view: "drawings", drawing_id: r.drawing_id } });
        continue;
      }
      if (c.msg) { await message(r.triggered_by, sk, r.id, r.project_id, { kind: "action", ...(c.msg as any) }); continue; }
      await alertAdmin("take-off", `Take-off failed: ${err.slice(0, 90)}`, err, { ...(await who(r.triggered_by)), project_id: r.project_id, file, source_kind: sk, source_id: r.id, at: r.created_at });
      await message(r.triggered_by, sk, r.id, r.project_id, { kind: "investigating", ...INVESTIGATING });
      continue;
    }
    // empty result
    const c = classifyEmpty(String(sum.notes ?? ""), sum.civil === true);
    if (c.msg) { await message(r.triggered_by, sk, r.id, r.project_id, { kind: "action", ...c.msg }); continue; }
    await alertAdmin("take-off", "Civil sheet measured nothing", `civil plan returned 0 items: ${file}`, { ...(await who(r.triggered_by)), project_id: r.project_id, file, source_kind: sk, source_id: r.id, at: r.created_at });
    await message(r.triggered_by, sk, r.id, r.project_id, { kind: "investigating", ...INVESTIGATING });
  }

  // ---------------------------------------------------------------- Draftsman jobs
  const { data: jobs } = await admin.from("draftsman_jobs").select("id, project_id, created_by, status, error, options, summary, ifc_name, created_at, finished_at")
    .gte("created_at", since).in("status", ["failed", "done"]).order("created_at", { ascending: true }).limit(300);
  for (const j of jobs ?? []) {
    const sk = "draftsman_job";
    const o = j.options ?? {};
    if (j.status === "done") {
      if (o.doctor_retry && !has(sk, j.id, "fixed")) await message(j.created_by, sk, j.id, j.project_id, { kind: "fixed", title: "Your drawings are ready",
        what_happened: "The drawing job stopped part-way the first time (the server was busy or restarting).", what_we_did: "We put it back in the queue and it has now finished. No extra pages were taken.",
        what_to_do: ["Open the Draftsman page and download the drawings."], action_label: "Open drawings", action_target: { view: "draftsman" } });
      continue;
    }
    if (has(sk, j.id, "fixed", "action", "info", "investigating")) continue;
    const err = String(j.error ?? "");
    const file = j.ifc_name ?? "plans";
    if (TRANSIENT.test(err) && !o.doctor_retry) {
      report.push({ requeue: j.id });
      if (!dry) {
        await admin.from("draftsman_jobs").update({ status: "queued", error: null, started_at: null, finished_at: null, worker: null, options: { ...o, doctor_retry: true } }).eq("id", j.id).eq("status", "failed");
        await message(j.created_by, sk, j.id, j.project_id, { kind: "investigating", must_read: false, title: "Re-running your drawing job",
          what_happened: `The server was busy or restarting while drawing ${file}.`, what_we_did: "We put the job back in the queue, free.", what_to_do: ["Nothing. You can follow it on the Draftsman page."] });
      }
      continue;
    }
    let m: Omit<Msg, "kind"> | null = null;
    if (/switched off by the administrator/i.test(err)) m = { title: "This system is not available yet", what_happened: "One of the systems you chose is switched off on the platform for now.", what_we_did: "Nothing was charged.", what_to_do: ["Run the job again without that system, or contact support to ask when it will be available."] };
    else if (/location|country and city/i.test(err)) m = { title: "Add the project location", what_happened: "The project has no country and city, which decide the authority rules.", what_we_did: "Nothing was charged.", what_to_do: ["Open the project details and set the country and city.", "Run the drawings again."] };
    else if (/only PDF and DXF|save DWG files as DXF/i.test(err)) m = { title: "Save the DWG as DXF", what_happened: "DWG files can't be read directly.", what_we_did: "Nothing was charged.", what_to_do: ["In AutoCAD use Save As → DXF.", "Upload the DXF (or a PDF of the plan) and run again."] };
    else if (/page limit|allowance|pages left|upgrade/i.test(err)) m = { title: "Your drawing-page allowance is used up", what_happened: "This job needs more pages than your plan has left.", what_we_did: "Nothing was charged.", what_to_do: ["Open Billing & Subscription and choose a plan or page pack.", "Run the drawings again."], action_label: "See plans", action_target: { view: "billing" } };
    else if (/Already drawn in this package/i.test(err)) m = { title: "These systems are already drawn", what_happened: "The systems you added are already in this drawing package.", what_we_did: "Nothing was charged.", what_to_do: ["Use Rework on the drawing to change it instead of adding it again."] };
    if (m) { await message(j.created_by, sk, j.id, j.project_id, { kind: "action", ...m }); continue; }
    await alertAdmin("draftsman", `Draftsman job failed: ${err.split("\n").slice(-1)[0].slice(0, 90)}`, err, { ...(await who(j.created_by)), project_id: j.project_id, file, source_kind: sk, source_id: j.id, at: j.created_at });
    await message(j.created_by, sk, j.id, j.project_id, { kind: "investigating", ...INVESTIGATING });
  }
  return json({ ok: true, dry_run: dry, since, service_key_kind: serviceKey.startsWith("eyJ") ? "jwt" : "secret", actions: report });
});
