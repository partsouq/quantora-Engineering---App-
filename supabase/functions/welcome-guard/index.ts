// ===========================================================================
// Quantora — welcome-guard (25 Oct 2026)
//
// Keeps the free Welcome Pack for real first-time users:
//   register      once per new company, after sign-up. Checks the e-mail
//                 (throw-away domains, Gmail dot/plus tricks), the device and
//                 the internet connection. A repeat sign-up is moved to the
//                 Free plan (no AI allowance) instead of a second Welcome Pack.
//                 A work e-mail gets 1 extra drawing page. A real first-timer
//                 also gets the ready-made sample project.
//   request_more  "Need a little more? Ask us" from a signed-in user.
//   admin_list / admin_grant / admin_decline / admin_sample   platform admins.
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const describe = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e).slice(0, 300));
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "drawings";

// Common throw-away e-mail services.
const DISPOSABLE = new Set(("mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org sharklasers.com grr.la " +
  "10minutemail.com 10minutemail.net tempmail.com temp-mail.org temp-mail.io tempmail.net tempmailo.com tempail.com " +
  "yopmail.com yopmail.net yopmail.fr trashmail.com trashmail.de trashmail.net getnada.com nada.email dispostable.com " +
  "maildrop.cc mintemail.com throwawaymail.com fakeinbox.com mohmal.com emailondeck.com moakt.com burnermail.io " +
  "mailnesia.com mailcatch.com spamgourmet.com spambox.us mytemp.email tempr.email discard.email getairmail.com " +
  "inboxkitten.com mail.tm mail.gw emailfake.com fakemail.net tmail.ws tmpmail.org tmpmail.net mailpoof.com " +
  "byom.de mvrht.com harakirimail.com 33mail.com anonaddy.me linshiyouxiang.net 20minutemail.com email-temp.com " +
  "dropmail.me minuteinbox.com spam4.me trbvm.com cuvox.de armyspy.com dayrep.com einrot.com fleckens.hu gustr.com " +
  "jourrapide.com rhyta.com superrito.com teleworm.us").split(/\s+/));
// Personal e-mail providers: anything else counts as a work e-mail.
const PUBLIC_MAIL = new Set(("gmail.com googlemail.com yahoo.com yahoo.co.in yahoo.co.uk ymail.com rocketmail.com " +
  "outlook.com hotmail.com hotmail.co.uk live.com msn.com icloud.com me.com mac.com aol.com proton.me protonmail.com " +
  "zoho.com zohomail.com gmx.com gmx.net mail.com yandex.com yandex.ru rediffmail.com qq.com 163.com 126.com " +
  "naver.com tutanota.com fastmail.com hey.com").split(/\s+/));

function normEmail(email: string) {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return { norm: e, domain: "" };
  let local = e.slice(0, at), domain = e.slice(at + 1);
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return { norm: `${local}@${domain}`, domain };
}

async function isAdminUser(userId: string) {
  const { data } = await admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}
async function secret(key: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return String(data?.value ?? "").trim();
}

// ---------------------------------------------------------------- sample project
const SAMPLE_TABLES = ["drawings", "analysis_runs", "boq_items", "boq_assumptions", "boq_review_items",
  "project_specifications", "system_briefs", "draftsman_briefs", "project_base_plans", "draftsman_jobs",
  "project_estimates", "estimate_labour", "estimate_staff", "system_budgets"];

