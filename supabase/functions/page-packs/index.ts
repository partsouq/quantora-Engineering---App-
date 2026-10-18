// Page packs: pay per page (2026-10-18).
//
// Separate from paddle-billing on purpose, so the working subscription and
// wallet checkout cannot be affected by anything here.
//
// The customer picks how many take-off BOQ pages, draftsman pages and extra
// specification pages to buy. One Paddle transaction holds one line item per
// kind, with the quantity. Pages are added ONLY by paddle-webhook on
// transaction.completed (custom_data.kind = "pages"), never here: returning a
// checkout URL is not proof of payment.
//
// Actions:
//   list            — products, prices, minimum order and the company's balances
//   create_checkout — { boq, draftsman, spec } -> { url }

import { createClient } from "jsr:@supabase/supabase-js@2";

const MIN_ORDER_USD = 10;          // keeps Paddle's fixed $0.50 per payment small
const MAX_UNITS = 10000;           // per kind, per order

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err).slice(0, 500); } catch { return String(err); }
}

const PADDLE_ERROR_MESSAGES: Record<string, { message: string; status: number }> = {
  transaction_checkout_not_enabled: {
    message: "Card payment is not switched on for this account yet. Please contact us and we will add the pages for you.",
    status: 503,
  },
  price_not_found: {
    message: "Pages are not available for checkout right now. Please contact us and we will set it up for you.",
    status: 400,
  },
  authentication_missing: { message: "Online payment is not fully configured yet. Please contact us.", status: 503 },
  invalid_token: { message: "Online payment is not fully configured yet. Please contact us.", status: 503 },
  forbidden: { message: "Our payment provider rejected the request. Please contact us — this needs fixing on our side.", status: 502 },
};

function units(v: unknown): number {
  const n = Math.floor(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_UNITS) : 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    const { data: products } = await admin.from("page_products")
      .select("id, name, price_usd, spec_pages_per_unit, paddle_price_id, is_active, sort_order")
      .eq("is_active", true).order("sort_order", { ascending: true });
    const product = (id: string) => (products ?? []).find((p: any) => p.id === id) as any;

    const { data: profile } = await admin.from("profiles")
      .select("company_id, full_name").eq("id", userId).maybeSingle();
    const companyId: string | null = profile?.company_id ?? null;
    const { data: company } = companyId
      ? await admin.from("companies").select("*").eq("id", companyId).maybeSingle()
      : { data: null as any };

    if (action === "list") {
      return json({
        products: (products ?? []).map((p: any) => ({
          id: p.id, name: p.name, price_usd: Number(p.price_usd),
          spec_pages_per_unit: p.spec_pages_per_unit, available: !!p.paddle_price_id,
        })),
        min_order_usd: MIN_ORDER_USD,
        balances: {
          boq: company?.boq_pack_pages ?? 0,
          draftsman: company?.draftsman_pack_pages ?? 0,
          spec: company?.spec_pack_pages ?? 0,
        },
      });
    }

    if (action !== "create_checkout") return json({ error: `Unknown action: ${action}` }, 400);

    if (!company) {
      return json({ error: "No company is linked to this account yet. Please reload the page and try again." }, 400);
    }

    const want: Array<[string, number]> = [
      ["boq_page", units(body.boq)],
      ["draftsman_page", units(body.draftsman)],
      ["spec_page", units(body.spec)],
    ];
    const lines = want.filter(([, q]) => q > 0);
    if (!lines.length) return json({ error: "Choose how many pages to buy." }, 400);

    let total = 0;
    for (const [id, q] of lines) {
      const p = product(id);
      if (!p) return json({ error: "Pages are not available right now. Please contact us." }, 400);
      if (!p.paddle_price_id) {
        return json({ error: `${p.name}s are not available for online purchase yet. Please contact us and we will add them for you.` }, 400);
      }
      total += q * Number(p.price_usd);
    }
    total = Math.round(total * 100) / 100;
    if (total < MIN_ORDER_USD) {
      return json({ error: `The minimum order is $${MIN_ORDER_USD}. This order is $${total.toFixed(2)} — add a few more pages.` }, 400);
    }

    const { data: keyRow } = await admin.from("app_secrets").select("value").eq("key", "PADDLE_API_KEY").maybeSingle();
    const paddleApiKey = (keyRow?.value ?? "").trim();
    if (!paddleApiKey) return json({ error: "Online payment is not enabled yet. Please contact us to buy pages." }, 503);
    const { data: envRow } = await admin.from("app_secrets").select("value").eq("key", "PADDLE_ENV").maybeSingle();
    const paddleBase = (envRow?.value ?? "").trim().toLowerCase() === "sandbox"
      ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

    async function paddleFetch(path: string, init?: RequestInit): Promise<any> {
      const res = await fetch(`${paddleBase}${path}`, {
        ...init,
        headers: { "Authorization": `Bearer ${paddleApiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) {
        const err: any = new Error(`Paddle API ${res.status}: ${parsed?.error?.detail || parsed?.error?.code || text.slice(0, 300)}`);
        err.status = res.status;
        err.paddleCode = parsed?.error?.code ?? null;
        throw err;
      }
      return parsed;
    }

    // Same customer handling as paddle-billing: reuse, create, or look up on 409.
    let customerId: string | null = company.paddle_customer_id ?? null;
    if (!customerId) {
      const email = userData.user.email ?? undefined;
      try {
        const created = await paddleFetch("/customers", {
          method: "POST",
          body: JSON.stringify({ email, name: company.name ?? profile?.full_name ?? undefined, custom_data: { company_id: company.id } }),
        });
        customerId = created?.data?.id ?? null;
      } catch (err: any) {
        if (err?.status === 409 && email) {
          const found = await paddleFetch(`/customers?email=${encodeURIComponent(email)}`);
          customerId = found?.data?.[0]?.id ?? null;
        }
        if (!customerId) throw err;
      }
      if (customerId) {
        await admin.from("companies").update({ paddle_customer_id: customerId, billing_provider: "paddle" }).eq("id", company.id);
      }
    }

    const txn = await paddleFetch("/transactions", {
      method: "POST",
      body: JSON.stringify({
        items: lines.map(([id, q]) => ({ price_id: product(id).paddle_price_id, quantity: q })),
        customer_id: customerId,
        collection_mode: "automatic",
        // kind tells paddle-webhook to add pages; the quantities it uses come
        // from the paid line items, not from here.
        custom_data: { company_id: company.id, kind: "pages" },
      }),
    });
    const url = txn?.data?.checkout?.url ?? null;
    if (!url) {
      return json({ error: "Paddle did not return a checkout URL. In the Paddle dashboard, set a default payment link under Checkout -> Settings, then try again." }, 500);
    }
    return json({ url, provider: "paddle", transaction_id: txn?.data?.id ?? null, total_usd: total });
  } catch (err) {
    console.error("page-packs error:", describeError(err));
    const code = (err as any)?.paddleCode as string | undefined;
    const mapped = code ? PADDLE_ERROR_MESSAGES[code] : undefined;
    if (mapped) return json({ error: mapped.message, code }, mapped.status);
    return json({ error: describeError(err), code: code ?? null }, 500);
  }
});
