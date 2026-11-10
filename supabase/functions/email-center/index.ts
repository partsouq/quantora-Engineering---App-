// email-center (2026-11-09, approved by the owner). Sends the Email Center's emails.
//   Customers (welcome series, customer updates) go through Resend (secret RESEND_API_KEY).
//   Leads go through the info@ Zoho mailbox by SMTP (secrets ZOHO_SMTP_USER, ZOHO_SMTP_PASS,
//   optional ZOHO_SMTP_HOST, default smtp.zoho.com, port 465).
// Every email has a banner, one button, contact info@quantoraengineering.com (reply-to) and an
// unsubscribe link. Nothing is ever sent twice: each send is logged in email_sends, and people who
// unsubscribed are skipped. Daily caps: 70 customer emails (Resend free plan is 100/day and also
// carries sign-up emails) and 50 lead emails.
//
// Actions (signed-in Admin with the "email" section at "act"):
//   status                      -> which senders are connected, and what was sent today
//   send_welcome  {user_ids}    -> the next welcome email for each of them
//   updates_list  {campaign_id} -> customers who have not had that update yet
//   send_update   {campaign_id, user_ids}
//   send_leads    {lead_ids}    -> the next lead email (intro, follow-up 1, follow-up 2, later news)
//   preview       {kind, ...}   -> the HTML of an email, for the Preview button

import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.14";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const URL_ = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, SRK, { auth: { persistSession: false } });
const SITE = "https://quantoraengineering.com";
const CONTACT = "info@quantoraengineering.com";
const CAP_CUSTOMERS = 70, CAP_LEADS = 50;
const WELCOME_DAYS = [2, 4, 7, 10, 15, 30, 60, 90, 180];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function unsubToken(email: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SRK), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function unsubUrl(email: string) {
  return `${URL_}/functions/v1/email-unsub?e=${encodeURIComponent(email.toLowerCase())}&t=${await unsubToken(email)}`;
}

// One email layout: banner picture, headline, paragraphs, optional highlighted box, one button, footer.
function layout(o: { banner?: string; kicker?: string; headline: string; hello: string; paras: string[]; box?: { title: string; text: string };
  button?: string; url?: string; unsub: string; manual?: boolean }) {
  const banner = o.banner || `${SITE}/ws-art/email-banner.jpg`;
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1e293b">${t}</p>`;
  return `<!doctype html><html><body style="margin:0;background:#eef1f7;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f7;padding:24px 10px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td><img src="${banner}" width="600" alt="Quantora Engineering" style="display:block;width:100%;height:auto;border:0"></td></tr>
<tr><td style="padding:26px 30px 8px">
${o.kicker ? `<div style="font-size:12px;font-weight:800;letter-spacing:.08em;color:#6366f1;margin-bottom:6px">${esc(o.kicker)}</div>` : ""}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#0f172a">${esc(o.headline)}</h1>
${p(esc(o.hello))}
${o.paras.map(x => p(x)).join("")}
${o.box ? `<table role="presentation" width="100%" style="background:#f1f3ff;border-radius:10px;margin:4px 0 18px"><tr><td style="padding:14px 16px"><b style="color:#312e81">${esc(o.box.title)}</b><div style="font-size:14px;color:#334155;margin-top:4px;line-height:1.55">${o.box.text}</div></td></tr></table>` : ""}
${o.button ? `<table role="presentation" style="margin:6px 0 22px"><tr><td style="background:#4f46e5;border-radius:10px"><a href="${o.url || SITE}" style="display:inline-block;padding:13px 24px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none">${esc(o.button)} &rarr;</a></td></tr></table>` : ""}
${o.manual === false ? "" : `<table role="presentation" width="100%" style="border-top:1px solid #e2e8f0;margin-top:4px"><tr><td style="padding:16px 0 4px"><b style="color:#0f172a">New: Manual Take-off</b><div style="font-size:14px;color:#334155;margin-top:4px;line-height:1.55">Mark the items on the drawing yourself and get a Designed BOQ. 10 drawings free every month, then 30 drawings for $10.</div></td></tr></table>`}
<p style="margin:14px 0 22px;font-size:14px;color:#334155">Questions or need more details? Write to our team at <a href="mailto:${CONTACT}" style="color:#4f46e5">${CONTACT}</a> — just reply to this email.</p>
</td></tr>
<tr><td style="padding:16px 30px 22px;background:#f8fafc;font-size:12px;color:#64748b;line-height:1.6">
Quantora Engineering · AI take-off, BOQ and shop drawings for MEP, ELV and electrical · UAE, GCC and worldwide<br>
<a href="${SITE}" style="color:#64748b">quantoraengineering.com</a> · <a href="${o.unsub}" style="color:#64748b">Unsubscribe</a>
</td></tr></table></td></tr></table></body></html>`;
}

