// ===========================================================================
// Quantora — dodo-webhook (2026-10-31). Replaces razorpay-webhook.
//
// Dodo calls this with no user session, so verify_jwt must be OFF for this
// function. Authenticity comes from the Standard Webhooks headers
// (webhook-id, webhook-timestamp, webhook-signature): an HMAC-SHA256 of
// "id.timestamp.body" with the endpoint's signing secret (DODO_WEBHOOK_SECRET
// in app_secrets). Anything unsigned, wrongly signed or older than 5 minutes is
// refused before it is read.
//
// Each event is recorded once in billing_events (by webhook-id), so a Dodo
// retry never applies twice. Once the signature is good we always answer 200
// and log our own failures, so Dodo does not retry for hours.
//
// Dodo dashboard -> Developer -> Webhooks -> Add endpoint:
//   URL: https://<project>.supabase.co/functions/v1/dodo-webhook
//   Events: all subscription.* and payment.* events
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { applySubscription, dodo, loadKeys, verifyWebhook } from "./dodo.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();

  const keys = await loadKeys(admin);
  if (!keys?.webhookSecret) {
    console.error("dodo-webhook: DODO_API_KEY / DODO_WEBHOOK_SECRET not set.");
    return new Response("Not configured", { status: 503 });
  }
  if (!(await verifyWebhook(keys.webhookSecret, req.headers, raw))) {
    console.error("dodo-webhook: bad signature.");
    return new Response("Invalid signature", { status: 401 });
  }

  try {
    const event = JSON.parse(raw);
    const type = String(event?.type ?? "");
    const eventId = req.headers.get("webhook-id") ?? `${type}:${event?.data?.subscription_id ?? event?.data?.payment_id ?? ""}:${event?.timestamp ?? ""}`;

    const { error: dupErr } = await admin.from("billing_events")
      .insert({ event_id: eventId, provider: "dodo", event: type, payload: event });
    if (dupErr) {
      if (String(dupErr.code) === "23505") return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
      console.error("dodo-webhook: could not record event:", dupErr.message);
    }

    if (type.startsWith("subscription.")) {
      const note = await applySubscription(admin, event.data);
      console.log(`dodo-webhook ${type}: ${note}`);
    } else if (type === "payment.succeeded" && event?.data?.subscription_id) {
      // A renewal or first payment: re-read the subscription so paid_until moves on.
      const sub = await dodo(keys, `/subscriptions/${event.data.subscription_id}`).catch(() => null);
      if (sub) console.log(`dodo-webhook ${type}: ${await applySubscription(admin, sub)}`);
    }
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    console.error("dodo-webhook handler error:", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ received: true, handled: false }), { status: 200 });
  }
});
