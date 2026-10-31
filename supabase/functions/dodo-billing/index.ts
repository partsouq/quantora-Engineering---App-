// ===========================================================================
// Quantora — dodo-billing (2026-10-31). Replaces razorpay-billing.
//
// Monthly plans and monthly storage add-ons, paid through Dodo Payments
// (merchant of record: Dodo handles tax/VAT worldwide). This function only
// STARTS a payment or reads state: access is switched on by applySubscription()
// once Dodo reports the subscription, from the webhook (dodo-webhook) or from
// "sync" when the customer comes back from checkout, whichever is first.
// Both are idempotent.
//
// Actions:
//   config             — is online payment on, prices (USD), my subscriptions
//   subscribe_plan     — { plan_id, return_url } -> { checkout_url } (or { changed: true })
//   subscribe_storage  — { gb, return_url }      -> { checkout_url }
//   sync               — after returning from checkout: re-read my subscriptions from Dodo
//   cancel             — { subscription_id } cancels at the end of the paid month
//   invoice            — { payment_id } -> the official invoice PDF from Dodo (my company's payments only)
//   readiness          — platform admins: keys, API check, recent events, paying companies
// ===========================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { applySubscription, dodo, loadKeys, recordPayment, type DodoKeys } from "./dodo.ts";

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
const APP_ORIGINS = ["https://www.quantoraengineering.com", "https://quantoraengineering.com", "http://localhost", "https://partsouq.github.io"];

/** Dodo product id for an item at a price, creating the Dodo product the first time. */
async function dodoProductFor(keys: DodoKeys, item: string, name: string, description: string, amountUsd: number): Promise<string> {
  const amountMinor = Math.round(amountUsd * 100);
  const { data: hit } = await admin.from("dodo_products").select("product_id")
    .eq("item", item).eq("mode", keys.mode).eq("currency", "USD").eq("amount_minor", amountMinor).maybeSingle();
  if (hit?.product_id) return hit.product_id;
  const created = await dodo(keys, "/products", {
    method: "POST",
    body: {
      name, description, tax_category: "saas",
      price: {
        type: "recurring_price", currency: "USD", price: amountMinor, discount: 0, purchasing_power_parity: false,
        payment_frequency_count: 1, payment_frequency_interval: "Month",
        subscription_period_count: 20, subscription_period_interval: "Year",
        tax_inclusive: false, trial_period_days: 0,
      },
      metadata: { item },
    },
  });
  const { error } = await admin.from("dodo_products").insert({
    item, mode: keys.mode, currency: "USD", amount_minor: amountMinor, product_id: created.product_id,
  });
  if (error) {
    // Lost a race with another request: use the row that won.
    const { data: again } = await admin.from("dodo_products").select("product_id")
      .eq("item", item).eq("mode", keys.mode).eq("currency", "USD").eq("amount_minor", amountMinor).maybeSingle();
    if (again?.product_id) return again.product_id;
    throw error;
  }
  return created.product_id;
}