// ----- welcome series -----
const NEXT_STEP: Record<string, { title: string; text: string }> = {
  no_project: { title: "Your next step: create a project", text: "Add the project name, location and type. Your drawings, BOQ and reports are all kept inside it — it takes about a minute." },
  no_drawing: { title: "Your next step: upload a drawing", text: "Open your project and upload a PDF, DWG or image of an MEP, ELV or electrical drawing." },
  no_boq: { title: "Your next step: get your take-off and BOQ", text: "Open the drawing and run AI Take-off, or mark the items yourself with Manual Take-off." },
  boq_done: { title: "Your next step: check and export", text: "Check your design against the local authority rules with Compliance, and export your BOQ to Excel or PDF." },
};
const WELCOME = [
  { subject: "Your free Welcome Pack is ready", kicker: "WELCOME TO QUANTORA", headline: "Your free Welcome Pack is ready", paras: ["Thank you for joining Quantora Engineering. Your Welcome Pack lets you try AI Take-off, Manual Take-off and the designed BOQ on your own drawings."], button: "Open Quantora" },
  { subject: "Your first BOQ in 3 steps", kicker: "GETTING STARTED", headline: "Your first BOQ in 3 steps", paras: ["1. Create a project &nbsp;·&nbsp; 2. Upload a drawing &nbsp;·&nbsp; 3. Get your take-off and BOQ.", "Quantora reads MEP, ELV and electrical drawings and lists the quantities for you to check."], button: "Start now" },
  { subject: "Manual Take-off: 10 drawings free every month", kicker: "MANUAL TAKE-OFF", headline: "Prefer to mark the drawing yourself?", paras: ["With Manual Take-off you click the items on the drawing and Quantora turns your marks into a Designed BOQ — quantities, cable and containment included."], button: "Try Manual Take-off" },
  { subject: "Check your design against local rules", kicker: "COMPLIANCE", headline: "549 authority rules, built in", paras: ["Quantora checks your design against authority rules for the UAE, Saudi Arabia, Qatar, Kuwait, Oman, Bahrain and other countries, and shows what needs attention."], button: "Open Compliance" },
  { subject: "From drawings to shop drawings", kicker: "AI DRAFTSMAN", headline: "From drawings to shop drawings", paras: ["After the BOQ, the AI Draftsman can prepare shop drawings and schematics for ELV and MEP systems, ready for you to review."], button: "See the Draftsman" },
  { subject: "What's new on Quantora", kicker: "QUANTORA UPDATE", headline: "What's new on Quantora", paras: ["New this month: a clearer drawing status while the AI works, project photos, and faster take-off for large drawing sets."], button: "Open Quantora" },
  { subject: "Quantora update", kicker: "QUANTORA UPDATE", headline: "Quantora keeps getting better", paras: ["We keep adding rules, systems and export formats. Open Quantora to see the latest."], button: "Open Quantora" },
  { subject: "Quantora update", kicker: "QUANTORA UPDATE", headline: "Ready for your next project?", paras: ["Upload the drawings of your next tender and get the take-off and BOQ in minutes."], button: "Open Quantora" },
  { subject: "Quantora update", kicker: "QUANTORA UPDATE", headline: "Six months of Quantora", paras: ["Thank you for being with us. Here is everything you can do today: AI and Manual Take-off, designed BOQ, compliance and shop drawings."], button: "Open Quantora" },
];
async function welcomeEmail(stage: number, progress: string, name: string, email: string) {
  const w = WELCOME[Math.min(stage, WELCOME.length - 1)];
  const html = layout({ kicker: w.kicker, headline: w.headline, hello: `Hello ${name || "there"},`, paras: w.paras,
    box: NEXT_STEP[progress] || NEXT_STEP.no_project, button: w.button, url: SITE, unsub: await unsubUrl(email) });
  return { subject: w.subject, html };
}

