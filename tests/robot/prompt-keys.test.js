// Checks that the robots skip every one-time pop-up the website shows after sign-in.
// A pop-up the robot does not know about covers the page and makes its next click time out
// (2026-11-09: "Name your AI assistant" broke "Create a project").
// Run: node tests/robot/prompt-keys.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..", "..");
const keys = ["qfb:abc", "q_feedback_asked_at", "q_pulse_at", "q_assist_asked:00000000-0000-0000-0000-000000000000"];

for (const file of ["robot.js", "signup.js"]) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  const m = src.match(/Storage\.prototype\.getItem = function \(k\) \{ if \((\/.+?\/)\.test\(k\)\)/);
  assert(m, file + ": localStorage skip list not found");
  const re = eval(m[1]);
  for (const k of keys) assert(re.test(k), `${file}: does not skip the pop-up key "${k}"`);
  assert(!re.test("sb-auth-token"), `${file}: skip list is too wide`);
}

// Each key the website uses to remember "already asked" must be in the list above.
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
for (const k of ["q_assist_asked:", "q_feedback_asked_at", "q_pulse_at"]) {
  assert(html.includes(k), `index.html no longer uses "${k}" — update this test`);
}
console.log("ok: robots skip all one-time pop-ups");