const safeReturn = (u: unknown) => {
  const s = String(u ?? "");
  return APP_ORIGINS.some((o) => s.startsWith(o)) ? s : "https://www.quantoraengineering.com/?checkout=done";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: ud } = await admin.auth.getUser(jwt);
    if (!ud?.user) return json({ error: "Not signed in." }, 401);
    const user = ud.user;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "config");
    const keys = await loadKeys(admin);

    // Platform admins only: is Dodo ready to take money, and what came in lately.
    if (action === "readiness") {
      const { data: isAdmin } = await admin.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
      if (!isAdmin) return json({ error: "Platform admin access only." }, 403);
      let apiOk = false, apiError: string | null = null;
      if (keys) { try { await dodo(keys, "/products?page_size=1"); apiOk = true; } catch (e) { apiError = describe(e); } }
      const { data: plans } = await admin.from("plans").select("id, name, price_usd, is_trial");
      const { data: addons } = await admin.from("storage_addons").select("gb, price_usd, is_active").eq("is_active", true);
      const { data: events } = await admin.from("billing_events").select("event, received_at, payload")
        .eq("provider", "dodo").order("received_at", { ascending: false }).limit(10);
      const { data: paying } = await admin.from("companies").select("id, name, plan, subscription_status, paid_until")
        .eq("billing_provider", "dodo").order("paid_until", { ascending: false, nullsFirst: false });
      const coName: Record<string, string> = {};
      for (const c of paying ?? []) coName[c.id] = c.name;
      return json({
        keys_configured: !!keys, mode: keys?.mode ?? null, currency: "USD", api_ok: apiOk, api_error: apiError,
        webhook_secret_configured: !!keys?.webhookSecret,
        plans: (plans ?? []).filter((p: any) => !p.is_trial && Number(p.price_usd) > 0).map((p: any) => ({ id: p.id, name: p.name, price: Number(p.price_usd) })),
        storage_addons: (addons ?? []).map((a: any) => ({ gb: a.gb, price: Number(a.price_usd) })),
        recent_events: (events ?? []).map((e: any) => {
          const d = e.payload?.data ?? {};
          const cid = String(d?.metadata?.company_id ?? "");
          return { event: e.event, received_at: e.received_at, subscription_id: d.subscription_id ?? null, status: d.status ?? null,
                   company: coName[cid] ?? (cid || d?.customer?.email || null) };
        }),
        paying_companies: paying ?? [],
      });
    }

    const { data: prof } = await admin.from("profiles").select("company_id, full_name").eq("id", user.id).maybeSingle();
    if (!prof?.company_id) return json({ error: "No company on this account yet. Reload the page and try again." }, 400);
    const companyId = prof.company_id as string;
    const { data: company } = await admin.from("companies").select("*").eq("id", companyId).maybeSingle();

    if (action === "config") {
      const { data: plans } = await admin.from("plans").select("id, name, price_usd, is_trial")
        .order("price_usd", { ascending: true, nullsFirst: true });
      const { data: addons } = await admin.from("storage_addons").select("*").eq("is_active", true).order("gb");
      const { data: storageSubs } = await admin.from("company_storage_subscriptions")
        .select("addon_gb, dodo_subscription_id, status, current_end").eq("company_id", companyId)
        .not("dodo_subscription_id", "is", null)
        .in("status", ["active", "pending", "on_hold", "past_due", "paused", "cancelled"]);
      const { data: lastPay } = await admin.from("billing_payments")
        .select("payment_id, description, status, amount_minor, currency, card_network, card_last_four, paid_at, period_end, customer_email")
        .eq("company_id", companyId).order("paid_at", { ascending: false }).limit(1).maybeSingle();
      return json({
        enabled: !!keys,
        provider: "dodo",
        currency: "USD",
        plans: (plans ?? []).filter((p: any) => !p.is_trial && Number(p.price_usd) > 0)
          .map((p: any) => ({ id: p.id, name: p.name, price: Number(p.price_usd) })),
        storage_addons: (addons ?? []).map((a: any) => ({ gb: a.gb, price: Number(a.price_usd), note: a.note })),
        plan_subscription: company?.billing_provider === "dodo" ? {
          id: company.dodo_subscription_id, plan: company.plan, status: company.subscription_status, paid_until: company.paid_until,
        } : null,
        storage_subscriptions: (storageSubs ?? []).map((s: any) => ({ ...s, subscription_id: s.dodo_subscription_id })),
        last_payment: lastPay ?? null,
      });
    }

    if (!keys) return json({ error: NOT_OPEN }, 503);
    const customer = { email: user.email ?? "", name: prof.full_name || company?.name || user.email || "Customer" };

    if (action === "subscribe_plan") {
      const planId = String(body.plan_id ?? "");
      const { data: plan } = await admin.from("plans").select("*").eq("id", planId).maybeSingle();
      const price = plan ? Number(plan.price_usd) : 0;
      if (!plan || plan.is_trial || !(price > 0)) return json({ error: "That plan cannot be bought online." }, 400);
      const productId = await dodoProductFor(keys, `plan:${planId}`, `Quantora ${plan.name} (monthly)`,
        `Quantora Engineering ${plan.name} plan, billed monthly.`, price);

      // Already paying monthly through Dodo: switch the existing subscription
      // to the new plan instead of starting a second one.
      if (company?.billing_provider === "dodo" && company.dodo_subscription_id
          && ["active", "past_due", "on_hold"].includes(String(company.subscription_status))) {
        await dodo(keys, `/subscriptions/${company.dodo_subscription_id}/change-plan`, {
          method: "POST", body: { product_id: productId, quantity: 1, proration_billing_mode: "prorated_immediately" },
        });
        const sub = await dodo(keys, `/subscriptions/${company.dodo_subscription_id}`);
        await applySubscription(admin, sub);
        return json({ changed: true, plan: planId });
      }

      const session = await dodo(keys, "/checkouts", {
        method: "POST",
        body: {
          product_cart: [{ product_id: productId, quantity: 1 }],
          customer, return_url: safeReturn(body.return_url),
          metadata: { company_id: companyId, kind: "plan", plan_id: planId, user_id: user.id },
        },
      });
      return json({ checkout_url: session.checkout_url, session_id: session.session_id });
    }

    if (action === "subscribe_storage") {
      const gb = Math.floor(Number(body.gb ?? 0));
      const { data: addon } = await admin.from("storage_addons").select("*").eq("gb", gb).eq("is_active", true).maybeSingle();
      const price = addon ? Number(addon.price_usd) : 0;
      if (!addon || !(price > 0)) return json({ error: "That storage add-on is not available." }, 400);
      const productId = await dodoProductFor(keys, `storage:${gb}`, `Quantora storage +${gb} GB (monthly)`,
        `Extra ${gb} GB of project storage on Quantora Engineering, billed monthly.`, price);
      const session = await dodo(keys, "/checkouts", {
        method: "POST",
        body: {
          product_cart: [{ product_id: productId, quantity: 1 }],
          customer, return_url: safeReturn(body.return_url),
          metadata: { company_id: companyId, kind: "storage", gb: String(gb), user_id: user.id },
        },
      });
      return json({ checkout_url: session.checkout_url, session_id: session.session_id });
    }

    if (action === "sync") {
      // Back from checkout: the webhook normally lands first; this covers a slow one.
      const subId = String(body.subscription_id ?? "");
      const notes: string[] = [];
      const ids = new Set<string>();
      if (subId) ids.add(subId);
      if (company?.dodo_subscription_id) ids.add(company.dodo_subscription_id);
      if (!subId && user.email) {
        // Find this customer's newest subscriptions by email.
        const list = await dodo(keys, `/subscriptions?page_size=10`).catch(() => null);
        for (const s of list?.items ?? []) {
          if (String(s?.customer?.email ?? "").toLowerCase() === user.email.toLowerCase()) ids.add(s.subscription_id);
        }
      }
      for (const id of ids) {
        const sub = await dodo(keys, `/subscriptions/${id}`).catch(() => null);
        if (!sub) continue;
        if (sub.metadata?.company_id && String(sub.metadata.company_id) !== companyId) continue;
        notes.push(await applySubscription(admin, sub));
        // Its payments into our records too, so the receipt can show straight away.
        const pays = await dodo(keys, `/payments?subscription_id=${encodeURIComponent(id)}&page_size=5`).catch(() => null);
        for (const pp of pays?.items ?? []) {
          if (!["succeeded", "failed"].includes(String(pp.status))) continue;
          const full = await dodo(keys, `/payments/${pp.payment_id}`).catch(() => pp);
          notes.push(await recordPayment(admin, full, sub));
        }
      }
      return json({ ok: true, notes });
    }

    if (action === "cancel") {
      const subId = String(body.subscription_id ?? "");
      const sub = await dodo(keys, `/subscriptions/${subId}`);
      const owner = String(sub?.metadata?.company_id ?? "");
      if (owner ? owner !== companyId : String(sub?.customer?.email ?? "").toLowerCase() !== String(user.email ?? "").toLowerCase())
        return json({ error: "This subscription belongs to another account." }, 403);
      const updated = await dodo(keys, `/subscriptions/${subId}`, { method: "PATCH", body: { cancel_at_next_billing_date: true } });
      await applySubscription(admin, updated?.subscription_id ? updated : { ...sub, cancel_at_next_billing_date: true });
      return json({ ok: true, status: "cancelled", ends: sub.next_billing_date ?? null });
    }

    if (action === "invoice") {
      const payId = String(body.payment_id ?? "");
      const { data: mine } = await admin.from("billing_payments").select("payment_id, company_id").eq("payment_id", payId).maybeSingle();
      if (!mine || mine.company_id !== companyId) return json({ error: "This invoice belongs to another account." }, 403);
      const res = await fetch(`${keys.base}/invoices/payments/${encodeURIComponent(payId)}`,
        { headers: { Authorization: `Bearer ${keys.apiKey}`, Accept: "application/pdf" } });
      if (!res.ok) return json({ error: "The invoice is not ready yet. Please try again in a minute." }, 502);
      return new Response(await res.arrayBuffer(), { status: 200, headers: {
        ...cors, "content-type": "application/pdf",
        "content-disposition": `attachment; filename="Quantora-invoice-${payId}.pdf"` } });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("dodo-billing error:", describe(err));
    return json({ error: describe(err) }, 500);
  }
});
