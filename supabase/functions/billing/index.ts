// Customer-facing billing + account actions.
//
// v3 adds two new actions that do NOT require Stripe to be configured
// (bootstrap_company, usage_summary) — these must work today, before any
// Stripe secret exists, since bootstrap_company is called by the frontend
// right after every sign-in. The existing Stripe-dependent actions
// (create_topup_session, create_checkout_session, create_portal_session)
// are unchanged except that the STRIPE_SECRET_KEY lookup is now lazy —
// only fetched when one of those three actions actually runs — instead of
// gating every single billing call, which previously would have made
// bootstrap_company impossible to call before Stripe was set up.
//
// JWT-verified (verify_jwt: true) — only a signed-in user can call this.
//
// 2026-10-27: first copy of this function kept in the repo (v8 was deployed
// from outside it). usage_summary now counts pages exactly the way ai-engine's
// checkPlanLimit() enforces them: tiled and combined runs included, admin-
// assisted runs excluded, page_refund rows (pages returned on a report)
// subtracted, bonus pages added to the limit, and the same window for a
// hand-granted plan. Before this the dashboard left out tiled runs -- the
// route most sheets now take -- so it showed fewer pages used than were.

import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.4.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Fixed, server-validated top-up packages (USD). Keeping this as an
// allow-list rather than trusting an arbitrary client-supplied amount
// prevents someone from requesting a $0.01 Checkout session.
const CREDIT_PACKAGES_USD = [10, 25, 50, 100];

// Must match the list in ai-engine checkPlanLimit().
const PAGE_ACTIONS = ["analyze_drawing", "analyze_drawing_tiled", "analyze_drawings_combined", "rework", "page_refund"];

// Email normalisation for the trial-abuse check moved into Postgres
// (normalize_email_for_abuse) on 2026-08-15, so the rule the guard applies
// and the rule this function applied cannot drift apart.


// Company auto-provisioning.
//
// 2026-08-15: this used to read "does a company exist?" and then insert one,
// with no lock. The frontend fires bootstrap_company from more than one place
// on sign-up, so four requests for the same brand-new account all read "no
// company" before any of them wrote one, and all four inserted. One signup
// produced four companies inside 190ms, and the trial-abuse guard was defeated
// the same way -- every request counted zero prior signups for that email.
//
// No rearrangement of this TypeScript can fix that: two concurrent requests can
// always both pass a check made in the application. So the whole thing now
// lives in one Postgres function holding a per-user advisory lock, backed by a
// unique index on companies.created_by_user_id. This helper is a thin call into
// it. That deliberately breaks this codebase's duplicated-per-function
// convention -- correctness here depends on there being exactly one
// implementation, and two copies is what caused the bug.
async function ensureCompanyForUser(admin: any, userId: string, userEmail: string | null | undefined, fullName: string | null | undefined, signupIp: string | null): Promise<string> {
  const { data, error } = await admin.rpc("bootstrap_company_for_user", {
    p_user_id: userId,
    p_email: userEmail ?? null,
    p_full_name: fullName ?? null,
    p_signup_ip: signupIp ?? null,
  });
  if (error) throw error;
  if (!data) throw new Error("bootstrap_company_for_user returned no company id");
  return data as string;
}


