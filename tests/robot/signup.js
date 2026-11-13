// Quantora sign-up robot (2026-11-07).
// Once a day it signs up like a brand-new customer and checks the whole journey the main robot never sees:
//   1. the "Create Account" form is accepted,
//   2. the confirmation email is sent,
//   3. the confirmation link works and signs the new person in,
//   4. their company and Welcome Pack are created,
// then it removes its own test account. No AI is used (no cost).
// Test addresses are quantoraengineering01+signup<time>@gmail.com; the platform never counts them as customers.
// The check and the clean-up are done by the main robot account (ROBOT_EMAIL / ROBOT_PASSWORD) through
// q_robot_signup_check / q_robot_signup_cleanup, which only work for those test addresses.
// Each run is reported to q_robot_report (mode "signup"); a failure raises an admin alert.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const BASE = process.env.ROBOT_URL || "https://quantoraengineering.com/";
const EMAIL = process.env.ROBOT_EMAIL || "";
const PASSWORD = process.env.ROBOT_PASSWORD || "";
const SHOTS = process.env.ROBOT_SHOTS || path.join(__dirname, "shots");
const TEST_EMAIL = `quantoraengineering01+signup${Date.now().toString(36)}@gmail.com`;
const TEST_PASSWORD = "Rb!" + crypto.randomBytes(12).toString("hex");

fs.mkdirSync(SHOTS, { recursive: true });
const steps = [];
const started = Date.now();
let page, build = null, cfg = null;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(name) { try { await page.screenshot({ path: path.join(SHOTS, name + ".png") }); } catch (_) {} }

async function step(name, fn) {
  const t0 = Date.now();
  log("STEP", name);
  try {
    await fn();
    steps.push({ step: name, ok: true, s: Math.round((Date.now() - t0) / 1000) });
    log("  ok", Math.round((Date.now() - t0) / 1000) + "s");
  } catch (e) {
    const msg = String(e && e.message || e).split("\n")[0].slice(0, 400);
    steps.push({ step: name, ok: false, s: Math.round((Date.now() - t0) / 1000), error: msg });
    log("  FAILED:", msg);
    await shot("SIGNUP-FAILED-" + name.replace(/\W+/g, "-"));
    throw Object.assign(new Error(msg), { robotStep: name });
  }
}