// ----- leads -----
// One numbered service box inside an email (used by the first lead email).
const svc = (n: number, t: string, d: string) => `<table role="presentation" width="100%" style="margin:0 0 12px;border-left:4px solid #4f46e5;background:#f6f7ff;border-radius:8px"><tr><td style="padding:12px 14px"><b style="color:#0f172a;font-size:15px">${n}. ${t}</b><div style="font-size:14px;color:#334155;margin-top:4px;line-height:1.55">${d}</div></td></tr></table>`;
const LEADS: { subject: string; headline: string; paras: string[]; button: string; manual?: boolean }[] = [
  { subject: "AI take-off, BOQ and shop drawings for {company}", headline: "From drawings to BOQ and shop drawings, on one platform", manual: false, paras: ["Quantora Engineering gives your team three services on one platform:",
      svc(1, "AI Take-off &amp; BOQ", "Upload MEP, ELV or electrical drawings (PDF or DWG). AI counts and measures every device, cable, duct and pipe, and every BOQ line is marked on the drawing. Export to Excel or PDF.") +
      svc(2, "AI Draftsman: shop drawings and 3D", "Upload the architectural plans and choose the systems. AI Draftsman prepares the shop drawings and schematics to your country&#39;s authority rules, plus a full 3D model you can download as IFC for Revit and Navisworks.") +
      svc(3, "Manual Take-off (new)", "Your team marks the items on the drawing, and Quantora gives you a complete Designed BOQ. 10 drawings free every month, then 30 drawings for $10."),
      "Every BOQ is also checked against your project specification and the local authority rules in the UAE and the GCC."], button: "Try it free" },
  { subject: "Quick follow-up: take-off and BOQ for your tenders", headline: "Spend less time on take-off", paras: ["A quick follow-up on my last email. Teams use Quantora to price tenders faster: upload the drawings, check the quantities, export the BOQ to Excel."], button: "Start free" },
  { subject: "Free to try: 10 drawings every month", headline: "10 drawings free every month", paras: ["One last note: you can try Quantora on your own drawings at no cost. If it is not useful for your team, just reply STOP and we will not write again."], button: "Try it free" },
  { subject: "Quantora update", headline: "What's new on Quantora", paras: ["New rules, systems and export formats were added this month. Your team can try it free on your own drawings."], button: "See what's new" },
];
async function leadEmail(stage: number, company: string, email: string) {
  const l = LEADS[Math.min(stage, LEADS.length - 1)];
  const html = layout({ kicker: "QUANTORA ENGINEERING", headline: l.headline, hello: `Hello ${company} team,`, paras: l.paras,
    button: l.button, url: `${SITE}/?ref=lead`, unsub: await unsubUrl(email), manual: l.manual });
  return { subject: l.subject.replace("{company}", company), html };
}
const LEAD_NEXT_DAYS = [7, 7, 21, 30];   // after 1st, 2nd, 3rd, later emails
const LEAD_MAX = 6;

