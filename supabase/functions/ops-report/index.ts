// ops-report (2026-11-02): the hourly report agent for platform admins.
//
// Every hour (pg_cron, :00) it:
//   1. reads what happened in the last hour (q_ops_stats: sign-ups, logins, take-offs, drawings, pages,
//      live chats, ratings, payments, alerts),
//   2. checks that every server engine answers,
//   3. saves the report in admin_reports (Admin -> Hourly Reports) and sends ONE push notification
//      "Hourly report" to the admins' devices (tag q-report: each new report replaces the last one).
// Problems it finds (an engine not answering, a run stuck for 30+ minutes) are written to admin_alerts.
// Alerts are pushed separately and instantly by the q_alert_push trigger (title "Alert", own tag per alert),
// so a report and an alert never share a notification. The report only shows how many alerts there were.
//
// Callers: the cron job (x-push-secret = PUSH_INTERNAL_SECRET) or a platform admin ("Run report now").

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-push-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const ENGINES = ["ai-engine", "billing", "admin-analytics", "admin-plan", "design-engine", "tender-engine",
  "procurement-engine", "dodo-billing", "welcome-guard", "push-notify"];

async function secret(key: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return String(data?.value || "");
}

// An engine is "up" when it answers at all (401 for an unsigned ping is the healthy answer).
async function ping(fn: string) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(`${URL_BASE}/functions/v1/${fn}`, { method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON }, body: JSON.stringify({ action: "ping" }) });
    clearTimeout(to); await r.text().catch(() => "");
    return { fn, up: r.status < 500, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { fn, up: false, status: 0, ms: Date.now() - t0, error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

async function raiseAlert(fp: string, service: string, title: string, text: string) {
  const { data: ex } = await admin.from("admin_alerts").select("id, occurrences, status").eq("fingerprint", fp).maybeSingle();
  if (ex) {
    await admin.from("admin_alerts").update({ occurrences: ex.occurrences + 1, last_seen: new Date().toISOString(),
      status: ex.status === "fixed" ? "open" : ex.status, updated_at: new Date().toISOString() }).eq("id", ex.id);
  } else {
    await admin.from("admin_alerts").insert({ fingerprint: fp, service, title, error_text: text.slice(0, 4000), examples: [] });
  }
}

// Sign-up watch (2026-11-07): someone who signed up 30+ minutes ago and has not clicked the confirmation link
// raises one admin alert (pushed instantly by q_alert_push; the admin can press "Resend confirmation" in
// Customers -> Waiting for email confirmation). After 1 hour they get ONE automatic reminder: a fresh
// confirmation link (the platform's own confirmation email). At most 2 reminders per hourly run, so the
// project's email allowance stays free for new sign-ups. The robot's own test sign-ups are never counted.
async function watchSignups() {
  const { data, error } = await admin.rpc("q_pending_signups_ops");
  if (error) throw error;
  const list = (data || []) as any[];
  let stuck = 0, reminded = 0;
  for (const p of list) {
    if (p.minutes < 30) continue;
    stuck++;
    const who = `${p.full_name || "New user"} (${p.email})`;
    await raiseAlertOnce(`signup:unconfirmed:${p.id}`, "signup", `Sign-up not confirmed yet: ${p.full_name || p.email}`,
      `${who} signed up ${p.minutes} minutes ago and has not clicked the confirmation link. ` +
      `Admin -> Customers -> Waiting for email confirmation -> Resend confirmation.`);
    if (p.minutes >= 60 && !p.reminded_at && p.minutes < 3 * 24 * 60 && reminded < 2) {
      const r = await fetch(`${URL_BASE}/auth/v1/resend`, { method: "POST",
        headers: { "content-type": "application/json", apikey: ANON },
        body: JSON.stringify({ type: "signup", email: p.email, options: { email_redirect_to: "https://quantoraengineering.com/" } }) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) } as any));
      const txt = r.ok ? "sent" : `failed ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`;
      await admin.from("signup_reminders").upsert({ user_id: p.id, sent_at: new Date().toISOString(), result: txt });
      if (r.ok) reminded++;
    }
  }
  return { stuck, reminded };
}

// like raiseAlert, but a sign-up alert is raised once per person (no repeat every hour)
async function raiseAlertOnce(fp: string, service: string, title: string, text: string) {
  const { data: ex } = await admin.from("admin_alerts").select("id").eq("fingerprint", fp).maybeSingle();
  if (!ex) await admin.from("admin_alerts").insert({ fingerprint: fp, service, title, error_text: text.slice(0, 4000), examples: [] });
}

