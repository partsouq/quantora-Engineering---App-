// ===========================================================================
// Quantora — razorpay-billing (24 Oct 2026)
//
// Monthly plans and monthly storage add-ons, paid through Razorpay
// Subscriptions. This function only ever STARTS a payment or reads state:
// access is granted by applySubscription() once Razorpay reports the
// subscription paid, either from the checkout signature (verify) or from the
// webhook, whichever arrives first. Both are idempotent.
//
// Actions:
//   config             — is online payment on, the public key, prices, my subscriptions
//   subscribe_plan     — { plan_id }  -> { subscription_id, key_id } (or { changed: true })
//   subscribe_storage  — { gb }       -> { subscription_id, key_id }
//   verify             — { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
//   cancel             — { subscription_id } cancels at the end of the paid month
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { applySubscription, hmacHex, loadKeys, rz, safeEqual, type RzKeys } from "./razorpay.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const describe = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e).slice(0, 300));

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const NOT_OPEN = "Card payment is not switched on for this account yet.";

/** Razorpay plan id for an item at a price, creating the Razorpay plan the first time. */
async function razorpayPlanFor(keys: RzKeys, item: string, name: string, amountMajor: number): Promise<string> {
  const amountMinor = Math.round(amountMajor * 100);
  const { data: hit } = await admin.from("razorpay_plans").select("razorpay_plan_id")
    .eq("item", item).eq("currency", keys.currency).eq("amount_minor", amountMinor).maybeSingle();
  if (hit?.razorpay_plan_id) return hit.razorpay_plan_id;
  const created = await rz(keys, "/plans", {
    method: "POST",
    body: { period: "monthly", interval: 1, item: { name, amount: amountMinor, currency: keys.currency },
            notes: { item } },
  });
  const { error } = await admin.from("razorpay_plans").insert({
    item, currency: keys.currency, amount_minor: amountMinor, razorpay_plan_id: created.id,
  });
  if (error) {
    // Lost a race with another request: use the row that won.
    const { data: again } = await admin.from("razorpay_plans").select("razorpay_plan_id")
      .eq("item", item).eq("currency", keys.currency).eq("amount_minor", amountMinor).maybeSingle();
    if (again?.razorpay_plan_id) return again.razorpay_plan_id;
    throw error;
  }
  return created.id;
}

