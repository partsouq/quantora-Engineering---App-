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
        const main = document.querySelector("main") || document.body;
        const txt = main.innerText.replace(/\s+/g, " "); const il = txt.indexOf("Item list");
        return { url: location.href, dialogs: dlg.map(t => t.replace(/\s+/g, " ").slice(0, 300)), screen: txt.slice(0, 700),
          items: il >= 0 ? txt.slice(il, il + 500) : null, marks: document.querySelectorAll("[data-mark]").length, scrollY: Math.round(scrollY), vh: innerHeight };
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
      const form = page.locator("form").filter({ hasText: "Project Name" }).first();
      await form.locator("input").first().fill(PROJECT);                 // Project name
      // Country and city are lists of supported places (typed boxes when the list is not loaded).
      const ctry = form.locator("select").filter({ has: page.locator("option", { hasText: "Select country" }) }).first();
      if (await ctry.count()) {
        const v = await ctry.locator("option", { hasText: /^UAE/ }).first().getAttribute("value");
        await ctry.selectOption(v);
        await page.waitForTimeout(300);
        const city = form.locator("select").filter({ has: page.locator("option", { hasText: "Dubai" }) }).first();
        if (await city.count()) await city.selectOption({ label: "Dubai" });
        else { const ci = form.locator('input[placeholder="City name"]'); if (await ci.count()) await ci.fill("Dubai"); }
      } else {
        await form.locator('input[placeholder="Country name"]').first().fill("United Arab Emirates").catch(() => {});
        await form.locator('input[placeholder="City name"]').first().fill("Dubai").catch(() => {});
      }
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
          // Only buttons inside an open window: pressing "Analyze with AI" again would start (and pay for) a second run.
          const go = page.locator('[role="dialog"] button, .fixed button').filter({ hasText: /^(Start|Analyze|Analyse|Continue|Run|Confirm)\b/ }).filter({ hasNot: page.locator("[disabled]") });
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
      await page.getByText("Upload the project specification").first().waitFor({ timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});   // the page finishes loading first
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
      // The drawing chooser is a list box; its first option is not "visible" text, so wait for the list itself.
      await page.locator("select").filter({ has: page.locator("option", { hasText: "Choose the drawing for this floor" }) }).first().waitFor({ timeout: 30000 });
    });

    // Manual Take-off end to end (no AI): attach the drawing, mark three cameras, get the Designed BOQ.
    await step("Manual Take-off: attach the drawing", async () => {
      const ds = page.locator("select").filter({ has: page.locator("option", { hasText: "Choose the drawing for this floor" }) }).first();
      const v = await ds.locator("option", { hasText: path.basename(DRAWING) }).first().getAttribute("value", { timeout: 20000 });
      await ds.selectOption(v);
      await page.locator('div[style*="crosshair"] svg, div[style*="default"] svg').first().waitFor({ timeout: 60000 });
      await page.waitForFunction(() => { const c = document.querySelector("canvas"); return c && c.width > 50; }, null, { timeout: 60000 });
    });

    await step("Manual Take-off: mark and design the BOQ", async () => {
      const sys = page.locator("select").filter({ has: page.locator("option[value=\"cctv\"]") }).first();
      await sys.selectOption("cctv"); await page.waitForTimeout(300);
      const eq = page.locator("select").filter({ has: page.locator('option[value="__own"]') }).first();
      await eq.selectOption(await eq.locator("option", { hasText: "Dome camera" }).first().getAttribute("value"));
      await page.waitForTimeout(500);
      const sheet = page.locator('div[style*="crosshair"] svg').first();
      // Notices from the AI run can arrive late and sit on top of the sheet: clear them, and retry a click that did not count.
      let n = 0;
      for (const [fx, fy] of [[0.3, 0.4], [0.5, 0.5], [0.7, 0.6]]) {
        for (let tries = 0; tries < 4; tries++) {
          await closePops();
          const b = await sheet.boundingBox();
          await sheet.click({ position: { x: b.width * fx, y: b.height * fy }, timeout: 10000 }).catch(async e => {
            const why = String(e.message).split("\n").find(l => /intercepts pointer events/.test(l)) || String(e.message).split("\n")[0];
            const top = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); if (!el) return null;
              const c = el.closest('[role],[class*="fixed"],[id]') || el; return (c.tagName + " " + (c.id || "") + " " + (c.getAttribute("role") || "") + " " + (c.className || "")).slice(0, 160) + " | " + (c.innerText || "").replace(/\s+/g, " ").slice(0, 160); },
              [b.x + b.width * fx, b.y + b.height * fy]).catch(() => null);
            log("  click blocked:", why.trim().slice(0, 300), "| on top:", top);
            throw e;
          }).catch(() => {});
          await page.waitForTimeout(600);
          if (await page.getByText(new RegExp("^D" + (n + 1) + "$")).count()) { n++; break; }
        }
      }
      await page.getByText(/^D3$/).first().waitFor({ timeout: 15000 });
      await page.locator("button", { hasText: "Design BOQ for these systems" }).first().click();
      await page.getByText("Engineered by Quantora").first().waitFor({ timeout: 30000 });
      if (!(await page.getByText(/NVR/).count())) throw new Error("Designed BOQ has no NVR line for 3 cameras");
    });
  } catch (e) {
    failedStep = e.robotStep || "robot"; failMsg = e.message;
  }

  // Always clean up: delete this run's test project, and any left over from an earlier run.
  async function deleteProject(name) {
    await closePops();
    if (!(await page.getByRole("button", { name: "Delete", exact: true }).count()) || !(await page.getByText(name).count())) {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByText("Where are you working today").first().waitFor({ timeout: 45000 });
      await page.getByText("Open projects").first().click();
      const card = page.getByText(name).first();
      if (!(await card.count())) { await page.waitForTimeout(3000); }
      if (!(await card.count())) return false;          // nothing to delete
      await card.click();
    }
    await closePops();
    await page.getByRole("button", { name: "Delete", exact: true }).first().click({ timeout: 20000 });
    await page.waitForTimeout(800);
    const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Choose a reason" }) }).first();
    await sel.selectOption("test");
    const box = page.locator("label", { hasText: "I understand" }).locator('input[type="checkbox"]').first();
    if (!(await box.isChecked())) await box.check();
    await page.getByRole("button", { name: "Delete permanently" }).click({ timeout: 20000 });
    // Let the delete finish before moving on (leaving the page early stops it half-way).
    await page.getByText("Deleting…").first().waitFor({ state: "detached", timeout: 90000 }).catch(() => {});
    await page.locator("h1, h2, h3", { hasText: name }).first().waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    return true;
  }
  await step("Delete the test project", async () => {
    await deleteProject(PROJECT);
    // leftovers from a run that stopped half-way
    for (let i = 0; i < 5; i++) {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByText("Where are you working today").first().waitFor({ timeout: 45000 });
      await page.getByText("Open projects").first().click(); await page.waitForTimeout(2500);
      const left = page.getByText(/^ROBOT TEST \d{4}-\d{2}-\d{2}/).first();
      if (!(await left.count())) break;
      const name = (await left.innerText()).trim();
      log("old test project:", name);
      if (!(await deleteProject(name))) break;
    }
  }, { optional: true });

  const cleanupFailed = steps.some(s => s.step === "Delete the test project" && !s.ok);
  await shot(failedStep ? "end-failed" : "end-ok");
  await browser.close();

  const ok = !failedStep;
  await report(ok, failedStep || (cleanupFailed ? null : null), failMsg || (cleanupFailed ? "Test project could not be deleted" : null));
  log(ok ? "ROBOT OK" : "ROBOT FAILED at: " + failedStep, "in", Math.round((Date.now() - started) / 1000) + "s");
  if (!ok) process.exitCode = 1;
})();
