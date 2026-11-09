// email-unsub (2026-11-09): the Unsubscribe link in every Email Center email. Public (no sign-in).
// The link carries a signature, so nobody can unsubscribe someone else. The address is added to
// email_unsubscribes (never emailed again) and any matching lead is set to "Do not contact".
import { createClient } from "jsr:@supabase/supabase-js@2";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, SRK, { auth: { persistSession: false } });
async function token(email: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SRK), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
const page = (title: string, text: string) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#0b1240;font-family:Segoe UI,Arial,sans-serif;color:#e6eaf7;display:grid;place-items:center;min-height:100vh">
<div style="max-width:440px;padding:28px;text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#c4cdee;line-height:1.6">${text}</p>
<a href="https://quantoraengineering.com" style="color:#a5b4fc">quantoraengineering.com</a></div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const e = String(u.searchParams.get("e") || "").toLowerCase().trim(), t = String(u.searchParams.get("t") || "");
  if (!e || !t || t !== await token(e)) return page("Link not valid", "This unsubscribe link is not valid. Reply to the email with STOP and we will remove you.");
  await admin.from("email_unsubscribes").upsert({ email: e, reason: "link" }, { onConflict: "email" });
  await admin.from("email_leads").update({ status: "dnc", updated_at: new Date().toISOString() }).ilike("email", e);
  return page("You are unsubscribed", "You will not receive these emails from Quantora Engineering again.");
});