// Daily connection check (2026-11-17, owner approved, free): once a day every outside service the
// platform needs is tested without doing any paid work. A broken key or login raises an alert (pushed at
// once by q_alert_push) before a customer runs into it, and a working one clears its old alert.
//   GitHub  - the DWG converter key can still start the converter (repo read with that key; warns 14 days
//             before the key expires)
//   AI      - the AI key is accepted (list models: no AI credits used)
//   Zoho    - info@ can still sign in to send mail (sign-in only, nothing is sent)
//   Payments- the Dodo key is accepted (read one product)
//   Storage - the drawings store answers
async function connChecks() {
  const out: Record<string, string> = {};
  const fail = async (key: string, title: string, why: string) => {
    out[key] = "FAIL: " + why;
    await raiseAlert(`conn:${key}`, "connections", title, why);
  };
  const pass = async (key: string, note = "ok") => {
    out[key] = note;
    await admin.from("admin_alerts").update({ status: "fixed", updated_at: new Date().toISOString() })
      .eq("fingerprint", `conn:${key}`).in("status", ["open", "investigating"]);
  };
  const timed = (u: string, init: RequestInit = {}) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    return fetch(u, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
  };
  // GitHub (DWG converter)
  try {
    const tok = await secret("GITHUB_ROBOT_TOKEN");
    if (!/^(github_pat_|ghp_)/.test(tok)) await fail("github", "DWG converter key missing", "GITHUB_ROBOT_TOKEN is not set, so DWG uploads cannot start converting. Add a GitHub token (Actions: read and write on the app repo).");
    else {
      const r = await timed("https://api.github.com/repos/partsouq/quantora-Engineering---App-/actions/workflows/dwg-convert.yml",
        { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "quantora-health" } });
      await r.text().catch(() => "");
      const exp = r.headers.get("github-authentication-token-expiration");
      const days = exp ? (new Date(exp.replace(" UTC", "Z").replace(" ", "T")).getTime() - Date.now()) / 86400e3 : 999;
      if (r.status !== 200) await fail("github", "DWG converter key not working", `GitHub answered ${r.status} for the DWG converter key. DWG uploads will wait. Make a new token and update GITHUB_ROBOT_TOKEN.`);
      else if (days < 14) await fail("github", "DWG converter key expires soon", `The GitHub key for DWG conversion expires in ${Math.max(0, Math.floor(days))} day(s). Make a new one and update GITHUB_ROBOT_TOKEN.`);
      else await pass("github", `ok (key valid ${Math.floor(days)} more days)`);
    }
  } catch (e) { await fail("github", "DWG converter check failed", String((e as Error)?.message || e).slice(0, 200)); }
  // AI service (free: list models)
  try {
    const key = await secret("ANTHROPIC_API_KEY");
    if (!key) await fail("ai", "AI key missing", "ANTHROPIC_API_KEY is not set, so take-offs cannot run.");
    else {
      const r = await timed("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      const t = await r.text().catch(() => "");
      if (r.status === 200) await pass("ai"); else await fail("ai", "AI key not accepted", `The AI service answered ${r.status}: ${t.slice(0, 160)}. Take-offs will fail until the key is fixed (or the account is topped up).`);
    }
  } catch (e) { await fail("ai", "AI check failed", String((e as Error)?.message || e).slice(0, 200)); }
  // Zoho (sign-in only, through email-center)
  try {
    const sec = await secret("EMAIL_QUEUE_SECRET");
    const r = await timed(`${URL_BASE}/functions/v1/email-center`, { method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON, "x-cron-secret": sec }, body: JSON.stringify({ action: "zoho_check" }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) await pass("zoho"); else await fail("zoho", "info@ email cannot send", String(j.error || `email-center answered ${r.status}`).slice(0, 300));
  } catch (e) { await fail("zoho", "Email check failed", String((e as Error)?.message || e).slice(0, 200)); }
  // Payments (read one product)
  try {
    const { data } = await admin.from("app_secrets").select("key, value").in("key", ["DODO_API_KEY", "DODO_MODE"]);
    const m = new Map((data || []).map((x: any) => [x.key, String(x.value || "").trim()]));
    const k = m.get("DODO_API_KEY") || "";
    if (!k) await fail("payments", "Payment key missing", "DODO_API_KEY is not set, so nobody can subscribe.");
    else {
      const base = (m.get("DODO_MODE") || "").toLowerCase() === "test" || k.startsWith("dodo_test") ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
      const r = await timed(`${base}/products?page_size=1`, { headers: { Authorization: `Bearer ${k}` } });
      await r.text().catch(() => "");
      if (r.status === 200) await pass("payments"); else await fail("payments", "Payment key not accepted", `Dodo answered ${r.status}. Customers cannot pay until the key is fixed.`);
    }
  } catch (e) { await fail("payments", "Payment check failed", String((e as Error)?.message || e).slice(0, 200)); }
  // Storage
  try {
    const { error } = await admin.storage.from("drawings").list("", { limit: 1 });
    if (error) await fail("storage", "Drawing storage not answering", error.message); else await pass("storage");
  } catch (e) { await fail("storage", "Storage check failed", String((e as Error)?.message || e).slice(0, 200)); }
  return out;
}

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" });

async function runReport(manual: boolean) {
  const now = new Date();
  // the cron run covers the hour that just ended; a manual run covers the last 60 minutes
  const to = manual ? now : new Date(Math.floor(now.getTime() / 3600e3) * 3600e3);
  const from = new Date(to.getTime() - 3600e3);
  const { data: stats, error } = await admin.rpc("q_ops_stats", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw new Error("stats: " + error.message);
  const s = (stats || {}) as Record<string, any>;
  const health = await Promise.all(ENGINES.map(ping));
  const down = health.filter(h => !h.up);

  // problems -> alerts (pushed separately by the q_alert_push trigger)
  for (const d of down) await raiseAlert(`ops:down:${d.fn}`, d.fn, `Engine not answering: ${d.fn}`, `Hourly check got ${d.status || "no answer"}${d.error ? " (" + d.error + ")" : ""}.`);
  if ((s.stuck_runs || 0) > 0) await raiseAlert("ops:stuck-runs", "ai-engine", `${s.stuck_runs} take-off run(s) stuck for 30+ minutes`, "Runs still processing after 30 minutes at the hourly check.");
  if ((s.stuck_jobs || 0) > 0) await raiseAlert("ops:stuck-jobs", "draftsman", `${s.stuck_jobs} Draftsman job(s) stuck for 60+ minutes`, "Draftsman jobs still queued or running after 60 minutes at the hourly check.");

  // website visitors (2026-11-09): last hour + today (Dubai day)
  const dayStart = new Date(Math.floor((to.getTime() + 4 * 3600e3) / 86400e3) * 86400e3 - 4 * 3600e3);
  const [{ data: vh }, { data: vd }] = await Promise.all([
    admin.rpc("q_site_visit_stats", { p_from: from.toISOString(), p_to: to.toISOString() }),
    admin.rpc("q_site_visit_stats", { p_from: dayStart.toISOString(), p_to: to.toISOString() })]);
  const srcTxt = ((vd?.sources || []) as any[]).map((x) => `${x.s} ${x.n}`).join(", ");
  const visitLine = `Website: ${vh?.visitors ?? 0} visitor${vh?.visitors === 1 ? "" : "s"} this hour · ${vd?.visitors ?? 0} today${srcTxt ? ` (${srcTxt})` : ""}`;

  // once a day, at the 05:00 UTC run (09:00 Dubai), or when an admin runs the report by hand
  const conn = (manual || to.getUTCHours() === 5) ? await connChecks().catch((e) => ({ error: String(e) })) : null;
  const signupWatch = await watchSignups().catch((e) => { console.error("signup watch", e); return { stuck: 0, reminded: 0 }; });

  const r = s.runs || {}, j = s.drawings || {}, c = s.chats || {}, rt = s.ratings || {}, u = s.users || {};
  const lines = [
    `Users: ${u.signups || 0} new · ${u.logins || 0} signed in`,
    visitLine,
    `Waiting for email confirmation: ${signupWatch.stuck}${signupWatch.stuck ? " ⚠️" : ""}${signupWatch.reminded ? ` · ${signupWatch.reminded} reminder${signupWatch.reminded === 1 ? "" : "s"} sent` : ""}`,
    `Take-offs: ${r.completed || 0} done · ${r.failed || 0} failed · ${r.empty || 0} empty · ${s.pages || 0} pages`,
    `Drawings (Draftsman): ${j.done || 0} done · ${j.failed || 0} failed`,
    `Live chat: ${c.new_chats || 0} new · ${c.customer_messages || 0} messages · ${c.waiting || 0} waiting for a reply`,
    `Ratings: ${rt.count || 0}${rt.count ? ` (avg ${rt.avg})` : ""} · Payments: ${s.payments || 0}`,
    `Engines: ${health.length - down.length}/${health.length} answering${down.length ? " ❌ " + down.map(d => d.fn).join(", ") : " ✅"}`,
    `Errors users hit: ${s.user_errors || 0}${s.user_errors ? ` (${s.user_errors_users} user${s.user_errors_users === 1 ? "" : "s"})` : ""}`,
    `Drawing uploads not saved: ${s.uploads_not_saved || 0}${s.uploads_not_saved ? " ❌" : ""}`,
    `Alerts this hour: ${s.alerts_new || 0} (open: ${s.alerts_open || 0})`,
  ];
  if (conn) lines.push(`Connections: ${Object.entries(conn).map(([k, v]) => `${k} ${String(v).startsWith("FAIL") ? "❌" : "✅"}`).join(" · ")}`);
  const period = `${hhmm(from)}–${hhmm(to)}`;
  const { data: row, error: insErr } = await admin.from("admin_reports").insert({
    period_start: from.toISOString(), period_end: to.toISOString(), manual,
    data: { ...s, health, conn }, summary: lines.join("\n"), alerts_count: s.alerts_new || 0,
  }).select("id").single();
  if (insErr) throw new Error("save: " + insErr.message);

  // one push for the report; its own tag so it never replaces or mixes with an alert
  const push = await secret("PUSH_INTERNAL_SECRET");
  if (push) {
    const short = [`${vd?.visitors ?? 0} website visitors today`, `${u.signups || 0} new users · ${u.logins || 0} signed in`, ...(signupWatch.stuck ? [`${signupWatch.stuck} waiting for email confirmation ⚠️`] : []), `${r.completed || 0} take-offs · ${r.failed || 0} failed`,
      `${c.new_chats || 0} chats · ${c.waiting || 0} waiting`, `${s.user_errors || 0} user errors`, ...(s.uploads_not_saved ? [`${s.uploads_not_saved} uploads not saved ❌`] : []), `Engines ${health.length - down.length}/${health.length}` + (down.length ? " ❌" : " ✅")].join(" · ");
    await fetch(`${URL_BASE}/functions/v1/push-notify`, { method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON, "x-push-secret": push },
      body: JSON.stringify({ action: "send", title: `📊 Hourly report · ${period}`, body: short, tag: "q-report", url: "/" }) }).catch(() => {});
  }
  return { id: row?.id, period, summary: lines, down: down.map(d => d.fn) };
}

// Admin sign-in code (16 Nov 2026): admin powers need this sign-in session confirmed with the
// 6-digit code emailed to the admin (public.q_admin_session_ok). The session id is read from the
// caller's token, which auth.getUser has already checked.
async function qAdminVerified(db: any, authHeader: string, uid: string): Promise<boolean> {
  try {
    const part = String(authHeader || "").replace(/^Bearer\s+/i, "").split(".")[1] || "";
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    const { data, error } = await db.rpc("q_admin_session_ok", { p_uid: uid, p_sid: claims.session_id || null });
    return !error && data === true;
  } catch (_) { return false; }
}
const ADMIN_OTP_NEEDED = { error: "Admin sign-in code needed. Open Admin to get your code by email.", otp_required: true };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (String(body.action || "") !== "hourly") return json({ error: "Unknown action" }, 400);
    const want = await secret("PUSH_INTERNAL_SECRET");
    const viaCron = !!want && req.headers.get("x-push-secret") === want;
    if (!viaCron) {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = token ? await admin.auth.getUser(token) : { data: null as any };
      if (!u?.user) return json({ error: "Unauthorized" }, 401);
      const { data: pa } = await admin.from("platform_admins").select("user_id").eq("user_id", u.user.id).maybeSingle();
      if (!pa) return json({ error: "Admins only" }, 403);
      if (!(await qAdminVerified(admin, token, u.user.id))) return json(ADMIN_OTP_NEEDED, 401);
    }
    return json({ ok: true, ...(await runReport(!viaCron)) });
  } catch (e) {
    console.error("ops-report", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
