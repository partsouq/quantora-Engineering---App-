// Quantora test robot.
// Uses the live website like a customer: sign in, create a project, upload a drawing,
// (every 2 hours) generate the AI BOQ, upload a specification, open the BOQ and
// Manual Take-off pages, then delete its test project. Each run is reported to
// public.q_robot_report; a failure raises an admin alert (push to the admin's phone).
//
// Env: ROBOT_EMAIL, ROBOT_PASSWORD (GitHub secrets), ROBOT_URL (default live site),
//      ROBOT_FULL=1 to include AI BOQ generation, ROBOT_NO_REPORT=1 for local tests,
//      ROBOT_RUN_URL (link to this run), ROBOT_SHOTS (folder for screenshots).
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.env.ROBOT_URL || "https://quantoraengineering.com/";
const FULL = process.env.ROBOT_FULL === "1";
const EMAIL = process.env.ROBOT_EMAIL || "";
const PASSWORD = process.env.ROBOT_PASSWORD || "";
const SHOTS = process.env.ROBOT_SHOTS || path.join(__dirname, "shots");
const DRAWING = path.join(__dirname, "ROBOT-TEST-GF-CCTV.pdf");
const SPEC = path.join(__dirname, "ROBOT-TEST-SPEC.pdf");
const STAMP = new Date().toISOString().slice(0, 16).replace("T", " ");
const PROJECT = "ROBOT TEST " + STAMP;

fs.mkdirSync(SHOTS, { recursive: true });
const steps = [];
const started = Date.now();
let page, build = null, popupError = null;

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function shot(name) { try { await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } catch (_) {} }