const priceOf = (row: any, currency: string) =>
  currency === "INR" ? (row.price_inr == null ? null : Number(row.price_inr)) : Number(row.price_usd);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: ud } = await admin.auth.getUser(jwt);
    if (!ud?.user) return json({ error: "Not signed in." }, 401);
    const user = ud.user;

    const { data: prof } = await admin.from("profiles").select("company_id, full_name").eq("id", user.id).maybeSingle();
    if (!prof?.company_id) return json({ error: "No company on this account yet. Reload the page and try again." }, 400);
    const companyId = prof.company_id as string;
    const { data: company } = await admin.from("companies").select("*").eq("id", companyId).maybeSingle();

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "config");
    const keys = await loadKeys(admin);

    if (action === "config") {
      const currency = keys?.currency ?? "USD";
      const { data: plans } = await admin.from("plans").select("id, name, price_usd, price_inr, is_trial")
        .order("price_usd", { ascending: true, nullsFirst: true });
      const { data: addons } = await admin.from("storage_addons").select("*").eq("is_active", true).order("gb");
      const { data: storageSubs } = await admin.from("company_storage_subscriptions")
        .select("addon_gb, razorpay_subscription_id, status, current_end").eq("company_id", companyId)
        .in("status", ["active", "pending", "halted", "cancelled", "authenticated", "created"]);
      return json({
        enabled: !!keys,
        key_id: keys?.keyId ?? null,
        currency,
        plans: (plans ?? []).filter((p: any) => !p.is_trial && Number(p.price_usd) > 0)
          .map((p: any) => ({ id: p.id, name: p.name, price: priceOf(p, currency) })),
        storage_addons: (addons ?? []).map((a: any) => ({ gb: a.gb, price: priceOf(a, currency), note: a.note })),
        plan_subscription: company?.billing_provider === "razorpay" ? {
          id: company.razorpay_subscription_id, status: company.subscription_status, paid_until: company.paid_until,
        } : null,
        storage_subscriptions: storageSubs ?? [],
      });
    }

    if (!keys) return json({ error: NOT_OPEN }, 503);

    if (action === "subscribe_plan") {
      const planId = String(body.plan_id ?? "");
      const { data: plan } = await admin.from("plans").select("*").eq("id", planId).maybeSingle();
      const price = plan ? priceOf(plan, keys.currency) : null;
      if (!plan || plan.is_trial || !price || price <= 0) return json({ error: "That plan cannot be bought online." }, 400);
      const rzPlan = await razorpayPlanFor(keys, `plan:${planId}`, `Quantora ${plan.name} (monthly)`, price);

      // Already paying monthly through Razorpay: switch the existing subscription
      // to the new plan instead of starting a second one.
      if (company?.billing_provider === "razorpay" && company.razorpay_subscription_id
          && ["active", "pending"].includes(String(company.subscription_status))) {
        const updated = await rz(keys, `/subscriptions/${company.razorpay_subscription_id}`, {
          method: "PATCH", body: { plan_id: rzPlan, schedule_change_at: "now", customer_notify: 1 },
        });
        await applySubscription(admin, updated);
        return json({ changed: true, plan: planId });
      }

      const sub = await rz(keys, "/subscriptions", {
        method: "POST",
        body: { plan_id: rzPlan, total_count: 120, customer_notify: 1,
                notes: { company_id: companyId, kind: "plan", plan_id: planId, user_id: user.id } },
      });
      return json({ subscription_id: sub.id, key_id: keys.keyId, name: `Quantora ${plan.name}`,
                    email: user.email ?? null, contact_name: prof.full_name ?? null });
    }

    if (action === "subscribe_storage") {
      const gb = Math.floor(Number(body.gb ?? 0));
      const { data: addon } = await admin.from("storage_addons").select("*").eq("gb", gb).eq("is_active", true).maybeSingle();
      const price = addon ? priceOf(addon, keys.currency) : null;
      if (!addon || !price) return json({ error: "That storage add-on is not available." }, 400);
      const rzPlan = await razorpayPlanFor(keys, `storage:${gb}`, `Quantora storage +${gb} GB (monthly)`, price);
      const sub = await rz(keys, "/subscriptions", {
        method: "POST",
        body: { plan_id: rzPlan, total_count: 120, customer_notify: 1,
                notes: { company_id: companyId, kind: "storage", gb: String(gb), user_id: user.id } },
      });
      return json({ subscription_id: sub.id, key_id: keys.keyId, name: `Quantora storage +${gb} GB`,
                    email: user.email ?? null, contact_name: prof.full_name ?? null });
    }

    if (action === "verify") {
      const paymentId = String(body.razorpay_payment_id ?? "");
      const subId = String(body.razorpay_subscription_id ?? "");
      const signature = String(body.razorpay_signature ?? "");
      const expected = await hmacHex(keys.keySecret, `${paymentId}|${subId}`);
      if (!safeEqual(expected, signature)) return json({ error: "The payment could not be verified." }, 400);
      const sub = await rz(keys, `/subscriptions/${subId}`);
      if (String(sub?.notes?.company_id ?? "") !== companyId) return json({ error: "This payment belongs to another account." }, 403);
      // Razorpay may still be confirming the first charge; the webhook finishes it then.
      const note = await applySubscription(admin, sub);
      return json({ ok: true, status: sub.status, note });
    }

    if (action === "cancel") {
      const subId = String(body.subscription_id ?? "");
      const sub = await rz(keys, `/subscriptions/${subId}`);
      if (String(sub?.notes?.company_id ?? "") !== companyId) return json({ error: "This subscription belongs to another account." }, 403);
      const cancelled = await rz(keys, `/subscriptions/${subId}/cancel`, { method: "POST", body: { cancel_at_cycle_end: 1 } });
      await applySubscription(admin, cancelled);
      return json({ ok: true, status: cancelled.status, ends: cancelled.current_end ?? null });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("razorpay-billing error:", describe(err));
    return json({ error: describe(err) }, 500);
  }
});
