// ===========================================================================
// Dodo Payments helpers shared by dodo-billing and dodo-webhook (2026-10-31).
// (The same file is copied into both functions, because each edge function is
// deployed on its own.)
//
// Dodo is the merchant of record: it sells to the customer, handles tax / VAT
// in every country and pays Quantora out. All plans and storage add-ons are
// monthly Dodo subscriptions, priced in USD.
//
// The one rule (same as Razorpay before it): a plan or add-on is switched on
// only from a Dodo subscription that Dodo itself reports. Which plan it is
// comes from OUR map of Dodo product ids (dodo_products), never from anything
// the browser sent, so a cheap plan cannot be dressed up as a dear one.
//
// Keys live in public.app_secrets (set by the owner in the SQL editor):
//   DODO_API_KEY         live (or test) API key, Products + Subscriptions + Checkout: write
//   DODO_WEBHOOK_SECRET  signing secret of the webhook endpoint (whsec_...)
//   DODO_MODE            optional: "test" to use test.dodopayments.com (default live)
// ===========================================================================

export interface DodoKeys { apiKey: string; webhookSecret: string; mode: "live" | "test"; base: string }

export async function loadKeys(admin: any): Promise<DodoKeys | null> {
  const { data } = await admin.from("app_secrets").select("key, value")
    .in("key", ["DODO_API_KEY", "DODO_WEBHOOK_SECRET", "DODO_MODE"]);
  const m = new Map<string, string>((data ?? []).map((r: any) => [String(r.key), String(r.value ?? "").trim()] as [string, string]));
  const apiKey = m.get("DODO_API_KEY") ?? "";
  if (!apiKey) return null;
  const mode = (m.get("DODO_MODE") ?? "").toLowerCase() === "test" || apiKey.startsWith("dodo_test") ? "test" : "live";
  return { apiKey, webhookSecret: m.get("DODO_WEBHOOK_SECRET") ?? "", mode,
           base: mode === "test" ? "https://test.dodopayments.com" : "https://live.dodopayments.com" };
}

export async function dodo(keys: DodoKeys, path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const res = await fetch(`${keys.base}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${keys.apiKey}`, "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e: any = new Error(`Dodo ${res.status}: ${j?.message ?? j?.code ?? text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

// ---- Standard Webhooks signature (what Dodo uses) --------------------------
// signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`
// key            = base64-decode(secret without the "whsec_" prefix)
// header         = space-separated "v1,<base64 HMAC-SHA256>" entries
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export async function verifyWebhook(secret: string, headers: Headers, raw: string): Promise<boolean> {
  const id = headers.get("webhook-id") ?? "", ts = headers.get("webhook-timestamp") ?? "", sigs = headers.get("webhook-signature") ?? "";
  if (!secret || !id || !ts || !sigs) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 5 * 60) return false;          // replay guard: 5 minutes
  let keyBytes: Uint8Array;
  try { keyBytes = b64ToBytes(secret.replace(/^whsec_/, "")); } catch { keyBytes = new TextEncoder().encode(secret); }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
  const expected = bytesToB64(mac);
  return sigs.split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    return ver === "v1" && safeEqual(sig ?? "", expected);
  });
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Which company a Dodo subscription belongs to: our metadata first, else the customer's email. */
async function companyOf(admin: any, sub: any): Promise<string> {
  const fromMeta = String(sub?.metadata?.company_id ?? "");
  if (fromMeta) return fromMeta;
  const email = String(sub?.customer?.email ?? "").toLowerCase();
  if (!email) return "";
  const { data } = await admin.rpc("company_id_for_email", { p_email: email });
  return data ? String(data) : "";
}

/**
 * Apply a Dodo subscription object to the company it belongs to.
 * Dodo statuses: pending, active, on_hold, paused, cancelled, failed, expired, past_due.
 * Returns a short note of what happened, for logs.
 */
export async function applySubscription(admin: any, sub: any): Promise<string> {
  if (!sub?.subscription_id || !sub?.product_id) return "no subscription";
  const { data: map } = await admin.from("dodo_products").select("item").eq("product_id", sub.product_id).maybeSingle();
  if (!map?.item) return `unknown Dodo product ${sub.product_id}`;

  const companyId = await companyOf(admin, sub);
  if (!companyId) return "subscription has no company";
  const { data: co } = await admin.from("companies").select("id, plan, dodo_subscription_id").eq("id", companyId).maybeSingle();
  if (!co) return `company ${companyId} not found`;

  const status = String(sub.status ?? "");
  const nextBilling = sub.next_billing_date ? new Date(sub.next_billing_date).toISOString() : null;
  const [kind, ref] = String(map.item).split(":");

  if (kind === "plan") {
    if (status === "active") {
      const { error } = await admin.from("companies").update({
        plan: ref,
        billing_provider: "dodo",
        subscription_status: sub.cancel_at_next_billing_date ? "cancelled" : "active",
        dodo_subscription_id: sub.subscription_id,
        dodo_customer_id: sub.customer?.customer_id ?? null,
        paid_until: nextBilling,
        manual_grant_reason: null, manual_grant_at: null,
        manual_grant_expires_at: null, manual_grant_previous_plan: null,
      }).eq("id", companyId);
      if (error) throw error;
      return `plan ${ref} active until ${nextBilling}${sub.cancel_at_next_billing_date ? " (cancels then)" : ""}`;
    }
    // Only the company's current subscription may take its access away;
    // an old, replaced subscription ending must not downgrade a newer one.
    if (co.dodo_subscription_id && co.dodo_subscription_id !== sub.subscription_id) return `old subscription ${sub.subscription_id} ${status}, ignored`;
    if (status === "pending") return "plan subscription pending, not paid yet";
    if (["on_hold", "past_due", "paused", "cancelled", "failed", "expired"].includes(status)) {
      // Access runs to the end of what was paid; expire_lapsed_subscriptions() drops it after.
      const { error } = await admin.from("companies").update({
        subscription_status: status,
        billing_provider: "dodo",
        paid_until: ["failed", "expired"].includes(status) ? new Date().toISOString() : (nextBilling ?? new Date().toISOString()),
      }).eq("id", companyId);
      if (error) throw error;
      return `plan subscription ${status}`;
    }
    return `plan subscription ${status}, nothing to do`;
  }

  if (kind === "storage") {
    const gb = Number(ref);
    if (status === "pending") return "storage subscription pending, not paid yet";
    const { error } = await admin.from("company_storage_subscriptions").upsert({
      company_id: companyId, addon_gb: gb, dodo_subscription_id: sub.subscription_id,
      status: sub.cancel_at_next_billing_date && status === "active" ? "cancelled" : status,
      current_end: ["failed", "expired"].includes(status) ? new Date().toISOString() : nextBilling,
      updated_at: new Date().toISOString(),
    }, { onConflict: "dodo_subscription_id" });
    if (error) throw error;
    const { error: rErr } = await admin.rpc("recompute_storage_addon", { p_company: companyId });
    if (rErr) throw rErr;
    return `storage +${gb} GB ${status}`;
  }
  return `unknown item ${map.item}`;
}
