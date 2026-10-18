// Paddle (merchant of record) webhook receiver.
//
// Paddle calls this directly -- there is no Supabase user session and no JWT,
// so verify_jwt MUST stay false for this function. Authenticity is established
// instead by verifying Paddle's HMAC-SHA256 signature over the RAW request
// body, exactly as documented at
// https://developer.paddle.com/webhooks/signature-verification
//
// Configure in the Paddle dashboard under Developer tools -> Notifications:
//   URL     : https://<project>.supabase.co/functions/v1/paddle-webhook
//   Events  : subscription.created, subscription.updated, subscription.canceled,
//             transaction.completed
// Paddle then shows a secret key beginning "pdl_ntfset_", which must be stored
// in app_secrets under PADDLE_NOTIFICATION_SECRET.
//
// Design notes:
//  * We resolve the customer's company from custom_data.company_id (set when
//    the checkout transaction is created by the billing function). If that is
//    missing -- e.g. a subscription created directly in the Paddle dashboard --
//    we fall back to paddle_subscription_id, then paddle_customer_id, so a
//    manually-created subscription still lands on the right company once it
//    has been linked one time.
//  * Unknown event types are acknowledged with 200. Returning an error would
//    make Paddle retry an event we will never act on.
//  * We always return 200 once the signature is valid, even if our own
//    bookkeeping fails, and log loudly instead. A 500 makes Paddle retry for
//    hours, which turns one bad row into a storm.

import { createClient } from "jsr:@supabase/supabase-js@2";

const PLAN_BY_STATUS_FALLBACK = "free";

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

// "ts=1671552777;h1=eb4d0dc8..." -> { ts, h1 }
function parsePaddleSignature(header: string): { ts: string; h1: string } | null {
  const parts = header.split(";");
  let ts = "", h1 = "";
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "h1") h1 = v;
  }
  if (!ts || !h1) return null;
  return { ts, h1 };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as any;
    const parts = [e.message, e.details, e.hint, e.code ? `(code ${e.code})` : null]
      .filter((p) => typeof p === "string" && p.length);
    if (parts.length) return parts.join(" -- ");
    try { return JSON.stringify(err).slice(0, 500); } catch { /* fall through */ }
  }
  return String(err);
}