// An error pop-up while the robot works is a failure of that step.
async function closePops() {
  const dlg = page.locator('[role="alertdialog"]');
  for (let i = 0; i < 5 && (await dlg.count()); i++) {
    const text = (await dlg.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const isError = /Something needs your attention|Please check|could not|failed|error/i.test(text) && !/^.?\s*Uploaded/i.test(text);
    log("pop-up:", text.slice(0, 160));
    if (isError && !popupError) popupError = text.slice(0, 300);
    await dlg.first().locator("button", { hasText: /^OK$/ }).click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function step(name, fn, { optional = false } = {}) {
  const t0 = Date.now(); popupError = null;
  log("STEP", name);
  try {
    await fn();
    await closePops();
    if (popupError) throw new Error("Error shown to the user: " + popupError);
    steps.push({ step: name, ok: true, s: Math.round((Date.now() - t0) / 1000) });
    if (process.env.ROBOT_DEBUG) await shot("ok-" + name.replace(/\W+/g, "-"));
    log("  ok", Math.round((Date.now() - t0) / 1000) + "s");
  } catch (e) {
    const msg = String(e && e.message || e).split("\n")[0].slice(0, 400);
    steps.push({ step: name, ok: false, s: Math.round((Date.now() - t0) / 1000), error: msg });
    log("  FAILED:", msg);
    // What the screen showed at that moment (pop-ups first), so a failure can be read from the log alone.
    try {
      const seen = await page.evaluate(() => {
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const dlg = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],.fixed')].filter(vis).map(e => e.innerText.trim()).filter(Boolean).slice(0, 3);
        return { url: location.href, dialogs: dlg.map(t => t.replace(/\s+/g, " ").slice(0, 300)), screen: document.body.innerText.replace(/\s+/g, " ").slice(0, 700) };
      });
      log("  SCREEN:", JSON.stringify(seen));
    } catch (_) {}
    await shot("FAILED-" + name.replace(/\W+/g, "-"));
    if (!optional) throw Object.assign(new Error(msg), { robotStep: name });
  }
}

// ---- reporting (straight to the database, independent of the page) ----
async function report(ok, failedStep, message) {
  if (process.env.ROBOT_NO_REPORT === "1") { log("REPORT (skipped)", ok, failedStep || "", message || ""); return; }
  try {
    const html = await (await fetch(BASE + "?robot=" + Date.now(), { cache: "no-store" })).text();
    const url = (html.match(/SUPABASE_URL = "([^"]+)"/) || [])[1];
    const key = (html.match(/SUPABASE_ANON_KEY = "([^"]+)"/) || [])[1];
    if (!build) build = (html.match(/QUANTORA_BUILD = "([^"]+)"/) || [])[1] || null;
    const tok = await (await fetch(url + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: key, "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })).json();
    if (!tok.access_token) throw new Error("robot could not sign in for reporting: " + (tok.error_description || tok.msg || tok.error || "unknown"));
    const r = await fetch(url + "/rest/v1/rpc/q_robot_report", {
      method: "POST", headers: { apikey: key, authorization: "Bearer " + tok.access_token, "content-type": "application/json" },
      body: JSON.stringify({ p: { ok, mode: FULL ? "full" : "quick", failed_step: failedStep || null, message: message || null, steps,
        duration_s: Math.round((Date.now() - started) / 1000), build, run_url: process.env.ROBOT_RUN_URL || null } }),
    });
    log("report sent:", r.status, (await r.text()).slice(0, 200));
    if (!r.ok) process.exitCode = 1;
  } catch (e) { log("REPORT FAILED:", e.message); process.exitCode = 1; }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The robot never answers rating questions (they would block the screen and count as real feedback).
  await ctx.addInitScript(() => {
    const g = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) { if (/^qfb:|^q_feedback_asked_at$|^q_pulse_at$/.test(k)) return String(Date.now()); return g.call(this, k); };
  });
  page = await ctx.newPage();
  if (process.env.ROBOT_MOCK) await require(process.env.ROBOT_MOCK).install(page, { indexFile: process.env.ROBOT_INDEX });   // local test only
  page.on("dialog", d => d.accept().catch(() => {}));
  page.on("pageerror", e => log("page error:", String(e).slice(0, 200)));
  let failedStep = null, failMsg = null;

  try {
    await step("Open the website", async () => {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => !!window.QUANTORA_BUILD, null, { timeout: 30000 });
      build = await page.evaluate(() => window.QUANTORA_BUILD);
      log("build", build);
    });

    await step("Sign in", async () => {
      const home = page.getByText("Where are you working today");
      const login = page.locator('a[href*="auth=login"]');
      await home.or(login).first().waitFor({ timeout: 45000 });
      if (!(await home.count())) {
        await page.locator('a[href*="auth=login"]').first().click({ timeout: 20000 });
        await page.locator('input[type="email"]').first().fill(EMAIL);
        await page.locator('input[type="password"]').first().fill(PASSWORD);
        await page.locator("form button:not([type=button])").first().click();
      }
      await home.first().waitFor({ timeout: 45000 });
    });

    await step("Create a project", async () => {
      await page.getByText("Open projects").first().click();
      await page.getByRole("button", { name: "+ New Project" }).first().click({ timeout: 20000 });
      const inputs = page.locator('form input[type="text"]');
      await inputs.nth(0).fill(PROJECT);          // Project name
      await inputs.nth(2).fill("United Arab Emirates");  // Country
      await inputs.nth(3).fill("Dubai");          // City
      const typeSel = page.locator("form select").filter({ has: page.locator("option", { hasText: "Choose the type of project" }) });
      if (await typeSel.count()) {
        const v = await typeSel.locator("option").nth(1).getAttribute("value");
        await typeSel.selectOption(v);
      }
      await page.locator("form label", { hasText: /^CCTV$/ }).first().click().catch(() => {});
      await page.getByRole("button", { name: "Create Project" }).click();
      await page.getByText(PROJECT).first().waitFor({ timeout: 30000 });
      await closePops();
      // open it if the app stayed on the list
      if (!(await page.locator("nav", { hasText: "Drawings & Upload" }).count())) {
        await page.getByText(PROJECT).first().click().catch(() => {});
      }
      await page.locator("nav").getByText("Drawings & Upload").first().waitFor({ timeout: 30000 });
    });

    await step("Upload a drawing", async () => {
      await page.locator("nav").getByText("Drawings & Upload").first().click();
      await page.getByText("ELV & Security", { exact: true }).first().click({ timeout: 20000 });
      await page.locator('input[type="file"]').first().setInputFiles(DRAWING);
      await page.locator("button", { hasText: /^Upload \d/ }).first().click();
      await page.getByText("Uploaded ✓").first().waitFor({ timeout: 120000 });
      await page.locator('[role="alertdialog"] button', { hasText: /^OK$/ }).first().click().catch(() => {});
      await page.getByText(path.basename(DRAWING), { exact: true }).first().waitFor({ timeout: 30000 });   // the row in the list, not the banner
    });

    if (FULL) {
      await step("Generate the AI BOQ", async () => {
        const row = page.locator("div", { has: page.getByText(path.basename(DRAWING), { exact: true }) })
          .filter({ has: page.locator("button", { hasText: "Analyze with AI" }) }).last();
        await row.locator("button", { hasText: "Analyze with AI" }).click();
        // a confirm or page-choice window may open: accept it
        for (let i = 0; i < 3; i++) {
          await page.waitForTimeout(2500);
          const go = page.locator("button", { hasText: /^(Start|Analyze|Analyse|Continue|Run|Confirm)\b/ }).filter({ hasNot: page.locator("[disabled]") });
          if (await go.count()) { await go.last().click().catch(() => {}); } else break;
        }
        const done = page.getByText(/Done · \d+ BOQ lines/).first();
        const t0 = Date.now();
        while (Date.now() - t0 < 12 * 60000) {
          if (await done.count()) break;
          if (await page.getByText(/Analysis failed|Failed ·|could not finish/i).count()) throw new Error("the AI run failed");
          await closePops(); if (popupError) throw new Error("Error shown to the user: " + popupError);
          await page.waitForTimeout(10000);
        }
        if (!(await done.count())) throw new Error("no BOQ after 12 minutes");
        const txt = await done.innerText();
        const n = Number((txt.match(/(\d+) BOQ lines/) || [])[1] || 0);
        log("BOQ:", txt);
        if (!n) throw new Error("the BOQ came back empty");
      });
    }

    if (process.env.ROBOT_SKIP !== "spec") await step("Upload a specification", async () => {
      await page.locator("nav").getByText("Specification", { exact: true }).first().click();
      await page.waitForTimeout(2000);
      await page.locator("label", { hasText: "Upload specification" }).first().locator('input[type="file"]').setInputFiles(SPEC);
      await page.getByText(path.basename(SPEC), { exact: true }).first().waitFor({ timeout: 90000 });
    });

    await step("Open the BOQ page", async () => {
      await page.locator("nav").getByText("AI Take-off & BOQ").first().click();
      await page.waitForTimeout(4000);
      if (await page.getByText(/Could not load|Something went wrong/i).count()) throw new Error("BOQ page shows an error");
    });

    await step("Open Manual Take-off", async () => {
      await page.locator("nav").getByText("Manual Take-off").first().click();
      await page.getByText(/Choose the drawing for this floor|Pick from the library|Manual Take-off/).first().waitFor({ timeout: 30000 });
    });
  } catch (e) {
    failedStep = e.robotStep || "robot"; failMsg = e.message;
  }

  // Always clean up: delete the test project.
  await step("Delete the test project", async () => {
    await closePops();
    if (!(await page.getByRole("button", { name: "Delete", exact: true }).count())) {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByText("Where are you working today").first().waitFor({ timeout: 45000 });
      await page.getByText("Open projects").first().click();
      const card = page.getByText(PROJECT).first();
      if (!(await card.count())) { await page.waitForTimeout(3000); }
      if (!(await card.count())) return;          // nothing was created
      await card.click();
    }
    await page.getByRole("button", { name: "Delete", exact: true }).first().click({ timeout: 20000 });
    const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Choose a reason" }) }).first();
    const v = await sel.locator("option").nth(1).getAttribute("value", { timeout: 15000 });
    await sel.selectOption(v);
    const box = page.locator("label", { hasText: "I understand" }).locator('input[type="checkbox"]').first();
    if (!(await box.isChecked())) await box.check();
    await page.getByRole("button", { name: "Delete permanently" }).click({ timeout: 20000 });
    await page.getByText(PROJECT).first().waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
  }, { optional: true });

  const cleanupFailed = steps.some(s => s.step === "Delete the test project" && !s.ok);
  await shot(failedStep ? "end-failed" : "end-ok");
  await browser.close();

  const ok = !failedStep;
  await report(ok, failedStep || (cleanupFailed ? null : null), failMsg || (cleanupFailed ? "Test project could not be deleted" : null));
  log(ok ? "ROBOT OK" : "ROBOT FAILED at: " + failedStep, "in", Math.round((Date.now() - started) / 1000) + "s");
  if (!ok) process.exitCode = 1;
})();
