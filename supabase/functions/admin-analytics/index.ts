// AI Construction Engineering Platform — Admin Analytics Edge Function
// Platform-owner-only. Reports AI cost (true Anthropic COGS), revenue (MRR +
// wallet top-ups), tokens/pages processed, and per-customer/per-project
// gross margin, so pricing can be tuned against real usage instead of
// estimates. Access is gated by membership in public.platform_admins —
// completely separate from the per-company profiles.role field, which only
// ever grants access within a single company.
//
// v2 adds action "trial_overview": trial-company counts, conversion rate,
// per-trial-company average pages/cost/projects, most-requested systems,
// and a per-company trial cost / suggested-upgrade / conversion table —
// per the Free Trial Usage Control build. Unlike "overview" (calendar-
// month-scoped), trial_overview looks at each company's ENTIRE lifetime of
// usage, since a 14-day trial doesn't line up with calendar months.
//
// v3 adds "list_companies" / "list_projects" / "list_drawings" — lightweight
// lookups that back the Admin Assist tool (frontend AdminDashboard): letting
// a platform admin pick a real customer's project/drawing to run AI work
// against on their behalf via ai-engine's admin_override path, without
// having to know IDs ahead of time.
//
// v4 adds "system_status" (real Anthropic/Razorpay secret-configured booleans,
// no values ever returned — plus real platform counts and total storage
// bytes, backing the redesigned admin portal's System Health tab) and
// "reports_export" (consolidated raw data for the Reports & Exports panel's
// .xlsx downloads: payments/wallet top-ups, subscription-type mix, trial
// summary, day-by-day Claude AI cost, and per-company storage usage). Both
// are read-only aggregations of existing tables — no new schema needed.
//
// v6 (2026-08-12) adds "pipeline_overview": how much work is going through
// the new Estimation, Cost & Budget, Tender Intelligence, RFQ, Comparison and
// Approvals pages, what that work is worth, and which customers are actually
// using each of them. Pure aggregation of tables the customer already owns —
// no AI call, no new schema.
//
// v5 (2026-08-10) adds "grant_bonus_pages" / "extend_trial" /
// "list_quota_adjustments" — a platform-admin testing/support tool. Lets an
// admin grant one specific company extra AI-processed pages (on top of
// their plan's normal max_drawing_pages) or push out a trial's end date,
// WITHOUT touching the plan-wide rule every other customer gets (the
// trial plan's own 30-page default is untouched — see companies.
// bonus_drawing_pages' column comment and ai-engine's checkPlanLimit()).
// Every adjustment is written to admin_quota_adjustments for a full audit
// trail, same "never silently mutate a customer-facing limit" discipline
// already used for cost_optimizations/boq_assumptions/boq_review_items.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
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
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const userId = userData.user.id;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: adminRow } = await admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
    if (!adminRow) {
      return jsonResponse({ error: "Forbidden: platform admin access only." }, 403);
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* GET-style calls with no body are fine */ }
    const action = body?.action ?? "overview";

    if (action === "is_admin") {
      return jsonResponse({ is_admin: true });
    }

    // -----------------------------------------------------------------
    // v3: Admin Assist lookups. Deliberately minimal fields — just enough
    // for a picker UI, not a full data dump. Every list is scoped by the
    // caller supplying the parent ID (company_id for projects, project_id
    // for drawings) rather than returning everything at once.
    //
    // v5: list_companies also returns bonus_drawing_pages (the admin's own
    // per-company page override) and plan_max_drawing_pages (that
    // company's plan's own default, joined in so the frontend can show
    // "plan default + bonus = effective limit" without a second call).
    // -----------------------------------------------------------------
    if (action === "list_companies") {
      const [{ data: companies, error }, { data: plans }] = await Promise.all([
        admin.from("companies").select("id, name, plan, trial_end_date, bonus_drawing_pages").order("name"),
        admin.from("plans").select("id, max_drawing_pages"),
      ]);
      if (error) throw error;
      const maxPagesByPlan: Record<string, number | null> = {};
      for (const p of plans ?? []) maxPagesByPlan[p.id] = p.max_drawing_pages ?? null;
      const enriched = (companies ?? []).map((c: any) => ({
        ...c,
        plan_max_drawing_pages: maxPagesByPlan[c.plan] ?? null,
      }));
      return jsonResponse({ companies: enriched });
    }

    if (action === "list_projects") {
      const companyId = body?.company_id as string | undefined;
      if (!companyId) return jsonResponse({ error: "company_id is required." }, 400);
      const { data: projects, error } = await admin
        .from("projects")
        .select("id, project_name, building_type, city, country")
        .eq("company_id", companyId)
        .order("project_name");
      if (error) throw error;
      return jsonResponse({ projects: projects ?? [] });
    }

    if (action === "list_drawings") {
      const projectId = body?.project_id as string | undefined;
      if (!projectId) return jsonResponse({ error: "project_id is required." }, 400);
      const { data: drawings, error } = await admin
        .from("drawings")
        .select("id, file_name, discipline, floor_label, classification_status")
        .eq("project_id", projectId)
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      return jsonResponse({ drawings: drawings ?? [] });
    }

    // -----------------------------------------------------------------
    // v5: platform-admin quota overrides, for testing/support only. Both
    // mutating actions write an audit row to admin_quota_adjustments
    // before returning, and neither touches plans.max_drawing_pages or
    // plans.trial_duration_days — the standard rule every other customer
    // gets is completely untouched by either action.
    // -----------------------------------------------------------------
    if (action === "grant_bonus_pages") {
      const targetCompanyId = body?.company_id as string | undefined;
      const additionalPages = Number(body?.additional_pages);
      const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
      if (!targetCompanyId) return jsonResponse({ error: "company_id is required." }, 400);
      if (!Number.isFinite(additionalPages) || additionalPages === 0) {
        return jsonResponse({ error: "additional_pages must be a non-zero number (e.g. 20, or -10 to reduce a previous grant)." }, 400);
      }
      const { data: co, error: coErr } = await admin.from("companies").select("id, bonus_drawing_pages").eq("id", targetCompanyId).maybeSingle();
      if (coErr || !co) return jsonResponse({ error: "Company not found." }, 404);
      const previous = co.bonus_drawing_pages ?? 0;
      // Never let a reduction push the bonus negative -- 0 is the real floor
      // (the plan's own default is always what "no bonus" means).
      const next = Math.max(0, previous + additionalPages);
      const { error: updErr } = await admin.from("companies").update({ bonus_drawing_pages: next }).eq("id", targetCompanyId);
      if (updErr) throw updErr;
      await admin.from("admin_quota_adjustments").insert({
        company_id: targetCompanyId, admin_user_id: userId, adjustment_type: "bonus_pages_granted",
        amount: additionalPages, note, previous_value: String(previous), new_value: String(next),
      });
      return jsonResponse({ company_id: targetCompanyId, bonus_drawing_pages: next });
    }

    if (action === "extend_trial") {
      const targetCompanyId = body?.company_id as string | undefined;
      const additionalDays = Number(body?.additional_days);
      const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
      if (!targetCompanyId) return jsonResponse({ error: "company_id is required." }, 400);
      if (!Number.isFinite(additionalDays) || additionalDays <= 0) {
        return jsonResponse({ error: "additional_days must be a positive number." }, 400);
      }
      const { data: co, error: coErr } = await admin.from("companies").select("id, plan, trial_end_date").eq("id", targetCompanyId).maybeSingle();
      if (coErr || !co) return jsonResponse({ error: "Company not found." }, 404);
      if (co.plan !== "trial") {
        return jsonResponse({ error: "This company is not currently on the trial plan, so there is no trial end date to extend." }, 400);
      }
      const previousEnd = co.trial_end_date ? new Date(co.trial_end_date) : new Date();
      // Extend from whichever is later: the existing end date (so repeated
      // small extensions stack instead of overwriting each other) or now
      // (so extending an already-expired trial doesn't compute a nonsense
      // past date from a stale trial_end_date).
      const base = previousEnd.getTime() > Date.now() ? previousEnd : new Date();
      const nextEnd = new Date(base.getTime() + additionalDays * 24 * 60 * 60 * 1000);
      const { error: updErr } = await admin.from("companies").update({ trial_end_date: nextEnd.toISOString() }).eq("id", targetCompanyId);
      if (updErr) throw updErr;
      await admin.from("admin_quota_adjustments").insert({
        company_id: targetCompanyId, admin_user_id: userId, adjustment_type: "trial_extended",
        amount: additionalDays, note, previous_value: co.trial_end_date, new_value: nextEnd.toISOString(),
      });
      return jsonResponse({ company_id: targetCompanyId, trial_end_date: nextEnd.toISOString() });
    }

    if (action === "list_quota_adjustments") {
      const targetCompanyId = body?.company_id as string | undefined;
      if (!targetCompanyId) return jsonResponse({ error: "company_id is required." }, 400);
      const { data, error } = await admin
        .from("admin_quota_adjustments")
        .select("*")
        .eq("company_id", targetCompanyId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return jsonResponse({ adjustments: data ?? [] });
    }

    if (action === "trial_overview") {
      const [{ data: companies }, { data: plans }, { data: usageAll }, { data: projectsAll }, { data: pagesAll }] = await Promise.all([
        admin.from("companies").select("id, name, plan, trial_start_date, trial_end_date, created_at"),
        admin.from("plans").select("id, name, price_usd"),
        admin.from("ai_usage").select("company_id, action, actual_cost_cents, page_count"),
        admin.from("projects").select("id, company_id"),
        admin.from("drawing_pages").select("detected_system_category, selected"),
      ]);

      const planPriceUsdById: Record<string, number> = {};
      for (const p of plans ?? []) planPriceUsdById[p.id] = Number(p.price_usd ?? 0);
      const suggestedUpgradePrice = planPriceUsdById["professional"] ?? null;

      const now = Date.now();
      const everTrial = (companies ?? []).filter((c: any) => c.trial_start_date != null);
      const currentlyOnTrial = (companies ?? []).filter((c: any) => c.plan === "trial");
      const converted = everTrial.filter((c: any) => c.plan !== "trial");
      const conversionRatePct = everTrial.length ? (converted.length / everTrial.length) * 100 : null;

      const costByCompany: Record<string, number> = {};
      const pagesByCompany: Record<string, number> = {};
      for (const u of usageAll ?? []) {
        if (!u.company_id) continue;
        costByCompany[u.company_id] = (costByCompany[u.company_id] ?? 0) + (u.actual_cost_cents ?? 0);
        if (u.action === "analyze_drawing" || u.action === "rework") {
          pagesByCompany[u.company_id] = (pagesByCompany[u.company_id] ?? 0) + (u.page_count ?? 0);
        }
      }
      const projectsByCompany: Record<string, number> = {};
      for (const p of projectsAll ?? []) {
        if (!p.company_id) continue;
        projectsByCompany[p.company_id] = (projectsByCompany[p.company_id] ?? 0) + 1;
      }

      const avg = (nums: number[]) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null);
      const avgPagesProcessed = avg(everTrial.map((c: any) => pagesByCompany[c.id] ?? 0));
      const avgAiCostUsdPerTrial = avg(everTrial.map((c: any) => (costByCompany[c.id] ?? 0) / 100));
      const avgProjectsPerTrial = avg(everTrial.map((c: any) => projectsByCompany[c.id] ?? 0));

      const systemCounts: Record<string, number> = {};
      for (const dp of pagesAll ?? []) {
        if (!dp.selected || !dp.detected_system_category) continue;
        systemCounts[dp.detected_system_category] = (systemCounts[dp.detected_system_category] ?? 0) + 1;
      }
      const mostRequestedSystems = Object.entries(systemCounts)
        .map(([system_category, pages_selected]) => ({ system_category, pages_selected }))
        .sort((a, b) => b.pages_selected - a.pages_selected)
        .slice(0, 10);

      const perTrialCompany = everTrial
        .map((c: any) => {
          const isConverted = c.plan !== "trial";
          const isExpired = !isConverted && c.trial_end_date && new Date(c.trial_end_date).getTime() < now;
          return {
            company_id: c.id,
            company_name: c.name,
            trial_cost_usd: Number(((costByCompany[c.id] ?? 0) / 100).toFixed(2)),
            projects_count: projectsByCompany[c.id] ?? 0,
            pages_processed: pagesByCompany[c.id] ?? 0,
            potential_subscription_usd_per_month: suggestedUpgradePrice,
            conversion_status: isConverted ? "Converted" : isExpired ? "Expired" : "Pending",
            current_plan: c.plan,
            trial_start_date: c.trial_start_date,
            trial_end_date: c.trial_end_date,
          };
        })
        .sort((a, b) => b.trial_cost_usd - a.trial_cost_usd);

      return jsonResponse({
        trial_companies_count: currentlyOnTrial.length,
        ever_trial_companies_count: everTrial.length,
        converted_companies_count: converted.length,
        conversion_rate_pct: conversionRatePct,
        avg_pages_processed_per_trial: avgPagesProcessed,
        avg_ai_cost_usd_per_trial: avgAiCostUsdPerTrial,
        avg_projects_per_trial: avgProjectsPerTrial,
        most_requested_systems: mostRequestedSystems,
        per_trial_company: perTrialCompany,
      });
    }

    // -----------------------------------------------------------------
    // v4: System Health — real signal only. "Configured" booleans check
    // for the SECRET'S PRESENCE in app_secrets, never its value, so this
    // can never leak a key. Everything else is a real live count.
    // -----------------------------------------------------------------
    if (action === "system_status") {
      const [{ data: secrets }, { count: companiesCount }, { count: projectsCount }, { count: drawingsCount }, { data: storageTotals }] = await Promise.all([
        admin.from("app_secrets").select("key, value").in("key", ["ANTHROPIC_API_KEY", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_CURRENCY"]),
        admin.from("companies").select("id", { count: "exact", head: true }),
        admin.from("projects").select("id", { count: "exact", head: true }),
        admin.from("drawings").select("id", { count: "exact", head: true }),
        // storage.objects is not exposed over REST; a service-role-only function reads it.
        admin.rpc("admin_storage_totals"),
      ]);

      // Only presence is reported, plus two values that are not secret: the
      // key id's mode prefix (rzp_live_ / rzp_test_) and the billing currency.
      const secretVal: Record<string, string> = {};
      for (const s of secrets ?? []) secretVal[s.key] = String(s.value ?? "").trim();
      const has = (k: string) => !!secretVal[k];
      const keyId = secretVal["RAZORPAY_KEY_ID"] ?? "";
      const razorpayMode = keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : (keyId ? "unknown" : null);
      const st = Array.isArray(storageTotals) ? storageTotals[0] : storageTotals;
      const totalStorageBytes = Number(st?.total_bytes ?? 0);

      return jsonResponse({
        anthropic_key_configured: has("ANTHROPIC_API_KEY"),
        razorpay_keys_configured: has("RAZORPAY_KEY_ID") && has("RAZORPAY_KEY_SECRET"),
        razorpay_webhook_secret_configured: has("RAZORPAY_WEBHOOK_SECRET"),
        razorpay_mode: razorpayMode,
        razorpay_currency: (secretVal["RAZORPAY_CURRENCY"] || "USD").toUpperCase(),
        companies_count: companiesCount ?? 0,
        projects_count: projectsCount ?? 0,
        drawings_count: drawingsCount ?? 0,
        total_storage_bytes: totalStorageBytes,
        total_storage_objects: Number(st?.total_objects ?? 0),
        checked_at: new Date().toISOString(),
      });
    }

    // -----------------------------------------------------------------
    // v4: Reports & Exports — raw rows for the frontend's .xlsx builder.
    // Deliberately returns full detail (not just aggregates) for the
    // reports that are inherently a list (payments, per-company storage),
    // and both daily granularity and totals for AI cost, so a single
    // fetch can back every sheet in the "Full Report" workbook without
    // extra round-trips.
    // -----------------------------------------------------------------
    if (action === "reports_export") {
      const [
        { data: companies },
        { data: plans },
        { data: topups },
        { data: usageAll },
        { data: projectsAll },
        { data: drawingsAll },
        { data: storageObjs },
      ] = await Promise.all([
        admin.from("companies").select("id, name, plan, subscription_status, credit_balance_cents, trial_start_date, trial_end_date, created_at"),
        admin.from("plans").select("id, name, price_usd"),
        admin.from("credit_transactions").select("id, company_id, type, amount_cents, balance_after_cents, description, paddle_transaction_id, stripe_payment_intent_id, created_at").order("created_at", { ascending: false }),
        admin.from("ai_usage").select("company_id, created_at, actual_cost_cents, cost_cents, input_tokens, output_tokens, page_count, model_used, is_admin_assisted"),
        admin.from("projects").select("id, company_id"),
        admin.from("drawings").select("id, project_id, storage_path"),
        admin.rpc("admin_storage_objects"),
      ]);

      const companyNameById: Record<string, string> = {};
      for (const c of companies ?? []) companyNameById[c.id] = c.name;
      const planPriceUsdById: Record<string, number> = {};
      for (const p of plans ?? []) planPriceUsdById[p.id] = Number(p.price_usd ?? 0);

      // --- Payments received (every wallet transaction, all types) ---
      const payments = (topups ?? []).map((t: any) => ({
        date: t.created_at,
        company_id: t.company_id,
        company_name: t.company_id ? (companyNameById[t.company_id] ?? "Unknown") : "—",
        type: t.type,
        amount_usd: Number(((t.amount_cents ?? 0) / 100).toFixed(2)),
        balance_after_usd: Number(((t.balance_after_cents ?? 0) / 100).toFixed(2)),
        description: t.description ?? "",
        // Older top-ups were taken by an earlier provider; keep their reference.
        payment_reference: t.paddle_transaction_id ?? t.stripe_payment_intent_id ?? "",
      }));
      const totalPaymentsReceivedUsd = payments.filter((p: any) => p.type === "topup" || p.type === "bonus")
        .reduce((s: number, p: any) => s + Math.max(0, p.amount_usd), 0);

      // --- Subscription / plan mix ---
      const planCounts: Record<string, { plan: string; company_count: number; active_count: number; monthly_revenue_usd: number }> = {};
      for (const c of companies ?? []) {
        const key = c.plan ?? "unknown";
        if (!planCounts[key]) planCounts[key] = { plan: key, company_count: 0, active_count: 0, monthly_revenue_usd: 0 };
        planCounts[key].company_count += 1;
        if (c.subscription_status === "active") {
          planCounts[key].active_count += 1;
          planCounts[key].monthly_revenue_usd += planPriceUsdById[c.plan] ?? 0;
        }
      }
      const subscriptionMix = Object.values(planCounts).sort((a, b) => b.company_count - a.company_count);

      // --- Trial summary (counts only here; per-company detail comes from trial_overview) ---
      const now = Date.now();
      const everTrial = (companies ?? []).filter((c: any) => c.trial_start_date != null);
      const currentlyOnTrial = (companies ?? []).filter((c: any) => c.plan === "trial");
      const converted = everTrial.filter((c: any) => c.plan !== "trial");
      const expiredNotConverted = everTrial.filter((c: any) => c.plan === "trial" && c.trial_end_date && new Date(c.trial_end_date).getTime() < now);
      const trialSummary = {
        trial_number_ever: everTrial.length,
        trial_number_active: currentlyOnTrial.length,
        trial_expired_not_converted: expiredNotConverted.length,
        trial_converted_to_subscription: converted.length,
        conversion_rate_pct: everTrial.length ? Number(((converted.length / everTrial.length) * 100).toFixed(1)) : null,
      };
      const trialCompanyDetail = everTrial.map((c: any) => ({
        company_id: c.id,
        company_name: c.name,
        trial_start_date: c.trial_start_date,
        trial_end_date: c.trial_end_date,
        current_plan: c.plan,
        status: c.plan !== "trial" ? "Converted" : (c.trial_end_date && new Date(c.trial_end_date).getTime() < now ? "Expired" : "Active trial"),
      }));

      // --- Claude AI cost, day by day ---
      const dayKey = (iso: string) => iso.slice(0, 10);
      const byDay: Record<string, { date: string; requests: number; input_tokens: number; output_tokens: number; page_count: number; actual_cost_usd: number; billed_equivalent_usd: number }> = {};
      for (const u of usageAll ?? []) {
        const d = dayKey(u.created_at);
        if (!byDay[d]) byDay[d] = { date: d, requests: 0, input_tokens: 0, output_tokens: 0, page_count: 0, actual_cost_usd: 0, billed_equivalent_usd: 0 };
        byDay[d].requests += 1;
        byDay[d].input_tokens += u.input_tokens ?? 0;
        byDay[d].output_tokens += u.output_tokens ?? 0;
        byDay[d].page_count += u.page_count ?? 0;
        byDay[d].actual_cost_usd += (u.actual_cost_cents ?? 0) / 100;
        byDay[d].billed_equivalent_usd += (u.cost_cents ?? 0) / 100;
      }
      const aiCostDaily = Object.values(byDay)
        .map((r) => ({ ...r, actual_cost_usd: Number(r.actual_cost_usd.toFixed(4)), billed_equivalent_usd: Number(r.billed_equivalent_usd.toFixed(4)) }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const totalActualCostUsd = (usageAll ?? []).reduce((s: number, u: any) => s + (u.actual_cost_cents ?? 0), 0) / 100;

      // --- Storage usage, by company (via drawings.storage_path -> storage.objects.name) ---
      const projectToCompany: Record<string, string | null> = {};
      for (const p of projectsAll ?? []) projectToCompany[p.id] = p.company_id;
      const pathToCompany: Record<string, string | null> = {};
      for (const d of drawingsAll ?? []) {
        if (d.storage_path) pathToCompany[d.storage_path] = projectToCompany[d.project_id] ?? null;
      }
      const storageByCompanyBytes: Record<string, number> = {};
      let unattributedBytes = 0;
      let totalStorageBytes = 0;
      for (const o of storageObjs ?? []) {
        const size = Number(o?.size ?? 0);
        totalStorageBytes += size;
        const companyId = pathToCompany[o.name];
        if (companyId) storageByCompanyBytes[companyId] = (storageByCompanyBytes[companyId] ?? 0) + size;
        else unattributedBytes += size;
      }
      const storageByCompany = Object.entries(storageByCompanyBytes)
        .map(([company_id, bytes]) => ({ company_id, company_name: companyNameById[company_id] ?? "Unknown", storage_mb: Number((bytes / (1024 * 1024)).toFixed(2)) }))
        .sort((a, b) => b.storage_mb - a.storage_mb);

      return jsonResponse({
        generated_at: new Date().toISOString(),
        payments,
        total_payments_received_usd: Number(totalPaymentsReceivedUsd.toFixed(2)),
        subscription_mix: subscriptionMix,
        trial_summary: trialSummary,
        trial_company_detail: trialCompanyDetail,
        ai_cost_daily: aiCostDaily,
        total_ai_cost_usd_all_time: Number(totalActualCostUsd.toFixed(2)),
        storage_by_company: storageByCompany,
        total_storage_mb: Number((totalStorageBytes / (1024 * 1024)).toFixed(2)),
        unattributed_storage_mb: Number((unattributedBytes / (1024 * 1024)).toFixed(2)),
      });
    }

    // -----------------------------------------------------------------
    // v6 (2026-08-12): "pipeline_overview" — how much work is actually
    // going through the new estimating and procurement pages, and what
    // it is worth. Everything here is an aggregation of tables the
    // customer already owns; nothing is inferred and nothing calls Claude.
    //
    // Pipeline value is computed exactly the way the Estimation page
    // computes one project's selling price, so the admin figure and the
    // customer's own screen can never disagree:
    //   material  = per-system BOQ quantity x unit_cost_cents, unless the
    //               estimator typed a package price over that system
    //               (estimate_labour.material_override_cents wins)
    //   install   = team_size x days x day_rate_cents, or the
    //               subcontractor price when method = 'sub'
    //   staff     = headcount x months x monthly_cost_cents
    //   selling   = (material + install + staff) x (1 + margin_pct/100)
    // A project with no project_estimates row is not counted at all —
    // an unpriced project is not a zero-value project, and reporting it
    // as one would drag the averages down with fiction.
    // -----------------------------------------------------------------
    if (action === "pipeline_overview") {
      const [
        { data: companies },
        { data: projectsAll },
        { data: estimates },
        { data: labour },
        { data: staff },
        { data: boqItems },
        { data: budgets },
        { data: pos },
        { data: tenders },
        { data: tenderDocs },
        { data: requirements },
        { data: specItems },
        { data: packages },
        { data: invitations },
        { data: quotations },
        { data: comparisons },
        { data: approvals },
      ] = await Promise.all([
        admin.from("companies").select("id, name, plan"),
        admin.from("projects").select("id, company_id, project_name"),
        admin.from("project_estimates").select("project_id, currency, margin_pct, client_budget_cents"),
        admin.from("estimate_labour").select("project_id, system_category, method, team_size, days, day_rate_cents, sub_price_cents, material_override_cents"),
        admin.from("estimate_staff").select("project_id, headcount, months, monthly_cost_cents"),
        admin.from("boq_items").select("project_id, system_category, quantity, unit_cost_cents"),
        admin.from("system_budgets").select("project_id, system_category, budget_cents"),
        admin.from("purchase_orders").select("project_id, system_category, amount_cents, status"),
        admin.from("tenders").select("id, company_id, project_id, status"),
        admin.from("tender_documents").select("tender_id, extraction_status"),
        admin.from("tender_requirements").select("tender_id, severity, is_mandatory"),
        admin.from("spec_items").select("tender_id"),
        admin.from("rfq_packages").select("id, tender_id, status, pricing_basis, our_estimate_cents"),
        admin.from("rfq_invitations").select("package_id, status"),
        admin.from("quotations").select("id, tender_id, package_id, quoted_total_cents, extraction_status"),
        admin.from("comparisons").select("id, tender_id"),
        admin.from("approvals").select("id, tender_id, status, amount_cents"),
      ]);

      const projectToCompany: Record<string, string | null> = {};
      const projectName: Record<string, string> = {};
      for (const p of projectsAll ?? []) {
        projectToCompany[p.id] = p.company_id;
        projectName[p.id] = p.project_name;
      }
      const companyName: Record<string, string> = {};
      for (const c of companies ?? []) companyName[c.id] = c.name;

      // --- cost build-up, per project -------------------------------
      const material: Record<string, number> = {};
      const install: Record<string, number> = {};
      const staffCost: Record<string, number> = {};
      const overridden = new Set<string>();

      for (const r of labour ?? []) {
        const pid = r.project_id as string;
        if (r.material_override_cents !== null && r.material_override_cents !== undefined) {
          overridden.add(`${pid}|${r.system_category}`);
          material[pid] = (material[pid] ?? 0) + Number(r.material_override_cents);
        }
        const own = Math.round((Number(r.team_size) || 0) * (Number(r.days) || 0) * Number(r.day_rate_cents ?? 0));
        install[pid] = (install[pid] ?? 0) + (r.method === "sub" ? Number(r.sub_price_cents ?? 0) : own);
      }
      for (const it of boqItems ?? []) {
        if (it.unit_cost_cents === null || it.unit_cost_cents === undefined) continue;
        const pid = it.project_id as string;
        if (overridden.has(`${pid}|${it.system_category}`)) continue;
        material[pid] = (material[pid] ?? 0) + Math.round((Number(it.quantity) || 0) * Number(it.unit_cost_cents));
      }
      for (const r of staff ?? []) {
        const pid = r.project_id as string;
        staffCost[pid] = (staffCost[pid] ?? 0) + Math.round((Number(r.headcount) || 0) * (Number(r.months) || 0) * Number(r.monthly_cost_cents ?? 0));
      }

      // --- budgets and committed spend, per project -----------------
      const budgetByProject: Record<string, number> = {};
      for (const b of budgets ?? []) budgetByProject[b.project_id] = (budgetByProject[b.project_id] ?? 0) + Number(b.budget_cents ?? 0);
      const committedByProject: Record<string, number> = {};
      for (const o of pos ?? []) {
        if (o.status === "cancelled") continue;
        committedByProject[o.project_id] = (committedByProject[o.project_id] ?? 0) + Number(o.amount_cents ?? 0);
      }

      // --- per-project pipeline rows --------------------------------
      const perProjectPipeline = (estimates ?? []).map((e: any) => {
        const pid = e.project_id as string;
        const mat = material[pid] ?? 0;
        const inst = install[pid] ?? 0;
        const stf = staffCost[pid] ?? 0;
        const cost = mat + inst + stf;
        const marginPct = Number(e.margin_pct) || 0;
        const sell = Math.round(cost * (1 + marginPct / 100));
        const budget = budgetByProject[pid] ?? 0;
        const committed = committedByProject[pid] ?? 0;
        return {
          project_id: pid,
          project_name: projectName[pid] ?? "Unknown project",
          company_id: projectToCompany[pid] ?? null,
          company_name: projectToCompany[pid] ? (companyName[projectToCompany[pid] as string] ?? "Unknown") : "—",
          currency: e.currency ?? "AED",
          material_cents: mat,
          installation_cents: inst,
          staff_cents: stf,
          cost_cents: cost,
          margin_pct: marginPct,
          selling_price_cents: sell,
          margin_on_selling_pct: sell > 0 ? Number((((sell - cost) / sell) * 100).toFixed(1)) : null,
          client_budget_cents: e.client_budget_cents ?? null,
          budget_set_cents: budget,
          committed_cents: committed,
          budget_remaining_cents: budget - committed,
          is_priced: cost > 0,
        };
      }).sort((a, b) => b.selling_price_cents - a.selling_price_cents);

      const priced = perProjectPipeline.filter((p) => p.is_priced);

      // Deliberately NOT one total. Projects are priced in AED, SAR, QAR and
      // whatever else the estimator chose, and adding those together would be
      // a made-up number wearing a currency symbol. Everything monetary is
      // grouped by currency; only counts are summed platform-wide.
      const byCurrency: Record<string, any> = {};
      for (const p of priced) {
        const cur = p.currency || "AED";
        if (!byCurrency[cur]) byCurrency[cur] = { currency: cur, projects: 0, cost_cents: 0, selling_price_cents: 0, budget_set_cents: 0, committed_cents: 0, client_budget_cents: 0 };
        const b = byCurrency[cur];
        b.projects += 1;
        b.cost_cents += p.cost_cents;
        b.selling_price_cents += p.selling_price_cents;
        b.budget_set_cents += p.budget_set_cents;
        b.committed_cents += p.committed_cents;
        b.client_budget_cents += p.client_budget_cents ?? 0;
      }
      const pipelineByCurrency = Object.values(byCurrency).map((b: any) => ({
        ...b,
        margin_on_selling_pct: b.selling_price_cents > 0
          ? Number((((b.selling_price_cents - b.cost_cents) / b.selling_price_cents) * 100).toFixed(1))
          : null,
        budget_remaining_cents: b.budget_set_cents - b.committed_cents,
      })).sort((a: any, b: any) => b.selling_price_cents - a.selling_price_cents);

      // --- procurement funnel ---------------------------------------
      const countBy = <T extends Record<string, any>>(rows: T[] | null, key: keyof T) => {
        const out: Record<string, number> = {};
        for (const r of rows ?? []) {
          const k = String(r[key] ?? "unknown");
          out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      };

      const tenderToCompany: Record<string, string | null> = {};
      for (const t of tenders ?? []) tenderToCompany[t.id] = t.company_id;

      // --- feature adoption, per company ----------------------------
      const adoption: Record<string, any> = {};
      for (const c of companies ?? []) {
        adoption[c.id] = {
          company_id: c.id, company_name: c.name, plan: c.plan,
          projects: 0, estimates: 0, budgets_set: 0, purchase_orders: 0,
          tenders: 0, tender_documents_read: 0, requirements_extracted: 0,
          rfq_packages: 0, quotations: 0, comparisons: 0, approvals: 0,
          pipeline_by_currency: {} as Record<string, number>,
        };
      }
      const bump = (companyId: string | null | undefined, field: string, by = 1) => {
        if (!companyId || !adoption[companyId]) return;
        adoption[companyId][field] += by;
      };
      for (const p of projectsAll ?? []) bump(p.company_id, "projects");
      for (const e of estimates ?? []) bump(projectToCompany[e.project_id], "estimates");
      for (const b of budgets ?? []) bump(projectToCompany[b.project_id], "budgets_set");
      for (const o of pos ?? []) bump(projectToCompany[o.project_id], "purchase_orders");
      for (const t of tenders ?? []) bump(t.company_id, "tenders");
      for (const d of tenderDocs ?? []) {
        if (d.extraction_status === "extracted") bump(tenderToCompany[d.tender_id], "tender_documents_read");
      }
      for (const r of requirements ?? []) bump(tenderToCompany[r.tender_id], "requirements_extracted");
      for (const k of packages ?? []) bump(tenderToCompany[k.tender_id], "rfq_packages");
      for (const q of quotations ?? []) bump(tenderToCompany[q.tender_id], "quotations");
      for (const cp of comparisons ?? []) bump(tenderToCompany[cp.tender_id], "comparisons");
      for (const ap of approvals ?? []) bump(tenderToCompany[ap.tender_id], "approvals");
      // Same reasoning as above: a company working in two currencies gets two
      // entries rather than one meaningless sum.
      for (const p of priced) {
        if (!p.company_id || !adoption[p.company_id]) continue;
        const a = adoption[p.company_id];
        a.pipeline_by_currency[p.currency] = (a.pipeline_by_currency[p.currency] ?? 0) + p.selling_price_cents;
      }

      const biggest = (m: Record<string, number>) => Math.max(0, ...Object.values(m ?? {}));
      const perCompanyAdoption = Object.values(adoption)
        .sort((a: any, b: any) => biggest(b.pipeline_by_currency) - biggest(a.pipeline_by_currency));

      return jsonResponse({
        generated_at: new Date().toISOString(),

        // estimating
        projects_total: (projectsAll ?? []).length,
        projects_with_estimate: (estimates ?? []).length,
        projects_priced: priced.length,
        pipeline_by_currency: pipelineByCurrency,
        currencies_in_use: pipelineByCurrency.map((b: any) => b.currency),

        // budget tracking
        projects_with_budget: Object.keys(budgetByProject).length,
        purchase_orders_count: (pos ?? []).length,

        // tender intelligence
        tenders_count: (tenders ?? []).length,
        tender_documents_count: (tenderDocs ?? []).length,
        tender_documents_read_count: (tenderDocs ?? []).filter((d: any) => d.extraction_status === "extracted").length,
        requirements_count: (requirements ?? []).length,
        requirements_critical_count: (requirements ?? []).filter((r: any) => r.severity === "critical").length,
        spec_items_count: (specItems ?? []).length,

        // procurement funnel
        rfq_packages_count: (packages ?? []).length,
        rfq_packages_by_status: countBy(packages as any[], "status"),
        rfq_packages_by_basis: countBy(packages as any[], "pricing_basis"),
        invitations_count: (invitations ?? []).length,
        invitations_by_status: countBy(invitations as any[], "status"),
        quotations_count: (quotations ?? []).length,
        comparisons_count: (comparisons ?? []).length,
        approvals_count: (approvals ?? []).length,
        approvals_by_status: countBy(approvals as any[], "status"),
        approvals_pending_count: (approvals ?? []).filter((a: any) => a.status === "pending").length,

        per_project_pipeline: perProjectPipeline,
        per_company_adoption: perCompanyAdoption,
      });
    }

    if (action !== "overview") {
      return jsonResponse({ error: "Unknown action" }, 400);
    }

    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();

    const [{ data: companies }, { data: plans }, { data: topupsThisMonth }, { data: usageRows }, { data: allProjects }, { data: allDrawings }, { data: runsAll }] =
      await Promise.all([
        admin.from("companies").select("id, name, plan, subscription_status, credit_balance_cents"),
        admin.from("plans").select("id, name, price_usd"),
        admin.from("credit_transactions").select("company_id, amount_cents, type").eq("type", "topup").gte("created_at", monthStartIso),
        admin.from("ai_usage").select("company_id, project_id, action, input_tokens, output_tokens, cost_cents, actual_cost_cents, page_count, created_at, is_admin_assisted").gte("created_at", monthStartIso),
        admin.from("projects").select("id, company_id, project_name"),
        admin.from("drawings").select("id, project_id"),
        admin.from("analysis_runs").select("project_id, status, created_at, completed_at, error_message"),
      ]);

    const planPriceCentsById: Record<string, number> = {};
    for (const p of plans ?? []) planPriceCentsById[p.id] = Math.round(Number(p.price_usd ?? 0) * 100);

    const activeCompanies = (companies ?? []).filter((c: any) => c.subscription_status === "active");
    const mrrCents = activeCompanies.reduce((sum: number, c: any) => sum + (planPriceCentsById[c.plan] ?? 0), 0);

    const walletRevenueCentsThisMonth = (topupsThisMonth ?? []).reduce((s: number, t: any) => s + Math.max(0, t.amount_cents), 0);

    const totalActualCostCents = (usageRows ?? []).reduce((s: number, u: any) => s + (u.actual_cost_cents ?? 0), 0);
    const totalBilledEquivalentCents = (usageRows ?? []).reduce((s: number, u: any) => s + (u.cost_cents ?? 0), 0);
    const totalTokens = (usageRows ?? []).reduce((s: number, u: any) => s + (u.input_tokens ?? 0) + (u.output_tokens ?? 0), 0);
    const totalPages = (usageRows ?? []).reduce((s: number, u: any) => s + (u.page_count ?? 0), 0);
    // Admin-assisted usage is real Anthropic cost the platform absorbed on a
    // customer's behalf (support/demo) — broken out separately so it's never
    // silently folded into "what this customer cost us" without visibility.
    const adminAssistedCostCentsThisMonth = (usageRows ?? []).filter((u: any) => u.is_admin_assisted).reduce((s: number, u: any) => s + (u.actual_cost_cents ?? 0), 0);
    const adminAssistedRunsThisMonth = (usageRows ?? []).filter((u: any) => u.is_admin_assisted).length;

    const totalRevenueCents = mrrCents + walletRevenueCentsThisMonth;
    const aiCostPctOfRevenue = totalRevenueCents > 0 ? (totalActualCostCents / totalRevenueCents) * 100 : null;

    const completedRuns = (runsAll ?? []).filter((r: any) => r.status === "completed" && r.completed_at);
    const avgBoqGenerationSeconds = completedRuns.length
      ? completedRuns.reduce((s: number, r: any) => s + (new Date(r.completed_at).getTime() - new Date(r.created_at).getTime()) / 1000, 0) / completedRuns.length
      : null;

    // estimated_wasted_cost (2026-08-10, later still): total_actual_ai_cost_cents_this_month
    // above ONLY reflects calls that succeeded and returned a parseable response --
    // ai_usage is only ever written on the happy path (see recordUsageAndBill call
    // sites in ai-engine). A real customer's dashboard showed a low "actual cost"
    // figure that looked inconsistent with their real Anthropic balance being
    // exhausted; investigation confirmed the true cause: dozens of analyze_drawing/
    // rework calls ran the FULL CALL_TIMEOUT_MS (Claude actively generating the
    // whole time) before failing, and those runs are invisible to the cost total
    // above since no token count is ever returned for them. This can't be exact --
    // we genuinely don't know Anthropic's per-token cost for a call we never got a
    // response from -- so it's estimated using this month's own average cost per
    // successful analyze_drawing/rework call as a stand-in, and clearly labeled as
    // an estimate everywhere it's surfaced (never presented as precise).
    const successfulAnalysisCosts = (usageRows ?? [])
      .filter((u: any) => (u.action === "analyze_drawing" || u.action === "rework") && (u.actual_cost_cents ?? 0) > 0)
      .map((u: any) => u.actual_cost_cents as number);
    const avgActualCostCentsPerAnalysisCall = successfulAnalysisCosts.length
      ? successfulAnalysisCosts.reduce((s: number, c: number) => s + c, 0) / successfulAnalysisCosts.length
      : 0;
    const failedTimeoutRunsThisMonth = (runsAll ?? []).filter((r: any) =>
      r.status === "failed" && r.created_at >= monthStartIso && typeof r.error_message === "string" && r.error_message.toLowerCase().includes("timed out")
    ).length;
    const estimatedWastedCostCents = Math.round(failedTimeoutRunsThisMonth * avgActualCostCentsPerAnalysisCall);

    const projectToCompany: Record<string, string | null> = {};
    for (const p of allProjects ?? []) projectToCompany[p.id] = p.company_id;

    const perCompany: Record<string, any> = {};
    for (const c of companies ?? []) {
      perCompany[c.id] = {
        company_id: c.id,
        company_name: c.name,
        plan: c.plan,
        subscription_status: c.subscription_status,
        credit_balance_cents: c.credit_balance_cents,
        projects_count: 0,
        drawings_count: 0,
        pages_processed: 0,
        tokens_total: 0,
        actual_cost_cents: 0,
        billed_equivalent_cents: 0,
        topup_revenue_cents_this_month: 0,
        subscription_revenue_cents: c.subscription_status === "active" ? (planPriceCentsById[c.plan] ?? 0) : 0,
      };
    }
    for (const p of allProjects ?? []) {
      if (p.company_id && perCompany[p.company_id]) perCompany[p.company_id].projects_count += 1;
    }
    for (const d of allDrawings ?? []) {
      const companyId = projectToCompany[d.project_id];
      if (companyId && perCompany[companyId]) perCompany[companyId].drawings_count += 1;
    }
    for (const u of usageRows ?? []) {
      if (u.company_id && perCompany[u.company_id]) {
        perCompany[u.company_id].pages_processed += u.page_count ?? 0;
        perCompany[u.company_id].tokens_total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        perCompany[u.company_id].actual_cost_cents += u.actual_cost_cents ?? 0;
        perCompany[u.company_id].billed_equivalent_cents += u.cost_cents ?? 0;
      }
    }
    for (const t of topupsThisMonth ?? []) {
      if (t.company_id && perCompany[t.company_id]) perCompany[t.company_id].topup_revenue_cents_this_month += Math.max(0, t.amount_cents);
    }

    const perCompanyList = Object.values(perCompany)
      .map((c: any) => {
        const revenue = c.subscription_revenue_cents + c.topup_revenue_cents_this_month;
        const margin = revenue - c.actual_cost_cents;
        return {
          ...c,
          revenue_cents_this_month: revenue,
          margin_cents_this_month: margin,
          margin_pct: revenue > 0 ? (margin / revenue) * 100 : null,
        };
      })
      .sort((a: any, b: any) => b.actual_cost_cents - a.actual_cost_cents);

    const perProject: Record<string, any> = {};
    for (const p of allProjects ?? []) {
      perProject[p.id] = { project_id: p.id, project_name: p.project_name, company_id: p.company_id, actual_cost_cents: 0, pages_processed: 0 };
    }
    for (const u of usageRows ?? []) {
      if (u.project_id && perProject[u.project_id]) {
        perProject[u.project_id].actual_cost_cents += u.actual_cost_cents ?? 0;
        perProject[u.project_id].pages_processed += u.page_count ?? 0;
      }
    }
    const perProjectList = Object.values(perProject).sort((a: any, b: any) => b.actual_cost_cents - a.actual_cost_cents);

    return jsonResponse({
      month_start: monthStartIso,
      mrr_cents: mrrCents,
      wallet_revenue_cents_this_month: walletRevenueCentsThisMonth,
      total_revenue_cents_this_month: totalRevenueCents,
      total_actual_ai_cost_cents_this_month: totalActualCostCents,
      total_billed_equivalent_cents_this_month: totalBilledEquivalentCents,
      failed_timeout_runs_this_month: failedTimeoutRunsThisMonth,
      estimated_wasted_cost_cents_this_month: estimatedWastedCostCents,
      estimated_wasted_cost_is_approximate: true,
      ai_cost_pct_of_revenue: aiCostPctOfRevenue,
      total_tokens_this_month: totalTokens,
      total_pages_processed_this_month: totalPages,
      admin_assisted_cost_cents_this_month: adminAssistedCostCentsThisMonth,
      admin_assisted_runs_this_month: adminAssistedRunsThisMonth,
      avg_boq_generation_seconds: avgBoqGenerationSeconds,
      companies_count: (companies ?? []).length,
      active_subscriptions_count: activeCompanies.length,
      per_company: perCompanyList,
      per_project: perProjectList,
    });
  } catch (err) {
    return jsonResponse({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
