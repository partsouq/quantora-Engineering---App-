// dwg-worker (2026-11-04): hands queued DWG uploads to the converter on GitHub Actions and
// attaches the finished PDF to the drawing, so the normal take-off reads it.
//
// Who may call: only the dwg-convert workflow on the main branch of our repository. It proves this
// with a GitHub OIDC token (signed by GitHub, checked here against GitHub's public keys), so no
// password or key is stored anywhere. Deployed with verify_jwt off for that reason.
//
// Actions
//   pending                                -> how many are waiting (the workflow skips its install when 0)
//   claim {limit}                          -> up to N queued jobs, each with a 1-hour download link for
//                                             the DWG and a one-time upload link for the PDF
//   done  {job_id, path, pages, report}    -> PDF attached to the drawing; job done
//   fail  {job_id, error}                  -> retried up to 3 times, then marked failed with a plain message
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const REPO = "partsouq/quantora-Engineering---App-";
const WORKFLOW = `${REPO}/.github/workflows/dwg-convert.yml@refs/heads/main`;
const AUDIENCE = "quantora-dwg";
const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function fromOurWorkflow(req: Request): Promise<boolean> {
  const tok = req.headers.get("x-github-oidc") || "";
  if (!tok) return false;
  try {
    const { payload } = await jwtVerify(tok, JWKS, { issuer: "https://token.actions.githubusercontent.com", audience: AUDIENCE });
    return payload.repository === REPO && payload.ref === "refs/heads/main" && payload.workflow_ref === WORKFLOW;
  } catch (_) {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await fromOurWorkflow(req))) return json({ error: "not allowed" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad request" }, 400); }

  if (body.action === "pending") {
    const { count } = await admin.from("dwg_jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
    return json({ queued: count || 0 });
  }

  if (body.action === "claim") {
    const limit = Math.max(1, Math.min(4, Number(body.limit) || 2));
    const { data: jobs, error } = await admin.rpc("q_dwg_claim", { p_limit: limit });
    if (error) return json({ error: error.message }, 500);
    const out = [];
    for (const j of jobs || []) {
      const { data: dl, error: dErr } = await admin.storage.from("drawings").createSignedUrl(j.storage_path, 3600);
      const target = `${j.project_id}/${Date.now()}_dwg_${j.drawing_id}.pdf`;
      const { data: ul, error: uErr } = await admin.storage.from("drawings").createSignedUploadUrl(target);
      if (dErr || uErr || !dl || !ul) {
        await admin.rpc("q_dwg_finish", { p_job: j.job_id, p_ok: false, p_error: "The uploaded file could not be read from storage.", p_path: null, p_pages: null, p_report: null });
        continue;
      }
      out.push({ job_id: j.job_id, download_url: dl.signedUrl, upload_url: ul.signedUrl, upload_path: target });
    }
    return json({ jobs: out });
  }

  if (body.action === "done") {
    const path = String(body.path || "");
    const { data: job } = await admin.from("dwg_jobs").select("id, drawing_id, project_id, status").eq("id", body.job_id).maybeSingle();
    if (!job || job.status !== "working") return json({ error: "no such job in progress" }, 404);
    if (!path.startsWith(`${job.project_id}/`) || !path.endsWith(`_dwg_${job.drawing_id}.pdf`)) return json({ error: "wrong path" }, 400);
    // the PDF must really be there before the drawing points at it
    const folder = path.slice(0, path.lastIndexOf("/")), name = path.slice(path.lastIndexOf("/") + 1);
    const { data: found } = await admin.storage.from("drawings").list(folder, { search: name, limit: 1 });
    if (!found?.length) return json({ error: "PDF not uploaded" }, 400);
    const pages = Math.max(1, Math.min(500, Number(body.pages) || 1));
    const report = body.report && typeof body.report === "object" ? body.report : null;
    const { error } = await admin.rpc("q_dwg_finish", { p_job: job.id, p_ok: true, p_error: null, p_path: path, p_pages: pages, p_report: { ...report, seconds: Number(body.seconds) || null } });
    if (error) return json({ error: error.message }, 500);
    const preview = typeof body.preview === "string" && body.preview.length < 600_000 ? body.preview : null;
    if (preview) await admin.from("dwg_jobs").update({ preview_jpg: preview }).eq("id", job.id);
    return json({ ok: true });
  }

  if (body.action === "fail") {
    const { error } = await admin.rpc("q_dwg_finish", { p_job: body.job_id, p_ok: false, p_error: String(body.error || "Conversion failed").slice(0, 300), p_path: null, p_pages: null, p_report: null });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