async function copySample(templateId: string, companyId: string, userId: string) {
  const { data: tpl } = await admin.from("projects").select("*").eq("id", templateId).maybeSingle();
  if (!tpl) throw new Error("Sample project not found.");
  const newId = crypto.randomUUID();
  const map = new Map<string, string>([[templateId, newId]]);
  const rowsBy: Record<string, any[]> = {};
  for (const t of SAMPLE_TABLES) {
    const { data, error } = await admin.from(t).select("*").eq("project_id", templateId);
    if (error) continue;                       // table without project rows or not readable: skip
    rowsBy[t] = data ?? [];
    for (const r of rowsBy[t]) if (r.id && typeof r.id === "string") map.set(r.id, crypto.randomUUID());
  }
  const swap = (v: any) => {
    let s = JSON.stringify(v);
    for (const [a, b] of map) s = s.split(a).join(b);
    return JSON.parse(s);
  };
  const owner = (r: any) => {
    for (const k of ["created_by", "uploaded_by", "user_id", "owner_id"]) if (k in r && r[k]) r[k] = userId;
    return r;
  };
  // project row
  const p = owner(swap(tpl));
  p.id = newId; p.company_id = companyId; p.is_sample = true;
  p.project_name = (await secret("SAMPLE_PROJECT_NAME")) || "Sample project";
  if ("project_ref" in p) p.project_ref = "SAMPLE";
  for (const k of ["created_at", "updated_at"]) if (k in p) delete p[k];
  const { error: pe } = await admin.from("projects").insert(p);
  if (pe) throw new Error(`sample project: ${describe(pe)}`);
  // files: everything under the template folder, plus drawings stored elsewhere
  const { data: files } = await admin.rpc("admin_storage_under", { prefixes: [templateId] });
  for (const f of files ?? []) {
    const to = String(f.name).split(templateId).join(newId);
    await admin.storage.from(BUCKET).copy(f.name, to).catch(() => {});
  }
  // rows
  const report: Record<string, number | string> = {};
  for (const t of SAMPLE_TABLES) {
    const src = rowsBy[t] ?? [];
    if (!src.length) continue;
    const out = [];
    for (const r0 of src) {
      const r = owner(swap(r0));
      if (t === "drawings" && r.storage_path && !String(r0.storage_path).startsWith(templateId)) {
        const to = `${newId}/sample/${String(r0.storage_path).split("/").pop()}`;
        await admin.storage.from(BUCKET).copy(r0.storage_path, to).catch(() => {});
        r.storage_path = to;
      }
      out.push(r);
    }
    const { error } = await admin.from(t).insert(out);
    report[t] = error ? `failed: ${describe(error).slice(0, 120)}` : out.length;
  }
  return { project_id: newId, report };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: ud } = jwt ? await admin.auth.getUser(jwt) : { data: null as any };
    const user = ud?.user;
    if (!user) return json({ error: "Not signed in." }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    // ---------------- admin
    if (action.startsWith("admin_")) {
      if (!(await isAdminUser(user.id))) return json({ error: "Platform admin access only." }, 403);
      if (action === "admin_list") {
        const { data: checks } = await admin.from("signup_checks").select("*").order("created_at", { ascending: false }).limit(150);
        const { data: reqs } = await admin.from("allowance_requests").select("*").order("created_at", { ascending: false }).limit(150);
        const ids = [...new Set([...(checks ?? []), ...(reqs ?? [])].map((r: any) => r.company_id).filter(Boolean))];
        const { data: cos } = ids.length ? await admin.from("companies").select("id, name, plan").in("id", ids) : { data: [] as any[] };
        const co: Record<string, any> = {}; for (const c of cos ?? []) co[c.id] = c;
        const sampleId = await secret("SAMPLE_PROJECT_ID");
        const { data: sp } = sampleId ? await admin.from("projects").select("id, project_name, project_ref").eq("id", sampleId).maybeSingle() : { data: null };
        return json({
          checks: (checks ?? []).map((c: any) => ({ ...c, company: co[c.company_id]?.name ?? null, plan: co[c.company_id]?.plan ?? null })),
          requests: (reqs ?? []).map((r: any) => ({ ...r, company: co[r.company_id]?.name ?? null, plan: co[r.company_id]?.plan ?? null })),
          sample: sp ?? null,
        });
      }
      if (action === "admin_grant") {
        const companyId = String(body.company_id ?? "");
        const add = (k: string) => Math.max(0, Math.min(500, Math.floor(Number(body[k] ?? 0))));
        const { data: c } = await admin.from("companies").select("bonus_drawing_pages, bonus_documents, bonus_draftsman_pages").eq("id", companyId).maybeSingle();
        if (!c) return json({ error: "Company not found." }, 404);
        const patch = {
          bonus_drawing_pages: Number(c.bonus_drawing_pages || 0) + add("pages"),
          bonus_documents: Number(c.bonus_documents || 0) + add("documents"),
          bonus_draftsman_pages: Number(c.bonus_draftsman_pages || 0) + add("draftsman"),
        };
        const { error } = await admin.from("companies").update(patch).eq("id", companyId);
        if (error) throw error;
        const note = `+${add("pages")} drawing pages, +${add("documents")} documents, +${add("draftsman")} draftsman pages`;
        if (body.request_id) await admin.from("allowance_requests").update({ status: "granted", granted_note: note, decided_at: new Date().toISOString() }).eq("id", body.request_id);
        return json({ ok: true, note });
      }
      if (action === "admin_restore_welcome") {
        // A repeat sign-up that is genuine after all: give it the Welcome Pack.
        const companyId = String(body.company_id ?? "");
        const { error } = await admin.from("companies").update({ plan: "trial" }).eq("id", companyId).eq("plan", "free");
        if (error) throw error;
        await admin.from("signup_checks").update({ outcome: "welcome_restored" }).eq("company_id", companyId);
        return json({ ok: true });
      }
      if (action === "admin_decline") {
        await admin.from("allowance_requests").update({ status: "declined", decided_at: new Date().toISOString() }).eq("id", body.request_id);
        return json({ ok: true });
      }
      if (action === "admin_sample") {
        const pid = String(body.project_id ?? "").trim();
        if (pid) {
          const { data: p } = await admin.from("projects").select("id").eq("id", pid).maybeSingle();
          if (!p) return json({ error: "No project with that id." }, 404);
        }
        await admin.from("app_secrets").upsert({ key: "SAMPLE_PROJECT_ID", value: pid }, { onConflict: "key" });
        if (body.name !== undefined) await admin.from("app_secrets").upsert({ key: "SAMPLE_PROJECT_NAME", value: String(body.name || "Sample project").slice(0, 80) }, { onConflict: "key" });
        return json({ ok: true });
      }
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    const { data: prof } = await admin.from("profiles").select("company_id").eq("id", user.id).maybeSingle();
    const companyId = prof?.company_id as string | undefined;
    if (!companyId) return json({ status: "no_company" });
    const { data: company } = await admin.from("companies").select("id, plan, created_at").eq("id", companyId).maybeSingle();

    // ---------------- request more
    if (action === "request_more") {
      const { count } = await admin.from("allowance_requests").select("id", { count: "exact", head: true })
        .eq("company_id", companyId).eq("status", "open");
      if ((count ?? 0) >= 3) return json({ error: "You already have requests waiting. We will reply soon." }, 429);
      const { error } = await admin.from("allowance_requests").insert({
        company_id: companyId, user_id: user.id, what: String(body.what ?? "").slice(0, 200),
        message: String(body.message ?? "").slice(0, 1500),
      });
      if (error) throw error;
      return json({ ok: true });
    }

    // ---------------- register (once per company)
    if (action === "register") {
      const { data: done } = await admin.from("signup_checks").select("*").eq("company_id", companyId).maybeSingle();
      if (done && done.outcome !== "pending_email") return json({ status: done.outcome, flags: done.flags });
      const from = await secret("WELCOME_V2_FROM");
      if (!company || company.plan !== "trial" || (from && new Date(company.created_at) < new Date(from))) {
        // Older accounts and paying customers are not checked.
        if (!done) await admin.from("signup_checks").insert({ company_id: companyId, user_id: user.id, email: user.email, outcome: "not_checked" });
        return json({ status: "not_checked" });
      }
      const email = String(user.email ?? "");
      const { norm, domain } = normEmail(email);
      const deviceId = String(body.device_id ?? "").slice(0, 80) || null;
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
      const base = { company_id: companyId, user_id: user.id, email, email_norm: norm, email_domain: domain, device_id: deviceId, ip };
      if (!user.email_confirmed_at) {
        await admin.from("signup_checks").upsert({ ...base, outcome: "pending_email" }, { onConflict: "company_id" });
        return json({ status: "pending_email" });
      }
      const flags: string[] = [];
      if (DISPOSABLE.has(domain)) flags.push("throwaway_email");
      const { count: sameEmail } = await admin.from("signup_checks").select("company_id", { count: "exact", head: true })
        .eq("email_norm", norm).neq("company_id", companyId);
      if ((sameEmail ?? 0) > 0) flags.push("repeat_email");
      if (deviceId) {
        const since = new Date(Date.now() - 180 * 864e5).toISOString();
        const { count: sameDevice } = await admin.from("signup_checks").select("company_id", { count: "exact", head: true })
          .eq("device_id", deviceId).neq("company_id", companyId).gte("created_at", since);
        if ((sameDevice ?? 0) > 0) flags.push("repeat_device");
      }
      if (ip) {
        const since = new Date(Date.now() - 864e5).toISOString();
        const { count: sameIp } = await admin.from("signup_checks").select("company_id", { count: "exact", head: true })
          .eq("ip", ip).neq("company_id", companyId).gte("created_at", since).in("outcome", ["welcome", "welcome_work_email"]);
        if ((sameIp ?? 0) >= 3) flags.push("busy_connection");
      }
      let outcome = "welcome";
      if (flags.length) {
        outcome = "free_repeat";
        await admin.from("companies").update({ plan: "free" }).eq("id", companyId);
      } else if (domain && !PUBLIC_MAIL.has(domain)) {
        outcome = "welcome_work_email";
        const { data: c } = await admin.from("companies").select("bonus_drawing_pages").eq("id", companyId).maybeSingle();
        await admin.from("companies").update({ bonus_drawing_pages: Number(c?.bonus_drawing_pages || 0) + 1 }).eq("id", companyId);
      }
      await admin.from("signup_checks").upsert({ ...base, flags, outcome }, { onConflict: "company_id" });
      let sample: any = null;
      if (outcome !== "free_repeat") {
        const tplId = await secret("SAMPLE_PROJECT_ID");
        if (tplId) {
          try { sample = await copySample(tplId, companyId, user.id); }
          catch (e) { console.error("sample project failed:", describe(e)); sample = { error: describe(e) }; }
        }
      }
      return json({ status: outcome, flags, sample });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("welcome-guard error:", describe(err));
    return json({ error: describe(err) }, 500);
  }
});
