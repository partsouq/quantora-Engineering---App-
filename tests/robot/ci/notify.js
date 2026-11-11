// Push a note to the admins' phones from a GitHub workflow (2026-11-11, used by autofix.yml).
// Signs in as the test robot account (secrets ROBOT_EMAIL / ROBOT_PASSWORD) and calls q_autofix_notify.
// Usage: node notify.js "<title>" "<body>"     Never fails the workflow: errors are only logged.
const BASE = process.env.ROBOT_URL || "https://quantoraengineering.com/";
(async () => {
  const [title, body] = process.argv.slice(2);
  try {
    const html = await (await fetch(BASE + "?notify=" + Date.now(), { cache: "no-store" })).text();
    const url = (html.match(/SUPABASE_URL = "([^"]+)"/) || [])[1];
    const key = (html.match(/SUPABASE_ANON_KEY = "([^"]+)"/) || [])[1];
    const tok = await (await fetch(url + "/auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: key, "content-type": "application/json" },
      body: JSON.stringify({ email: process.env.ROBOT_EMAIL, password: process.env.ROBOT_PASSWORD }),
    })).json();
    if (!tok.access_token) throw new Error("sign-in failed");
    const r = await fetch(url + "/rest/v1/rpc/q_autofix_notify", {
      method: "POST", headers: { apikey: key, authorization: "Bearer " + tok.access_token, "content-type": "application/json" },
      body: JSON.stringify({ p_title: title || "Quantora auto-fix", p_body: body || "" }),
    });
    console.log("notify:", r.status);
  } catch (e) { console.log("notify failed (ignored):", e.message); }
})();
