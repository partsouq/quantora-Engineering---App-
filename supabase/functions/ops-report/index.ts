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

  const signupWatch = await watchSignups().catch((e) => { console.error("signup watch", e); return { stuck: 0, reminded: 0 }; });

  const r = s.runs || {}, j = s.drawings || {}, c = s.chats || {}, rt = s.ratings || {}, u = s.users || {};
  const lines = [
    `Users: ${u.signups || 0} new · ${u.logins || 0} signed in`,
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
  const period = `${hhmm(from)}–${hhmm(to)}`;
  const { data: row, error: insErr } = await admin.from("admin_reports").insert({
    period_start: from.toISOString(), period_end: to.toISOString(), manual,
    data: { ...s, health }, summary: lines.join("\n"), alerts_count: s.alerts_new || 0,
  }).select("id").single();
  if (insErr) throw new Error("save: " + insErr.message);

  // one push for the report; its own tag so it never replaces or mixes with an alert
  const push = await secret("PUSH_INTERNAL_SECRET");
  if (push) {
    const short = [`${u.signups || 0} new users · ${u.logins || 0} signed in`, ...(signupWatch.stuck ? [`${signupWatch.stuck} waiting for email confirmation ⚠️`] : []), `${r.completed || 0} take-offs · ${r.failed || 0} failed`,
      `${c.new_chats || 0} chats · ${c.waiting || 0} waiting`, `${s.user_errors || 0} user errors`, ...(s.uploads_not_saved ? [`${s.uploads_not_saved} uploads not saved ❌`] : []), `Engines ${health.length - down.length}/${health.length}` + (down.length ? " ❌" : " ✅")].join(" · ");
    await fetch(`${URL_BASE}/functions/v1/push-notify`, { method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON, "x-push-secret": push },
      body: JSON.stringify({ action: "send", title: `📊 Hourly report · ${period}`, body: short, tag: "q-report", url: "/" }) }).catch(() => {});
  }
  return { id: row?.id, period, summary: lines, down: down.map(d => d.fn) };
}

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
    }
    return json({ ok: true, ...(await runReport(!viaCron)) });
  } catch (e) {
    console.error("ops-report", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