function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }
    const userId = userData.user.id;
    // Best-effort client IP for the trial-abuse rate limit in
    // ensureCompanyForUser() — Supabase Edge Functions sit behind a proxy
    // that sets x-forwarded-for; null (not fatal) if it's ever absent.
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: profile } = await admin.from("profiles").select("company_id, full_name, role").eq("id", userId).maybeSingle();
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // v14: accept_invitation MUST be handled before the auto-bootstrap
    // company resolution just below -- otherwise an invited user with no
    // company yet would get a BRAND NEW company auto-created for them (by
    // ensureCompanyForUser) before their invite could ever be redeemed onto
    // the inviting company instead. See "add_company_invites_and_user_limit_
    // enforcement" migration for the enforce_user_limit() DB trigger that
    // backstops the seat check this action also pre-checks.
    if (action === "accept_invitation") {
      const token = String(body.token || "").trim();
      if (!token) return json({ error: "Missing invite token." }, 400);
      if (profile?.company_id) {
        return json({ error: "This account is already part of a company — invite links are only for brand-new accounts." }, 400);
      }
      const { data: invite } = await admin.from("company_invites").select("*").eq("token", token).maybeSingle();
      if (!invite) return json({ error: "This invite link is invalid." }, 400);
      if (invite.accepted_at) return json({ error: "This invite link has already been used." }, 400);
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        return json({ error: "This invite link has expired — ask the company admin to send a new one." }, 400);
      }
      const normalizedInviteEmail = String(invite.email || "").trim().toLowerCase();
      const normalizedUserEmail = String(userData.user.email || "").trim().toLowerCase();
      if (normalizedInviteEmail && normalizedUserEmail && normalizedInviteEmail !== normalizedUserEmail) {
        return json({ error: `This invite was sent to ${invite.email} — sign in with that email address to accept it.` }, 400);
      }
      const seatErr = (msg: string) => msg.includes("USER_LIMIT_REACHED")
        ? "This company's plan has reached its user limit — ask the company admin to upgrade the plan before accepting."
        : msg;
      if (profile) {
        const { error: updErr } = await admin.from("profiles").update({ company_id: invite.company_id, role: "member" }).eq("id", userId);
        if (updErr) return json({ error: seatErr(updErr.message) }, 400);
      } else {
        const { error: insErr } = await admin.from("profiles").insert({ id: userId, company_id: invite.company_id, role: "member" });
        if (insErr) return json({ error: seatErr(insErr.message) }, 400);
      }
      await admin.from("company_invites").update({ accepted_at: new Date().toISOString(), accepted_by: userId }).eq("id", invite.id);
      const { data: joinedCompany } = await admin.from("companies").select("plan").eq("id", invite.company_id).maybeSingle();
      return json({ company_id: invite.company_id, plan: joinedCompany?.plan, joined: true });
    }

    const companyId = profile?.company_id ?? (await ensureCompanyForUser(admin, userId, userData.user.email, profile?.full_name ?? body.company_name, clientIp));
    const { data: company } = await admin.from("companies").select("*").eq("id", companyId).maybeSingle();
    if (!company) return json({ error: "Company not found." }, 404);

    // -----------------------------------------------------------------
    // bootstrap_company: called eagerly by the frontend right after every
    // sign-in/sign-up so the trial clock starts at registration, not on
    // first AI use. Idempotent — ensureCompanyForUser() above already
    // resolved (or created) the company by the time we get here, so this
    // action is just "return what we've got".
    // -----------------------------------------------------------------
    if (action === "bootstrap_company") {
      return json({ company_id: company.id, plan: company.plan, trial_start_date: company.trial_start_date, trial_end_date: company.trial_end_date });
    }

    // -----------------------------------------------------------------
    // usage_summary: single source of truth for "current usage vs. plan
    // limits", used by the real-time trial usage dashboard widget. Counts
    // here intentionally mirror ai-engine's checkPlanLimit() dimensions
    // (drawing_page / rework / chat) plus the project-count trigger's
    // logic, so what the dashboard shows always matches what's actually
    // enforced.
    // -----------------------------------------------------------------
    if (action === "usage_summary") {
      const { data: plan } = await admin.from("plans").select("*").eq("id", company.plan ?? "free").maybeSingle();

      const { count: projectsCount } = await admin.from("projects").select("id", { count: "exact", head: true }).eq("company_id", companyId);

      const { data: projectRows } = await admin.from("projects").select("id").eq("company_id", companyId);
      const projectIds = (projectRows ?? []).map((p: any) => p.id);
      let reworkCount = 0;
      if (projectIds.length) {
        const { data: drawingRows } = await admin.from("drawings").select("id").in("project_id", projectIds);
        const drawingIds = (drawingRows ?? []).map((d: any) => d.id);
        if (drawingIds.length) {
          const { count } = await admin.from("analysis_runs").select("id", { count: "exact", head: true })
            .in("drawing_id", drawingIds).not("change_reason", "is", null);
          reworkCount = count ?? 0;
        }
      }

      // Same window as ai-engine computeWindowStart().
      const windowStart = plan?.quota_period === "trial_window"
        ? (company.trial_start_date ? new Date(company.trial_start_date) : new Date(company.created_at))
        : (company.billing_provider === "manual" && company.manual_grant_at && !Number.isNaN(new Date(company.manual_grant_at).getTime()))
          ? new Date(company.manual_grant_at)
          : (() => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d; })();

      const { data: pageRows } = await admin.from("ai_usage").select("page_count")
        .eq("company_id", companyId).gte("created_at", windowStart.toISOString())
        .in("action", PAGE_ACTIONS).eq("is_admin_assisted", false);
      const pagesUsed = Math.max(0, (pageRows ?? []).reduce((s: number, r: any) => s + (r.page_count ?? 0), 0));
      const pagesLimit = plan?.max_drawing_pages == null ? null : plan.max_drawing_pages + Number(company.bonus_drawing_pages || 0);

      const { count: chatCount } = await admin.from("ai_usage").select("id", { count: "exact", head: true })
        .eq("company_id", companyId).gte("created_at", windowStart.toISOString()).eq("action", "chat");

      const now = Date.now();
      const trialEndMs = company.trial_end_date ? new Date(company.trial_end_date).getTime() : null;
      const daysRemaining = trialEndMs != null ? Math.max(0, Math.ceil((trialEndMs - now) / (24 * 60 * 60 * 1000))) : null;
      const trialExpired = plan?.is_trial && trialEndMs != null && trialEndMs < now;

      return json({
        plan: { id: plan?.id, name: plan?.name, is_trial: !!plan?.is_trial },
        projects: { used: projectsCount ?? 0, limit: plan?.max_projects ?? null },
        pages: { used: pagesUsed, limit: pagesLimit },
        rework: { used: reworkCount, limit: plan?.max_rework_per_project ?? null },
        chat: { used: chatCount ?? 0, limit: plan?.max_chat_requests ?? null },
        trial_start_date: company.trial_start_date,
        trial_end_date: company.trial_end_date,
        trial_days_remaining: daysRemaining,
        trial_expired: !!trialExpired,
        credit_balance_cents: company.credit_balance_cents ?? 0,
      });
    }

    // -----------------------------------------------------------------
    // create_invite / list_team: seat/user management. Added 2026-08-01
    // alongside the enforce_user_limit() DB trigger (plans.max_users was
    // stored since the trial system was built but never actually enforced
    // or reachable — there was no way to add a second user to a company at
    // all). Deliberately does NOT send email itself — no email-sending
    // service is configured for this platform (same "no new paid
    // dependency" reasoning as the DWG/RVT "attach export" design) — the
    // caller copies the returned link and sends it themselves.
    // -----------------------------------------------------------------
    if (action === "create_invite") {
      const isAdmin = (profile?.role ?? "admin") === "admin";
      if (!isAdmin) {
        return json({ error: "Only a company admin can invite teammates." }, 403);
      }
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json({ error: "Enter a valid email address." }, 400);

      const { data: invitePlan } = await admin.from("plans").select("max_users").eq("id", company.plan ?? "free").maybeSingle();
      if (invitePlan?.max_users != null) {
        const { count: memberCount } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("company_id", companyId);
        if ((memberCount ?? 0) >= invitePlan.max_users) {
          return json({ error: `Your plan allows ${invitePlan.max_users} user(s) and you already have ${memberCount ?? 0}. Upgrade your plan to add more.` }, 400);
        }
      }

      const token = crypto.randomUUID().replace(/-/g, "");
      const { data: invite, error: inviteErr } = await admin.from("company_invites")
        .insert({ company_id: companyId, email, token, invited_by: userId })
        .select().single();
      if (inviteErr) return json({ error: inviteErr.message }, 400);

      const inviteOrigin = req.headers.get("origin") || new URL(req.url).origin;
      return json({
        invite_id: invite.id,
        invite_link: `${inviteOrigin}/?invite=${token}`,
        expires_at: invite.expires_at,
        note: "Quantora doesn't email this invite for you — copy the link and send it to your teammate yourself.",
      });
    }

    if (action === "list_team") {
      const { data: members } = await admin.from("profiles").select("id, full_name, role, created_at").eq("company_id", companyId).order("created_at");
      const { data: pendingInvites } = await admin.from("company_invites")
        .select("id, email, created_at, expires_at")
        .eq("company_id", companyId).is("accepted_at", null).gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });
      const { data: teamPlan } = await admin.from("plans").select("max_users").eq("id", company.plan ?? "free").maybeSingle();
      return json({ members: members ?? [], pending_invites: pendingInvites ?? [], max_users: teamPlan?.max_users ?? null });
    }

    // -----------------------------------------------------------------
    // Everything below this point is Stripe-dependent — the secret is
    // fetched lazily here, not at the top of the function, so
    // bootstrap_company/usage_summary work even before Stripe is set up.
    // -----------------------------------------------------------------
    const { data: secretRow } = await admin.from("app_secrets").select("value").eq("key", "STRIPE_SECRET_KEY").maybeSingle();
    if (!secretRow?.value) {
      return json({ error: "Billing not configured: STRIPE_SECRET_KEY secret missing." }, 500);
    }
    const stripe = new Stripe(secretRow.value, { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });
    const origin = req.headers.get("origin") || new URL(req.url).origin;

    async function ensureStripeCustomer(): Promise<string> {
      if (company.stripe_customer_id) return company.stripe_customer_id;
      const customer = await stripe.customers.create({
        email: userData.user.email ?? undefined,
        name: company.name ?? profile?.full_name ?? undefined,
        metadata: { company_id: company.id },
      });
      await admin.from("companies").update({ stripe_customer_id: customer.id }).eq("id", company.id);
      return customer.id;
    }

    if (action === "create_topup_session") {
      const amountUsd = Number(body.amount_usd);
      if (!CREDIT_PACKAGES_USD.includes(amountUsd)) {
        return json({ error: `Invalid top-up amount. Choose one of: $${CREDIT_PACKAGES_USD.join(", $")}.` }, 400);
      }
      const amountCents = Math.round(amountUsd * 100);
      const customerId = await ensureStripeCustomer();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: `AI usage credits — $${amountUsd}` },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancel`,
        metadata: { type: "credit_topup", company_id: company.id, credit_amount_cents: String(amountCents) },
      });
      return json({ url: session.url });
    }

    if (action === "create_checkout_session") {
      const planId = body.plan_id as string;
      const { data: plan } = await admin.from("plans").select("*").eq("id", planId).maybeSingle();
      if (!plan) return json({ error: "Unknown plan." }, 400);
      if (!plan.stripe_price_id) {
        return json({ error: `The ${plan.name} plan is not available for self-serve checkout. Contact sales.` }, 400);
      }

      const customerId = await ensureStripeCustomer();
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancel`,
        subscription_data: { metadata: { plan_id: planId, company_id: company.id } },
        metadata: { plan_id: planId, company_id: company.id },
      });
      return json({ url: session.url });
    }

    if (action === "create_portal_session") {
      if (!company.stripe_customer_id) {
        return json({ error: "No billing account yet — buy credits or subscribe to a plan first." }, 400);
      }
      const session = await stripe.billingPortal.sessions.create({
        customer: company.stripe_customer_id,
        return_url: `${origin}/`,
      });
      return json({ url: session.url });
    }

    return json({ error: `Unknown billing action: ${action}` }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: String(err?.message || err) }, 500);
  }
});
