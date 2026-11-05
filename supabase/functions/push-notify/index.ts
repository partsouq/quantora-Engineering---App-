// push-notify: real push notifications (2026-11-01).
// A push reaches the computer or phone even when the Quantora app is closed, like WhatsApp.
//
// Actions
//   public_key  (signed-in user)  -> the server's public push key, so the browser can subscribe.
//                                    The key pair is created here on first use and kept in
//                                    app_secrets; no person ever handles it.
//   test        (platform admin)  -> sends a test push to the caller's own devices.
//   send        (database only)   -> called by the q_push_alert trigger with the internal secret;
//                                    sends to every platform admin's devices.
//   send_user   (database only)   -> same secret; sends to the named customer's own devices.
// Dead subscriptions (device uninstalled, permission removed) are deleted automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-push-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function secret(key: string): Promise<string> {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return String(data?.value || "");
}

async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  let pub = await secret("VAPID_PUBLIC_KEY"), priv = await secret("VAPID_PRIVATE_KEY");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    // insert only if still missing, so two first calls at once cannot end with different keys
    await admin.from("app_secrets").upsert([{ key: "VAPID_PUBLIC_KEY", value: k.publicKey }, { key: "VAPID_PRIVATE_KEY", value: k.privateKey }], { onConflict: "key", ignoreDuplicates: true });
    pub = await secret("VAPID_PUBLIC_KEY"); priv = await secret("VAPID_PRIVATE_KEY");
  }
  return { publicKey: pub, privateKey: priv };
}

async function pushTo(userIds: string[], payload: Record<string, unknown>) {
  if (!userIds.length) return { sent: 0, failed: 0, removed: 0, devices: 0 };
  const { publicKey, privateKey } = await vapid();
  webpush.setVapidDetails("https://quantoraengineering.com", publicKey, privateKey);
  const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", userIds);
  let sent = 0, failed = 0, removed = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++; await admin.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) { removed++; await admin.from("push_subscriptions").delete().eq("id", s.id); }
      else console.warn("push failed", e?.statusCode, String(e?.body || e?.message || e).slice(0, 200));
    }
  }));
  return { sent, failed, removed, devices: (subs || []).length };
}

async function adminIds(): Promise<string[]> {
  const { data } = await admin.from("platform_admins").select("user_id");
  return (data || []).map((r: any) => r.user_id).filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "send") {
      const want = await secret("PUSH_INTERNAL_SECRET");
      if (!want || req.headers.get("x-push-secret") !== want) return json({ error: "Unauthorized" }, 401);
      const payload = { title: String(body.title || "Quantora"), body: String(body.body || "").slice(0, 300), tag: String(body.tag || "q-push"), url: String(body.url || "/") };
      return json({ ok: true, ...(await pushTo(await adminIds(), payload)) });
    }

    // a customer's own devices (2026-11-05): "BOQ ready", "Quantora Team replied", "We fixed your run".
    // Only the database calls this, with the internal secret; it names the user the alert belongs to.
    if (action === "send_user") {
      const want = await secret("PUSH_INTERNAL_SECRET");
      if (!want || req.headers.get("x-push-secret") !== want) return json({ error: "Unauthorized" }, 401);
      const ids = (Array.isArray(body.user_ids) ? body.user_ids : []).map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
      const payload = { title: String(body.title || "Quantora").slice(0, 80), body: String(body.body || "").slice(0, 160), tag: String(body.tag || "q-user"), url: String(body.url || "/") };
      return json({ ok: true, ...(await pushTo(ids, payload)) });
    }

    // everything else needs a signed-in user
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = token ? await admin.auth.getUser(token) : { data: null as any };
    const user = u?.user;
    if (!user) return json({ error: "Unauthorized" }, 401);

    if (action === "public_key") return json({ ok: true, public_key: (await vapid()).publicKey });

    if (action === "test") {
      const ids = await adminIds();
      if (!ids.includes(user.id)) return json({ error: "Admins only" }, 403);
      const r = await pushTo([user.id], { title: "Quantora chat alerts are on", body: "You will get a notification like this when a customer writes in Live Chat.", tag: "q-push-test", url: "/" });
      return json({ ok: true, ...r });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("push-notify", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
