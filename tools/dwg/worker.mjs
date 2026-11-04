// DWG worker (2026-11-04). Runs on GitHub Actions (.github/workflows/dwg-convert.yml).
//
// 1. Proves who it is to the dwg-worker function with a GitHub OIDC token (no stored secret).
// 2. Claims queued DWG uploads. For each one it gets a short-lived download link and upload link.
// 3. Reads the DWG with LibreDWG (libredwg-web), draws it as a vector PDF with real text (dwg2pdf.py),
//    uploads the PDF, and reports done. The app then analyses that PDF like any other drawing.
//
// This repository is public, so the log never shows file names, links or drawing content: job ids only.
// LibreDWG is GPL-3.0; it runs here, on our build server, and is never sent to users' browsers.
import { Dwg_File_Type, LibreDwg } from "@mlightcad/libredwg-web";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FN = process.env.DWG_WORKER_URL;            // https://<project>.supabase.co/functions/v1/dwg-worker
// GitHub's OIDC tokens are short-lived, so a fresh one is fetched for every call.
async function oidc() {
  const u = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, t = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!u || !t) throw new Error("no OIDC (needs permissions: id-token: write)");
  const r = await fetch(u + "&audience=quantora-dwg", { headers: { authorization: "bearer " + t } });
  const j = await r.json();
  if (!j.value) throw new Error("OIDC token request failed");
  return j.value;
}
const DEADLINE = Date.now() + 12 * 60 * 1000;     // stop claiming after 12 minutes; the job has 20
const HERE = path.dirname(new URL(import.meta.url).pathname);

async function call(action, body = {}) {
  const r = await fetch(FN, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-oidc": await oidc() },
    body: JSON.stringify({ action, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${action} failed: ${r.status} ${j.error || ""}`);
  return j;
}

// Keeps only what the renderer reads; a big DWG's full JSON can be hundreds of MB.
const DROP = new Set(["bmpPreview", "xdata", "classes", "satCache", "proxyGraphics", "binaryData", "frozenLayerIds"]);
function toJson(db) {
  const out = { header: { MEASUREMENT: db.header?.MEASUREMENT, INSUNITS: db.header?.INSUNITS },
    tables: { LAYER: db.tables?.LAYER, BLOCK_RECORD: db.tables?.BLOCK_RECORD },
    objects: { LAYOUT: db.objects?.LAYOUT }, entities: db.entities };
  return JSON.stringify(out, (k, v) => (DROP.has(k) ? undefined : typeof v === "bigint" ? Number(v) : v));
}

async function convert(lib, job, dir) {
  const src = path.join(dir, "in.dwg"), js = path.join(dir, "in.json"), pdf = path.join(dir, "out.pdf"), rep = path.join(dir, "report.json");
  const res = await fetch(job.download_url).catch((e) => { throw new Error("download: " + (e.cause?.code || e.message)); });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const t0 = Date.now();
  const dwg = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
  if (!dwg) throw new Error("This DWG could not be opened (it may be damaged, password-protected or a very new version).");
  const db = lib.convert(dwg);
  try { lib.dwg_free(dwg); } catch (_) {}
  if (!db?.entities?.length) throw new Error("The DWG opened but has no drawing content.");
  fs.writeFileSync(js, toJson(db));
  const r = spawnSync("python3", [path.join(HERE, "dwg2pdf.py"), js, pdf, rep], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 8 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error("Drawing the DWG failed" + (r.status === null ? " (took too long)" : ""));
  const report = JSON.parse(fs.readFileSync(rep, "utf8"));
  // a kept-alive connection can be closed by the server during a long conversion: retry the upload
  let up = null, lastErr = "";
  for (let i = 0; i < 3 && !(up && up.ok); i++) {
    try { up = await fetch(job.upload_url, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "true", connection: "close" }, body: fs.readFileSync(pdf) }); }
    catch (e) { lastErr = e.cause?.code || e.message; up = null; }
  }
  if (!up) throw new Error("upload: " + lastErr);
  if (!up.ok) throw new Error(`upload ${up.status}`);
  return {
    pages: report.pages.length,
    seconds: Math.round((Date.now() - t0) / 1000),
    // sizes and counts only: no layer or layout names leave the database
    report: { pages: report.pages.map((p) => ({ width_mm: p.width_mm, height_mm: p.height_mm, viewports: p.viewports || 0 })),
              drawn: report.drawn, text: report.text, skipped: report.skipped_types, dwg_bytes: bytes.length },
  };
}

(async () => {
  if (!FN) { console.log("worker not configured"); process.exit(1); }
  const lib = await LibreDwg.create(path.join(HERE, "node_modules/@mlightcad/libredwg-web/wasm/"));
  let done = 0, failed = 0;
  while (Date.now() < DEADLINE) {
    const { jobs } = await call("claim", { limit: 2 });
    if (!jobs?.length) break;
    for (const job of jobs) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwg-"));
      try {
        const out = await convert(lib, job, dir);
        await call("done", { job_id: job.job_id, path: job.upload_path, ...out });
        console.log(`job ${job.job_id}: done, ${out.pages} page(s), ${out.seconds}s`);
        done++;
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        console.log(`job ${job.job_id}: failed`); if (process.env.DWG_DEBUG) console.log(msg);
        await call("fail", { job_id: job.job_id, error: msg }).catch(() => {});
        failed++;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  console.log(`finished: ${done} converted, ${failed} failed`);
})().catch((e) => { console.log("worker error:", String(e?.message || e).slice(0, 200)); process.exit(1); });
