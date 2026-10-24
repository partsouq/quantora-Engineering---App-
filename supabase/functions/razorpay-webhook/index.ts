// ===========================================================================
// Quantora — razorpay-webhook (24 Oct 2026)
//
// Razorpay calls this with no user session, so verify_jwt must be OFF for this
// function. Authenticity comes from the X-Razorpay-Signature header: an
// HMAC-SHA256 of the raw body with the webhook secret. Anything unsigned or
// wrongly signed is refused before it is read.
//
// Each event is recorded once in billing_events (by X-Razorpay-Event-Id), so a
// Razorpay retry never applies twice. Once the signature is good we always
// answer 200, and log our own failures, so Razorpay does not retry for hours.
//
// Razorpay dashboard -> Settings -> Webhooks:
//   URL: https://<project>.supabase.co/functions/v1/razorpay-webhook
//   Events: subscription.activated, subscription.charged, subscription.pending,
//           subscription.halted, subscription.cancelled, subscription.completed,
//           subscription.updated
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { applySubscription, hmacHex, loadKeys, safeEqual } from "./razorpay.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();

  const keys = await loadKeys(admin);
  if (!keys?.webhookSecret) {
    console.error("razorpay-webhook: RAZORPAY_WEBHOOK_SECRET is not set.");
    return new Response("Not configured", { status: 503 });
  }
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(keys.webhookSecret, raw);
  if (!safeEqual(expected, signature)) {
    console.error("razorpay-webhook: bad signature.");
    return new Response("Invalid signature", { status: 401 });
  }

  try {
    const event = JSON.parse(raw);
    const eventName = String(event?.event ?? "");
    const eventId = req.headers.get("x-razorpay-event-id")
      ?? `${eventName}:${event?.payload?.subscription?.entity?.id ?? ""}:${event?.created_at ?? ""}`;

    const { error: dupErr } = await admin.from("billing_events")
      .insert({ event_id: eventId, provider: "razorpay", event: eventName, payload: event });
    if (dupErr) {
      if (String(dupErr.code) === "23505") return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
      console.error("razorpay-webhook: could not record event:", dupErr.message);
    }

    if (eventName.startsWith("subscription.")) {
      const sub = event?.payload?.subscription?.entity;
      const note = await applySubscription(admin, sub);
      console.log(`razorpay-webhook ${eventName}: ${note}`);
    }
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    console.error("razorpay-webhook handler error:", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ received: true, handled: false }), { status: 200 });
  }
});