// ----- senders -----
async function viaResend(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("Resend is not connected yet (add the RESEND_API_KEY secret in Supabase).");
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Quantora Engineering <noreply@quantoraengineering.com>", to: [to], reply_to: CONTACT, subject, html,
      headers: { "List-Unsubscribe": `<${await unsubUrl(to)}>` } }) });
  if (!r.ok) throw new Error(`Resend: ${r.status} ${(await r.text()).slice(0, 160)}`);
}
let zoho: any = null;
async function viaZoho(to: string, subject: string, html: string) {
  const user = Deno.env.get("ZOHO_SMTP_USER") || CONTACT, pass = Deno.env.get("ZOHO_SMTP_PASS");
  if (!pass) throw new Error("Zoho is not connected yet (add the ZOHO_SMTP_PASS secret in Supabase).");
  zoho ||= nodemailer.createTransport({ host: Deno.env.get("ZOHO_SMTP_HOST") || "smtp.zoho.com", port: 465, secure: true, auth: { user, pass } });
  await zoho.sendMail({ from: `Quantora Engineering <${user}>`, to, replyTo: CONTACT, subject, html,
    headers: { "List-Unsubscribe": `<${await unsubUrl(to)}>` } });
}
async function sentToday(provider: string) {
  const day0 = new Date(); day0.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from("email_sends").select("id", { count: "exact", head: true }).eq("provider", provider).eq("ok", true).gte("sent_at", day0.toISOString());
  return count || 0;
}
async function unsubscribed(emails: string[]) {
  if (!emails.length) return new Set<string>();
  const { data } = await admin.from("email_unsubscribes").select("email").in("email", emails.map(e => e.toLowerCase()));
  return new Set((data || []).map((x: any) => x.email));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const { data: { user } } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!user) return json({ error: "Please sign in." }, 401);
    const { data: lvl } = await admin.rpc("q_staff_level_for", { p_user: user.id, p_section: "email" });
    if ((lvl || 0) < 1) return json({ error: "No access to the Email Center." }, 403);
    const asUser = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const b = await req.json().catch(() => ({}));
    const act = String(b.action || "");
    const mustAct = () => { if ((lvl || 0) < 2) throw new Error("You can view the Email Center but not send."); };

    if (act === "status") {
      return json({ resend: !!Deno.env.get("RESEND_API_KEY"), zoho: !!Deno.env.get("ZOHO_SMTP_PASS"),
        resend_today: await sentToday("resend"), zoho_today: await sentToday("zoho"), cap_customers: CAP_CUSTOMERS, cap_leads: CAP_LEADS });
    }

    if (act === "preview") {
      const to = "preview@example.com";
      if (b.kind === "lead") return json(await leadEmail(Number(b.stage) || 0, b.company || "Sample Company", to));
      if (b.kind === "update") {
        const { data: c } = await asUser.from("email_campaigns").select("*").eq("id", b.campaign_id).maybeSingle();
        if (!c) return json({ error: "Update not found." }, 404);
        return json({ subject: c.subject, html: layout({ banner: c.banner || undefined, kicker: "QUANTORA UPDATE", headline: c.headline || c.subject, hello: "Hello there,", paras: String(c.body || "").split(/\n\s*\n/).map(esc), button: c.button_text || undefined, url: c.button_url || SITE, unsub: await unsubUrl(to) }) });
      }
      return json(await welcomeEmail(Number(b.stage) || 0, b.progress || "no_project", b.name || "there", to));
    }

    if (act === "send_welcome") {
      mustAct();
      const ids: string[] = (b.user_ids || []).slice(0, 200);
      const { data: due, error } = await asUser.rpc("q_email_welcome_due"); if (error) throw error;
      const rows = (due || []).filter((x: any) => ids.includes(x.user_id));
      let room = CAP_CUSTOMERS - await sentToday("resend");
      const out = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] };
      for (const r of rows) {
        if (room <= 0) { out.skipped++; continue; }
        const m = await welcomeEmail(r.stage, r.progress, String(r.name || "").split(" ")[0], r.email);
        try { await viaResend(r.email, m.subject, m.html); room--; out.sent++;
          await admin.from("email_sends").insert({ list: "welcome", template: `welcome_${WELCOME_DAYS[r.stage]}d`, user_id: r.user_id, email: r.email, provider: "resend", sent_by: user.id });
        } catch (e) { out.failed++; out.errors.push(String((e as Error).message)); if (/not connected/.test(String((e as Error).message))) break; }
      }
      if (room <= 0 && out.skipped) out.errors.push(`Daily limit of ${CAP_CUSTOMERS} customer emails reached; the rest stay in the list for tomorrow.`);
      return json(out);
    }

    if (act === "updates_list" || act === "send_update") {
      const { data: c } = await asUser.from("email_campaigns").select("*").eq("id", b.campaign_id).maybeSingle();
      if (!c) return json({ error: "Update not found." }, 404);
      const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const { data: done } = await admin.from("email_sends").select("user_id").eq("list", "updates").eq("template", `update_${c.id}`).eq("ok", true);
      const got = new Set((done || []).map((x: any) => x.user_id));
      const { data: staff } = await admin.from("platform_staff").select("user_id"); const { data: adm } = await admin.from("platform_admins").select("user_id");
      const team = new Set([...(staff || []), ...(adm || [])].map((x: any) => x.user_id));
      let list = (users?.users || []).filter((u: any) => u.email_confirmed_at && u.email && !/^quantoraengineering01\+/i.test(u.email) && !team.has(u.id) && !got.has(u.id));
      const un = await unsubscribed(list.map((u: any) => u.email)); list = list.filter((u: any) => !un.has(u.email.toLowerCase()));
      if (act === "updates_list") return json({ recipients: list.map((u: any) => ({ user_id: u.id, email: u.email, name: u.user_metadata?.full_name || "", signed_up: u.created_at })) });
      mustAct();
      const ids: string[] = b.user_ids || [];
      let room = CAP_CUSTOMERS - await sentToday("resend");
      const out = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] };
      for (const u of list.filter((u: any) => ids.includes(u.id))) {
        if (room <= 0) { out.skipped++; continue; }
        const name = String(u.user_metadata?.first_name || u.user_metadata?.full_name || "there").split(" ")[0];
        const html = layout({ banner: c.banner || undefined, kicker: "QUANTORA UPDATE", headline: c.headline || c.subject, hello: `Hello ${name},`, paras: String(c.body || "").split(/\n\s*\n/).map(esc), button: c.button_text || undefined, url: c.button_url || SITE, unsub: await unsubUrl(u.email) });
        try { await viaResend(u.email, c.subject, html); room--; out.sent++;
          await admin.from("email_sends").insert({ list: "updates", template: `update_${c.id}`, user_id: u.id, email: u.email, provider: "resend", sent_by: user.id });
        } catch (e) { out.failed++; out.errors.push(String((e as Error).message)); if (/not connected/.test(String((e as Error).message))) break; }
      }
      if (out.skipped) out.errors.push(`Daily limit of ${CAP_CUSTOMERS} customer emails reached; the rest stay in the list for tomorrow.`);
      return json(out);
    }

    if (act === "send_leads") {
      mustAct();
      const ids: string[] = (b.lead_ids || []).slice(0, 200);
      const { data: leads } = await admin.from("email_leads").select("*").in("id", ids);
      const un = await unsubscribed((leads || []).map((l: any) => l.email || "").filter(Boolean));
      let room = CAP_LEADS - await sentToday("zoho");
      const out = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] };
      for (const l of (leads || [])) {
        if (!l.email || l.status === "dnc" || un.has(String(l.email).toLowerCase()) || l.stage >= LEAD_MAX) { out.skipped++; continue; }
        if (room <= 0) { out.skipped++; continue; }
        const m = await leadEmail(l.stage, l.company, l.email);
        try { await viaZoho(l.email, m.subject, m.html); room--; out.sent++;
          const next = new Date(Date.now() + LEAD_NEXT_DAYS[Math.min(l.stage, LEAD_NEXT_DAYS.length - 1)] * 864e5);
          await admin.from("email_leads").update({ stage: l.stage + 1, status: l.status === "new" ? "contacted" : l.status, last_sent_at: new Date().toISOString(),
            next_due_at: l.stage + 1 >= LEAD_MAX ? "2999-01-01T00:00:00Z" : next.toISOString(), updated_at: new Date().toISOString() }).eq("id", l.id);
          await admin.from("email_sends").insert({ list: "leads", template: `lead_${l.stage}`, lead_id: l.id, email: l.email, provider: "zoho", sent_by: user.id });
        } catch (e) { out.failed++; out.errors.push(String((e as Error).message)); if (/not connected|auth|Invalid login/i.test(String((e as Error).message))) break; }
      }
      if (room <= 0 && out.skipped) out.errors.push(`Daily limit of ${CAP_LEADS} lead emails reached; the rest stay in the list for tomorrow.`);
      return json(out);
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