Deno.serve(async (req: Request) => {
  // Read the raw body FIRST and never re-serialise it -- the signature is
  // computed over these exact bytes.
  const rawBody = await req.text();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: secretRow } = await admin
      .from("app_secrets").select("value").eq("key", "PADDLE_NOTIFICATION_SECRET").maybeSingle();
    if (!secretRow?.value) {
      console.error("PADDLE_NOTIFICATION_SECRET is not configured in app_secrets.");
      return new Response("Billing not configured", { status: 500 });
    }

    const sigHeader = req.headers.get("paddle-signature");
    if (!sigHeader) return new Response("Missing Paddle-Signature header", { status: 400 });

    const parsed = parsePaddleSignature(sigHeader);
    if (!parsed) return new Response("Malformed Paddle-Signature header", { status: 400 });

    const expected = await hmacSha256Hex(secretRow.value, `${parsed.ts}:${rawBody}`);
    if (!timingSafeEqualHex(expected, parsed.h1)) {
      console.error("Paddle webhook signature verification failed.");
      return new Response("Signature verification failed", { status: 401 });
    }

    // Replay guard. Paddle's own guidance suggests a tight window; we allow 5
    // minutes so that a slow cold start cannot reject a legitimate event.
    const tsSeconds = Number(parsed.ts);
    if (Number.isFinite(tsSeconds)) {
      const skewSeconds = Math.abs(Date.now() / 1000 - tsSeconds);
      if (skewSeconds > 300) {
        console.error(`Paddle webhook rejected: timestamp skew ${Math.round(skewSeconds)}s.`);
        return new Response("Timestamp outside tolerance", { status: 400 });
      }
    }

    const event = JSON.parse(rawBody);
    const eventType: string = event?.event_type ?? "";
    const data: any = event?.data ?? {};

    // ---- resolve which company this event belongs to -------------------
    async function resolveCompanyId(): Promise<string | null> {
      const fromCustomData = data?.custom_data?.company_id;
      if (typeof fromCustomData === "string" && fromCustomData) return fromCustomData;

      const subscriptionId = data?.id && eventType.startsWith("subscription.")
        ? data.id
        : data?.subscription_id ?? null;
      if (subscriptionId) {
        const { data: co } = await admin
          .from("companies").select("id").eq("paddle_subscription_id", subscriptionId).maybeSingle();
        if (co?.id) return co.id;
      }

      const customerId = data?.customer_id ?? null;
      if (customerId) {
        const { data: co } = await admin
          .from("companies").select("id").eq("paddle_customer_id", customerId).maybeSingle();
        if (co?.id) return co.id;
      }
      return null;
    }

    // Paddle prices are the source of truth for which plan was bought. Map the
    // price id on the subscription back to our plan id.
    async function resolvePlanId(): Promise<string | null> {
      const fromCustomData = data?.custom_data?.plan_id;
      if (typeof fromCustomData === "string" && fromCustomData) return fromCustomData;

      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        const priceId = item?.price?.id ?? item?.price_id ?? null;
        if (!priceId) continue;
        const { data: plan } = await admin
          .from("plans").select("id").eq("paddle_price_id", priceId).maybeSingle();
        if (plan?.id) return plan.id;
      }
      return null;
    }

    switch (eventType) {
      case "subscription.created":
      case "subscription.updated": {
        const companyId = await resolveCompanyId();
        if (!companyId) {
          console.error(`Paddle ${eventType}: could not resolve a company (subscription ${data?.id}).`);
          break;
        }
        const planId = await resolvePlanId();
        const status: string = data?.status ?? "";

        // How far the customer has actually paid. Paddle keeps this current
        // through renewals, so it is the honest answer to "what have they
        // bought?" -- unlike the status, which flips the moment a card fails.
        const paidUntil = data?.current_billing_period?.ends_at ?? null;

        const update: Record<string, unknown> = {
          paddle_subscription_id: data?.id ?? null,
          paddle_customer_id: data?.customer_id ?? null,
          subscription_status: status || null,
          billing_provider: "paddle",
          ...(paidUntil ? { paid_until: paidUntil } : {}),
        };

        // A paid period is honoured to its end.
        //
        // active or trialing: grant the plan, as before.
        //
        // past_due: the card failed and Paddle is retrying, which usually
        // works within a few days. Leave the plan alone. Cutting a customer
        // off for a payment that is about to succeed is worse than carrying
        // them for a week.
        //
        // canceled or paused: they keep what they paid for. The refund policy
        // gives nothing back for the remainder of the period, so taking the
        // service away as well would be charging for a month and delivering
        // three days of it.
        //
        // In every non-active case expire_lapsed_subscriptions() removes the
        // plan once paid_until has passed -- and if paid_until is unknown, it
        // falls back to free here rather than granting an open-ended plan.
        if (["active", "trialing"].includes(status) && planId) {
          update.plan = planId;
        } else if (!["active", "trialing"].includes(status)) {
          const stillPaidFor = paidUntil && new Date(paidUntil).getTime() > Date.now();
          if (!stillPaidFor) {
            update.plan = PLAN_BY_STATUS_FALLBACK;
          } else {
            console.log(`Paddle ${eventType}: subscription ${data?.id} is ${status} but paid until ${paidUntil} -- keeping access until then.`);
          }
        }

        const { error } = await admin.from("companies").update(update).eq("id", companyId);
        if (error) console.error(`Paddle ${eventType}: DB update failed -- ${describeError(error)}`);
        break;
      }

      case "subscription.canceled": {
        const companyId = await resolveCompanyId();
        if (!companyId) {
          console.error(`Paddle subscription.canceled: could not resolve a company (subscription ${data?.id}).`);
          break;
        }
        // Same rule on an explicit cancellation: they keep the period they
        // paid for. paddle_subscription_id is deliberately NOT cleared while
        // that period runs, so the scheduled sweep can still see which
        // subscription the access came from.
        const paidUntil = data?.current_billing_period?.ends_at ?? null;
        const stillPaidFor = paidUntil && new Date(paidUntil).getTime() > Date.now();
        const { error } = await admin.from("companies").update({
          ...(stillPaidFor ? {} : { plan: PLAN_BY_STATUS_FALLBACK, paddle_subscription_id: null }),
          ...(paidUntil ? { paid_until: paidUntil } : {}),
          subscription_status: "canceled",
          billing_provider: "paddle",
        }).eq("id", companyId);
        if (error) console.error(`Paddle subscription.canceled: DB update failed -- ${describeError(error)}`);
        break;
      }

      case "transaction.completed": {
        // Subscription state is driven by the subscription.* events above; this
        // links the Paddle customer id to the company the first time a purchase
        // completes, so later events resolve even without custom_data — and
        // credits the wallet when the transaction was a one-time top-up.
        const companyId = await resolveCompanyId();
        const customerId = data?.customer_id ?? null;
        if (companyId && customerId) {
          const { error } = await admin.from("companies")
            .update({ paddle_customer_id: customerId, billing_provider: "paddle" })
            .eq("id", companyId);
          if (error) console.error(`Paddle transaction.completed: DB update failed -- ${describeError(error)}`);
        }

        // ---- page packs (pay per page, 2026-10-18) ------------------------
        // Quantities are read from the PAID line items and mapped through
        // page_products by Paddle price id -- never from custom_data, which
        // round-trips through the browser. apply_page_purchase is idempotent
        // on the transaction id, so a Paddle retry cannot add pages twice.
        if (data?.custom_data?.kind === "pages") {
          const transactionId: string | null = data?.id ?? null;
          if (!companyId || !transactionId) {
            console.error(`Paddle pages: missing company (${companyId}) or transaction id (${transactionId}).`);
            break;
          }
          const { data: products } = await admin.from("page_products")
            .select("id, name, spec_pages_per_unit, paddle_price_id");
          const byPrice = new Map((products ?? []).filter((p: any) => p.paddle_price_id).map((p: any) => [p.paddle_price_id, p]));
          let boq = 0, draftsman = 0, spec = 0;
          const items: any[] = Array.isArray(data?.items) ? data.items : [];
          for (const item of items) {
            const priceId = item?.price?.id ?? item?.price_id ?? null;
            const qty = Math.max(0, Math.floor(Number(item?.quantity ?? 0)));
            const product: any = priceId ? byPrice.get(priceId) : null;
            if (!product || !qty) continue;
            if (product.id === "boq_page") boq += qty;
            else if (product.id === "draftsman_page") draftsman += qty;
            else if (product.id === "spec_page") spec += qty;
            spec += qty * Number(product.spec_pages_per_unit || 0);   // 4 spec pages with every drawing page
          }
          if (!boq && !draftsman && !spec) {
            console.error(`Paddle pages: transaction ${transactionId} has no recognised page items.`);
            break;
          }
          const { error: pagesErr } = await admin.rpc("apply_page_purchase", {
            p_company_id: companyId,
            p_paddle_transaction_id: transactionId,
            p_boq: boq,
            p_draftsman: draftsman,
            p_spec: spec,
            p_description: `Page pack — Paddle transaction ${transactionId}`,
          });
          if (pagesErr) {
            console.error(`Paddle pages failed for company ${companyId}, transaction ${transactionId} -- ${describeError(pagesErr)}`);
          } else {
            console.log(`Paddle pages applied: company ${companyId} +${boq} BOQ, +${draftsman} draftsman, +${spec} spec.`);
          }
          break;
        }

        // ---- wallet top-up ------------------------------------------------
        if (data?.custom_data?.kind === "topup") {
          const transactionId: string | null = data?.id ?? null;
          if (!companyId || !transactionId) {
            console.error(`Paddle top-up: missing company (${companyId}) or transaction id (${transactionId}).`);
            break;
          }

          // The amount is re-read from credit_packs rather than trusted from
          // custom_data — custom_data round-trips through the browser, so
          // treating it as authoritative would let a caller mint free credit.
          const packId = String(data?.custom_data?.pack_id ?? "");
          const { data: pack } = await admin.from("credit_packs")
            .select("id, name, credit_cents, search_credits").eq("id", packId).maybeSingle();
          if (!pack) {
            console.error(`Paddle top-up: unknown pack "${packId}" on transaction ${transactionId}.`);
            break;
          }

          // apply_credit_topup is atomic and idempotent on transaction id, so a
          // Paddle retry of the same event cannot credit the wallet twice.
          // A pack may grant market-search credits instead of, or as well as,
          // wallet cents. Same rules as the wallet: the amount is re-read from
          // credit_packs rather than trusted from custom_data, and the grant is
          // idempotent on the Paddle transaction id so a retry cannot pay twice.
          // apply_search_topup is also what switches Pricing BOQ on -- the
          // feature turns itself on here, at the moment the money is confirmed
          // received, and nowhere else.
          if (Number(pack.search_credits ?? 0) > 0) {
            const { data: searchBalance, error: searchErr } = await admin.rpc("apply_search_topup", {
              p_company_id: companyId,
              p_searches: pack.search_credits,
              p_description: `${pack.name} — Paddle transaction ${transactionId}`,
              p_paddle_transaction_id: transactionId,
            });
            if (searchErr) {
              console.error(`Paddle search top-up failed for company ${companyId}, transaction ${transactionId} -- ${describeError(searchErr)}`);
            } else {
              console.log(`Paddle search top-up applied: company ${companyId} +${pack.search_credits} searches, balance now ${searchBalance}.`);
            }
          }

          // A search-only pack grants no wallet cents; nothing further to do.
          if (Number(pack.credit_cents ?? 0) <= 0) break;

          const { data: newBalance, error: topupErr } = await admin.rpc("apply_credit_topup", {
            p_company_id: companyId,
            p_credit_cents: pack.credit_cents,
            p_description: `${pack.name} — Paddle transaction ${transactionId}`,
            p_paddle_transaction_id: transactionId,
          });
          if (topupErr) {
            console.error(`Paddle top-up failed for company ${companyId}, transaction ${transactionId} -- ${describeError(topupErr)}`);
          } else {
            console.log(`Paddle top-up applied: company ${companyId} +${pack.credit_cents}c, balance now ${newBalance}c.`);
          }
        }
        break;
      }

      default:
        // Acknowledged and ignored on purpose -- retrying would achieve nothing.
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // Signature already verified by the time most failures can happen, so this
    // is our bug, not Paddle's. Log it and acknowledge, rather than triggering
    // hours of retries.
    console.error("Paddle webhook handler error:", describeError(err));
    return new Response(JSON.stringify({ received: true, handled: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
});
