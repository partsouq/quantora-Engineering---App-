// Manual plan activation for platform admins.
//
// Separate from admin-analytics on purpose: this is the one admin action that
// changes what a customer is entitled to and what they can be billed for, so
// it is small, self-contained and independently auditable rather than buried
// in a 34 KB analytics function.
//
// Why it exists: Quantora sells through Razorpay, but a payment can land without
// the subscription reaching us — a webhook can fail, a customer can pay by
// bank transfer or invoice, or a sandbox test needs undoing. This gives the
// platform admin a way to put an account on the right plan by hand.
//
// Every change writes an admin_quota_adjustments row (adjustment_type
// 'plan_changed') recording who did it, the old plan, the new plan and a note.
//
// Access: platform_admins table only, exactly like admin-analytics.

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

// The permitted reasons for granting a plan by hand. Kept here as well as in
// the database check constraint so the portal can render the list without a
// second source of truth drifting from it.
//
// Every one of them is a giveaway. Quantora takes payment only through Razorpay,
// so there is deliberately no option here for money collected any other way.
// A grant longer than a year is a pricing decision, not a promotion, and should
// go through a plan change rather than an override.
const MAX_GRANT_DAYS = 365;

const GRANT_REASONS: Record<string, { label: string; help: string }> = {
  promotion:   { label: "Free promotion",           help: "Launch offer or seasonal campaign." },
  marketing:   { label: "Marketing / PR",           help: "Case study, conference, review or partnership." },
  gift_card:   { label: "Gift card / voucher",      help: "A voucher or gift code being redeemed." },
  pilot:       { label: "Pilot / proof of concept", help: "Named prospect evaluating before buying." },
  beta_tester: { label: "Beta tester",              help: "Access in exchange for feedback." },
  goodwill:    { label: "Goodwill",                 help: "Compensation after an outage or our mistake." },
  internal:    { label: "Internal / demo",          help: "Staff, sales demo or test account." },
  billing_fix: { label: "Fixing a billing problem", help: "Payment succeeded through Razorpay but the webhook never arrived." },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: adminRow } = await admin.from("platform_admins")
      .select("user_id").eq("user_id", userId).maybeSingle();
    if (!adminRow) return jsonResponse({ error: "Forbidden: platform admin access only." }, 403);

    let body: any = {};
    try { body = await req.json(); } catch { /* no body is fine */ }
    const action = body?.action ?? "list_plans";

    // ---- list_plans ---------------------------------------------------
    // Feeds the dropdown in the admin portal, and shows at a glance which
    // plans have an online (Razorpay) price.
    if (action === "list_plans") {
      const { data: plans, error } = await admin.from("plans")
        .select("id, name, price_usd, price_inr, max_drawing_pages, is_trial")
        .order("price_usd", { nullsFirst: true });
      if (error) throw error;
      return jsonResponse({ plans: plans ?? [] });
    }

    if (action === "list_reasons") {
      return jsonResponse({
        reasons: Object.entries(GRANT_REASONS).map(([code, r]) => ({ code, ...r })),
      });
    }

    // ---- set_company_plan ---------------------------------------------
    if (action === "set_company_plan") {
      const targetCompanyId = body?.company_id as string | undefined;
      const newPlanId = body?.plan_id as string | undefined;
      const note = typeof body?.note === "string" && body.note.trim()
        ? body.note.trim().slice(0, 500) : null;
      if (!targetCompanyId) return jsonResponse({ error: "company_id is required." }, 400);
      if (!newPlanId) return jsonResponse({ error: "plan_id is required." }, 400);

      // Validate against the plans table rather than a hardcoded list, so a
      // new plan works here the moment it exists in the database.
      const { data: plan } = await admin.from("plans")
        .select("id, name, is_trial, trial_duration_days").eq("id", newPlanId).maybeSingle();
      if (!plan) return jsonResponse({ error: `Unknown plan "${newPlanId}".` }, 400);

      // A reason is required whenever a paid plan is being granted. Moving a
      // company down to free or back onto trial is a correction, not a grant,
      // so it does not need one.
      const reasonCode = typeof body?.reason_code === "string" ? body.reason_code.trim() : "";
      const grantsPaidPlan = !plan.is_trial && newPlanId !== "free";
      if (grantsPaidPlan) {
        if (!reasonCode || !GRANT_REASONS[reasonCode]) {
          return jsonResponse({
            error: "Choose why this plan is being granted by hand.",
            reasons: Object.entries(GRANT_REASONS).map(([code, r]) => ({ code, ...r })),
          }, 400);
        }
      }
      // How long the grant runs. Required, because the whole point is that it
      // ends by itself.
      let grantDays: number | null = null;
      if (grantsPaidPlan) {
        const d = Math.round(Number(body?.grant_days));
        if (!Number.isFinite(d) || d < 1 || d > MAX_GRANT_DAYS) {
          return jsonResponse({
            error: `Say how many days this access should last (1 to ${MAX_GRANT_DAYS}). A hand-granted plan has to end on its own -- that is what stops a one-month promotion running for a year.`,
          }, 400);
        }
        grantDays = d;
      }

      // Refused outright rather than ignored: a caller sending payment details
      // is trying to record money taken outside Razorpay, and should be told
      // plainly that the platform does not do that.
      if (body?.payment_amount_cents != null || body?.payment_method != null) {
        return jsonResponse({
          error: "Quantora does not record payments taken outside Razorpay. Every manual activation is a "
            + "grant; card payments go through Razorpay.",
        }, 400);
      }

      const { data: co, error: coErr } = await admin.from("companies")
        .select("id, name, plan, trial_end_date, subscription_status, billing_provider")
        .eq("id", targetCompanyId).maybeSingle();
      if (coErr || !co) return jsonResponse({ error: "Company not found." }, 404);

      const previousPlan = co.plan ?? "free";
      if (previousPlan === newPlanId) {
        return jsonResponse({ error: `${co.name} is already on the ${plan.name} plan.` }, 400);
      }

      const update: Record<string, unknown> = { plan: newPlanId };

      if (plan.is_trial) {
        // Moving someone back onto trial only makes sense with a fresh window,
        // otherwise they land on an already-expired trial and every AI action
        // is blocked immediately.
        const days = plan.trial_duration_days ?? 14;
        const now = new Date();
        update.trial_start_date = now.toISOString();
        update.trial_end_date = new Date(now.getTime() + days * 86400000).toISOString();
        update.subscription_status = null;
        update.billing_provider = null;
      } else if (newPlanId === "free") {
        update.subscription_status = null;
        update.billing_provider = null;
      } else {
        // A paid plan set by hand is marked 'manual' rather than 'active', so
        // the admin portal can tell an admin-activated account apart from one
        // that genuinely paid through Razorpay. A later real Razorpay payment
        // overwrites this with the true provider and status.
        update.subscription_status = "manual";
        update.billing_provider = "manual";
        update.manual_grant_reason = reasonCode || null;
        update.manual_grant_at = new Date().toISOString();
        update.manual_grant_expires_at =
          new Date(Date.now() + (grantDays ?? 30) * 86400000).toISOString();
        // Where to fall back to. Whatever they were on before the grant --
        // usually an expired trial, which correctly leaves them blocked until
        // they actually subscribe.
        update.manual_grant_previous_plan = previousPlan;
      }
      if (plan.is_trial || newPlanId === "free") {
        update.manual_grant_reason = null;
        update.manual_grant_at = null;
        update.manual_grant_expires_at = null;
        update.manual_grant_previous_plan = null;
      }

      const { error: updErr } = await admin.from("companies").update(update).eq("id", targetCompanyId);
      if (updErr) throw updErr;

      // Audit row. amount is 0 because this adjustment is categorical, not
      // numeric — previous_value/new_value carry the meaning.
      const { error: auditErr } = await admin.from("admin_quota_adjustments").insert({
        company_id: targetCompanyId,
        admin_user_id: userId,
        adjustment_type: "plan_changed",
        amount: 0,
        previous_value: previousPlan,
        new_value: newPlanId,
        reason_code: reasonCode || null,
        note: grantDays
          ? `${note ? note + " — " : ""}Access for ${grantDays} day${grantDays === 1 ? "" : "s"}, then reverts to ${previousPlan}.`
          : note,
      });
      if (auditErr) {
        // The plan change already succeeded; losing the audit row is bad but
        // not worth reverting a customer's access over. Surface it instead.
        console.error("set_company_plan: audit insert failed --", describeError(auditErr));
      }

      return jsonResponse({
        company_id: targetCompanyId,
        company_name: co.name,
        reason_code: reasonCode || null,
        grant_days: grantDays,
        grant_expires_at: update.manual_grant_expires_at ?? null,
        reverts_to: update.manual_grant_previous_plan ?? null,
        previous_plan: previousPlan,
        plan: newPlanId,
        plan_name: plan.name,
        subscription_status: update.subscription_status ?? null,
        billing_provider: update.billing_provider ?? null,
        trial_end_date: update.trial_end_date ?? null,
        audit_recorded: !auditErr,
      });
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("admin-plan error:", describeError(err));
    return jsonResponse({ error: describeError(err) }, 500);
  }
});