// site settings + a signed-in token for the main robot account (used for the checks and the report)
async function robotApi() {
  if (!cfg) {
    const html = await (await fetch(BASE + "?robot=" + Date.now(), { cache: "no-store" })).text();
    cfg = { url: (html.match(/SUPABASE_URL = "([^"]+)"/) || [])[1], key: (html.match(/SUPABASE_ANON_KEY = "([^"]+)"/) || [])[1] };
    build = (html.match(/QUANTORA_BUILD = "([^"]+)"/) || [])[1] || null;
  }
  if (!cfg.token) {
    const tok = await (await fetch(cfg.url + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { apikey: cfg.key, "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json();
    if (!tok.access_token) throw new Error("robot could not sign in: " + (tok.error_description || tok.msg || tok.error || "unknown"));
    cfg.token = tok.access_token;
  }
  return cfg;
}
async function rpc(fn, body) {
  const c = await robotApi();
  const r = await fetch(`${c.url}/rest/v1/rpc/${fn}`, { method: "POST",
    headers: { apikey: c.key, authorization: "Bearer " + c.token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const check = () => rpc("q_robot_signup_check", { p_email: TEST_EMAIL });

async function report(ok, failedStep, message) {
  if (process.env.ROBOT_NO_REPORT === "1") { log("REPORT (skipped)", ok, failedStep || "", message || ""); return; }
  try {
    const out = await rpc("q_robot_report", { p: { ok, mode: "signup", failed_step: failedStep || null, message: message || null, steps,
      duration_s: Math.round((Date.now() - started) / 1000), build, run_url: process.env.ROBOT_RUN_URL || null } });
    log("report sent:", JSON.stringify(out).slice(0, 200));
  } catch (e) { log("REPORT FAILED:", e.message); process.exitCode = 1; }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const g = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) { if (/^qfb:|^q_feedback_asked_at$|^q_pulse_at$|^q_assist_asked:|^q_look_asked:/.test(k)) return String(Date.now()); return g.call(this, k); };
  });
  page = await ctx.newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  let failedStep = null, failMsg = null;
  log("test address:", TEST_EMAIL);

  try {
    await step("Sign-up: Open the sign-up page", async () => {
      await page.goto(BASE + "?auth=signup", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator('input[placeholder="First name"]').first().waitFor({ timeout: 45000 });
    });

    await step("Sign-up: Fill in and send the sign-up form", async () => {
      await page.locator('input[placeholder="First name"]').fill("Robot");
      await page.locator('input[placeholder="Second name"]').fill("Signup Test");
      const sel = page.locator("form select").first();
      const opts = await sel.locator("option").evaluateAll(os => os.map(o => o.value).filter(Boolean));
      await sel.selectOption(opts.includes("United Arab Emirates") ? "United Arab Emirates" : opts[0]);
      await page.locator('form input[type="email"]').fill(TEST_EMAIL);
      await page.locator('form input[type="password"]').fill(TEST_PASSWORD);
      await page.locator("form button:not([type=button])").first().click();
      // the form asks "Is this address right?" once before sending
      const yes = page.getByRole("button", { name: /send my confirmation link/i });
      await yes.waitFor({ timeout: 15000 }).then(() => yes.click()).catch(() => {});
      await page.getByText(/Account created/i).first().waitFor({ timeout: 45000 });
    });

    let info = null;
    await step("Sign-up: Confirmation email sent", async () => {
      for (let i = 0; i < 20; i++) {
        info = await check();
        if (info && info.exists && info.confirmation_sent_at && info.token_hash) break;
        await sleep(3000);
      }
      if (!info || !info.exists) throw new Error("The sign-up did not create an account.");
      if (!info.confirmation_sent_at) throw new Error("No confirmation email was sent.");
      if (!info.token_hash) throw new Error("The account has no confirmation link.");
    });

    await step("Sign-up: Open the confirmation link", async () => {
      const c = await robotApi();
      const link = `${c.url}/auth/v1/verify?token=${encodeURIComponent(info.token_hash)}&type=signup&redirect_to=${encodeURIComponent(BASE)}`;
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForURL(u => String(u).startsWith(BASE), { timeout: 45000 });
      if (/error=|error_description=/.test(page.url())) throw new Error("The confirmation link showed an error: " + decodeURIComponent(page.url()).slice(0, 200));
      for (let i = 0; i < 15; i++) { info = await check(); if (info.confirmed) break; await sleep(2000); }
      if (!info.confirmed) throw new Error("The link opened but the email is still not confirmed.");
    });

    await step("Sign-up: Company and Welcome Pack created", async () => {
      for (let i = 0; i < 30; i++) { info = await check(); if (info.company_id) break; await sleep(3000); }
      if (!info.company_id) throw new Error("No company was created for the new customer.");
      if (!info.welcome_pack) throw new Error(`The new customer did not get a Welcome Pack (plan: ${info.plan || "none"}).`);
    });
  } catch (e) {
    failedStep = e.robotStep || "Sign-up: journey"; failMsg = String(e.message || e).slice(0, 400);
  }

  // always remove the test account (and any left behind by an earlier run)
  try { const n = await rpc("q_robot_signup_cleanup", { p_email: TEST_EMAIL }); log("test accounts removed:", n); }
  catch (e) { log("clean-up failed:", e.message); steps.push({ step: "Sign-up: remove the test account", ok: false, error: e.message.slice(0, 300) }); }

  await shot(failedStep ? "signup-end-failed" : "signup-end-ok");
  await browser.close();
  await report(!failedStep, failedStep, failMsg);
  log(failedStep ? "SIGN-UP ROBOT FAILED at: " + failedStep : "SIGN-UP ROBOT OK", "in", Math.round((Date.now() - started) / 1000) + "s");
  if (failedStep) process.exitCode = 1;
})();
