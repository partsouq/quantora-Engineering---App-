// ===========================================================================
// Razorpay helpers shared by razorpay-billing and razorpay-webhook.
// (The same file is copied into both functions, because each edge function is
// deployed on its own.)
//
// The one rule: a plan or storage add-on is switched on only from a Razorpay
// subscription that Razorpay itself reports as paid. Which plan or add-on it
// is comes from OUR map of Razorpay plan ids (razorpay_plans), never from
// anything the browser sent, so a cheap plan cannot be dressed up as a dear one.
// ===========================================================================

export interface RzKeys { keyId: string; keySecret: string; webhookSecret: string; currency: "USD" | "INR" }

export async function loadKeys(admin: any): Promise<RzKeys | null> {
  const { data } = await admin.from("app_secrets").select("key, value")
    .in("key", ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_CURRENCY"]);
  const m = new Map<string, string>((data ?? []).map((r: any) => [String(r.key), String(r.value ?? "").trim()] as [string, string]));
  const keyId = m.get("RAZORPAY_KEY_ID") ?? "", keySecret = m.get("RAZORPAY_KEY_SECRET") ?? "";
  if (!keyId || !keySecret) return null;
  const cur = (m.get("RAZORPAY_CURRENCY") ?? "USD").toUpperCase();
  return { keyId, keySecret, webhookSecret: m.get("RAZORPAY_WEBHOOK_SECRET") ?? "", currency: cur === "INR" ? "INR" : "USD" };
}

export async function rz(keys: RzKeys, path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "Authorization": "Basic " + btoa(`${keys.keyId}:${keys.keySecret}`),
      "Content-Type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e: any = new Error(`Razorpay ${res.status}: ${j?.error?.description ?? text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const unixToIso = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null);

/**
 * Apply a Razorpay subscription entity to the company it belongs to.
 * Returns a short note of what happened, for logs.
 */
export async function applySubscription(admin: any, sub: any): Promise<string> {
  if (!sub?.id || !sub?.plan_id) return "no subscription";
  const { data: map } = await admin.from("razorpay_plans")
    .select("item").eq("razorpay_plan_id", sub.plan_id).maybeSingle();
  if (!map?.item) return `unknown Razorpay plan ${sub.plan_id}`;

  const companyId = String(sub?.notes?.company_id ?? "");
  if (!companyId) return "subscription has no company";
  const { data: co } = await admin.from("companies").select("id, plan, razorpay_subscription_id")
    .eq("id", companyId).maybeSingle();
  if (!co) return `company ${companyId} not found`;

  const status = String(sub.status ?? "");
  const currentEnd = unixToIso(sub.current_end);
  const [kind, ref] = String(map.item).split(":");

  if (kind === "plan") {
    if (status === "active") {
      const { error } = await admin.from("companies").update({
        plan: ref,
        billing_provider: "razorpay",
        subscription_status: "active",
        razorpay_subscription_id: sub.id,
        razorpay_customer_id: sub.customer_id ?? null,
        paid_until: currentEnd,
        manual_grant_reason: null, manual_grant_at: null,
        manual_grant_expires_at: null, manual_grant_previous_plan: null,
      }).eq("id", companyId);
      if (error) throw error;
      return `plan ${ref} active until ${currentEnd}`;
    }
    // Only the company's current plan subscription may take its access away;
    // an old, replaced subscription ending must not downgrade a newer one.
    if (co.razorpay_subscription_id && co.razorpay_subscription_id !== sub.id) return `old subscription ${sub.id} ${status}, ignored`;
    if (["pending", "halted", "cancelled", "completed", "expired"].includes(status)) {
      const { error } = await admin.from("companies").update({
        subscription_status: status,
        billing_provider: "razorpay",
        paid_until: currentEnd ?? new Date().toISOString(),
      }).eq("id", companyId);
      if (error) throw error;
      return `plan subscription ${status}; access kept until ${currentEnd ?? "now"}`;
    }
    return `plan subscription ${status}, nothing to do`;
  }

  if (kind === "storage") {
    const gb = Number(ref);
    if (["created", "authenticated"].includes(status)) return `storage subscription ${status}, not paid yet`;
    const { error } = await admin.from("company_storage_subscriptions").upsert({
      company_id: companyId, addon_gb: gb, razorpay_subscription_id: sub.id,
      status, current_end: currentEnd, updated_at: new Date().toISOString(),
    }, { onConflict: "razorpay_subscription_id" });
    if (error) throw error;
    const { error: rErr } = await admin.rpc("recompute_storage_addon", { p_company: companyId });
    if (rErr) throw rErr;
    return `storage +${gb} GB ${status}`;
  }
  return `unknown item ${map.item}`;
}
