// ===========================================================================
// Quantora — welcome-cleanup (25 Oct 2026; tender documents too)
//
// The Welcome Pack 7-day rule. A Welcome Pack (plan 'trial') company has 7
// days (companies.welcome_delete_at) to choose a paid plan. After that, this
// engine deletes its projects -- everything under a project cascades in the
// database -- and every file in those projects' storage folders. The login,
// the company and its billing history stay, so the customer can come back and
// subscribe.
//
// Never touched: any company not on 'trial', companies paying or granted a plan
// (billing_provider razorpay/manual), and companies with a platform admin in them.
//
// Who may call it ("Verify JWT" is OFF for this function):
//   - the daily schedule (pg_cron), with header x-cron-secret equal to
//     app_secrets.WELCOME_CLEANUP_SECRET
//   - a signed-in platform admin (Authorization: Bearer <user token>)
//
// Actions:
//   run      { dry_run? }  delete expired Welcome Pack work (dry_run: only report)
//   status                 next deletions + the last 50 log rows (admin)
//   orphans  { dry_run? }  files no project, company or drawing points at (admin)
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const describe = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e).slice(0, 300));

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });
const BUCKET = "drawings";

async function removeFiles(names: string[], bucket = BUCKET): Promise<number> {
  let removed = 0;
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const { data, error } = await admin.storage.from(bucket).remove(batch);
    if (error) throw error;
    removed += (data ?? []).length;
  }
  return removed;
}

/** Companies whose Welcome Pack time is up, minus everything that must never be touched. */
async function expiredCompanies() {
  const { data: cos, error } = await admin.from("companies")
    .select("id, name, plan, billing_provider, welcome_delete_at")
    .eq("plan", "trial").not("welcome_delete_at", "is", null).lt("welcome_delete_at", new Date().toISOString());
  if (error) throw error;
  const { data: admins } = await admin.from("platform_admins").select("user_id");
  const adminIds = (admins ?? []).map((a: any) => a.user_id);
  const { data: adminProfiles } = adminIds.length
    ? await admin.from("profiles").select("company_id").in("id", adminIds)
    : { data: [] as any[] };
  const adminCos = new Set((adminProfiles ?? []).map((p: any) => p.company_id));
  return (cos ?? []).filter((c: any) =>
    !adminCos.has(c.id) && !["razorpay", "manual"].includes(String(c.billing_provider ?? "")));
}

async function run(dryRun: boolean) {
  const out: any[] = [];
  for (const co of await expiredCompanies()) {
    try {
      const { data: projects } = await admin.from("projects").select("id").eq("company_id", co.id);
      const ids = (projects ?? []).map((p: any) => String(p.id));
      if (!ids.length) continue;                        // nothing left to delete
      // Every file of these projects in every bucket: project folders,
      // drawings stored elsewhere, and the tender documents of their tenders.
      const { data: files, error: fErr } = await admin.rpc("admin_storage_for_projects", { p_ids: ids });
      if (fErr) throw fErr;
      const byBucket: Record<string, string[]> = {};
      for (const f of files ?? []) (byBucket[f.bucket] ??= []).push(f.name);
      const total = (files ?? []).length;
      const bytes = (files ?? []).reduce((s: number, f: any) => s + Number(f.size ?? 0), 0);
      let removed = 0;
      if (!dryRun) {
        for (const [bucket, names] of Object.entries(byBucket)) removed += await removeFiles(names, bucket);
        // Keep the project rows (they say which files are whose) if storage
        // did not let go of everything; the next run tries again.
        if (removed < total) throw new Error(`only ${removed} of ${total} files could be removed; projects kept`);
        const { error: pErr } = await admin.from("projects").delete().in("id", ids);
        if (pErr) throw pErr;
        await admin.from("companies").update({ welcome_cleared_at: new Date().toISOString() }).eq("id", co.id);
      }
      const row = { company_id: co.id, company_name: co.name, projects_deleted: ids.length,
        files_deleted: dryRun ? total : removed, bytes_freed: bytes, dry_run: dryRun,
        note: "Welcome Pack: no plan chosen within 7 days" };
      if (!dryRun) await admin.from("welcome_cleanup_log").insert(row);   // previews are not logged
      out.push(row);
    } catch (e) {
      const note = `failed: ${describe(e)}`.slice(0, 500);
      console.error("welcome-cleanup", co.id, note);
      if (!dryRun) await admin.from("welcome_cleanup_log").insert({ company_id: co.id, company_name: co.name, note });
      out.push({ company_id: co.id, company_name: co.name, error: note });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "run");
    const dryRun = body?.dry_run === true;

    // Who is calling: the schedule, or a platform admin.
    let isCron = false, isAdmin = false;
    const cronHeader = req.headers.get("x-cron-secret") ?? "";
    if (cronHeader) {
      const { data: s } = await admin.from("app_secrets").select("value").eq("key", "WELCOME_CLEANUP_SECRET").maybeSingle();
      isCron = !!s?.value && String(s.value).trim() === cronHeader;
    }
    if (!isCron) {
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: ud } = jwt ? await admin.auth.getUser(jwt) : { data: null as any };
      if (ud?.user) {
        const { data: a } = await admin.from("platform_admins").select("user_id").eq("user_id", ud.user.id).maybeSingle();
        isAdmin = !!a;
      }
    }
    if (!isCron && !isAdmin) return json({ error: "Not allowed." }, 401);

    if (action === "run") {
      const results = await run(dryRun);
      return json({ ok: true, dry_run: dryRun, companies: results.length, results });
    }

    if (!isAdmin) return json({ error: "Platform admin access only." }, 403);

    if (action === "status") {
      const { data: upcoming } = await admin.from("companies")
        .select("id, name, welcome_delete_at, welcome_cleared_at, created_at")
        .eq("plan", "trial").not("welcome_delete_at", "is", null)
        .order("welcome_delete_at", { ascending: true }).limit(100);
      const ids = (upcoming ?? []).map((c: any) => c.id);
      const { data: projs } = ids.length
        ? await admin.from("projects").select("company_id").in("company_id", ids)
        : { data: [] as any[] };
      const count: Record<string, number> = {};
      for (const p of projs ?? []) count[p.company_id] = (count[p.company_id] ?? 0) + 1;
      const { data: log } = await admin.from("welcome_cleanup_log").select("*")
        .order("run_at", { ascending: false }).limit(50);
      const { data: job } = await admin.rpc("welcome_cleanup_schedule").maybeSingle();
      return json({
        scheduled: !!job, schedule: job ?? null,
        upcoming: (upcoming ?? []).map((c: any) => ({ ...c, projects: count[c.id] ?? 0 })),
        log: log ?? [],
      });
    }

    if (action === "orphans") {
      const { data: files, error } = await admin.rpc("admin_storage_orphans");
      if (error) throw error;
      const bytes = (files ?? []).reduce((s: number, f: any) => s + Number(f.size ?? 0), 0);
      let removed = 0;
      if (!dryRun && (files ?? []).length) {
        removed = await removeFiles((files ?? []).map((f: any) => f.name));
        await admin.from("welcome_cleanup_log").insert({ company_name: "(files with no owner)", files_deleted: removed,
          bytes_freed: bytes, note: "One-time clean-up of files left by deleted projects" });
      }
      return json({ ok: true, dry_run: dryRun, files: (files ?? []).length, bytes, removed });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("welcome-cleanup error:", describe(err));
    return json({ error: describe(err) }, 500);
  }
});
