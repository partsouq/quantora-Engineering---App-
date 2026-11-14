// Look switch (Classic / Glass): checks the engine in index.html without a browser.
//   node tests/look/look.test.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); } };

const m = html.match(/<script id="q-look-runtime">([\s\S]*?)<\/script>/);
ok("engine script is in the page", !!m);
const boot = store => {
  const keys = Object.keys(store);
  const ctx = { window: {}, document: {}, console, setTimeout, localStorage: { length: keys.length, key: i => keys[i], getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  vm.createContext(ctx); vm.runInContext(m[1], ctx); return ctx.window.QLook;
};

// 1. nothing changes unless a signed-in user picked glass
let Q = boot({});
ok("off for a new visitor", Q.want === "" && Q.on === "" && Q.cssOn === "");
Q = boot({ q_look_last: "glass" });
ok("off when signed out, even if glass was used before", Q.want === "");
Q = boot({ q_look_last: "glass", "sb-x-auth-token": "{}" });
ok("glass shows at once for a signed-in glass user", Q.want === "glass");
Q = boot({ q_look_last: "warm", "sb-x-auth-token": "{}" });
ok("warm shows at once for a signed-in warm user", Q.want === "warm");
Q = boot({ q_look_last: "classic", "sb-x-auth-token": "{}" });
ok("classic user stays classic", Q.want === "");

// 2. the choice: this device first, then the account, else none (= ask once, default classic)
const st = {}; Q = boot(st);
ok("no choice yet", Q.read("u1", {}) === null);
ok("choice from the account", Q.read("u1", { q_look: "glass" }) === "glass");
Q.save("u1", "classic");
ok("choice on this device wins", Q.read("u1", { q_look: "glass" }) === "classic" && st["q_look_asked:u1"] === "1");
Q.save("u1", "neon");
ok("an unknown look is ignored", Q.read("u1", {}) === "classic");

// 3. colours
const tr = c => Q._tr(c, "glass"), lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
ok("dark surface becomes frosted white", tr(".a{background:#0e1538}") === ".a{background:rgba(255,255,255,0.46)}", tr(".a{background:#0e1538}"));
ok("pure white is left alone", tr(".a{color:#fff;background:#ffffff}") === ".a{color:#fff;background:#ffffff}");
for (const c of ["#eef3fb", "#a9b8cc", "#7f93b0", "#fbbf24", "#f59e0b", "#34d399", "#a5b4fc", "#c4b5fd", "#f43f5e", "#0f172a", "#93c5fd"]) {
  const o = tr(".a{color:" + c + "}"), h = (o.match(/#[0-9a-f]{6}/) || [])[0];
  ok("text " + c + " ends up dark enough to read", !!h && lum(h) < 0.30, o);
}
ok("see-through white text becomes ink", /rgba\(12,36,64,0\.[6-9]\d*\)/.test(tr(".a{color:rgba(255,255,255,.6)}")), tr(".a{color:rgba(255,255,255,.6)}"));
ok("the font is swapped", tr('.a{font-family:"Plus Jakarta Sans"}') === '.a{font-family:"Inter"}');

// 4. every text colour in the real style sheets ends up readable (white is handled by the page at run time)
const page = html.replace(/<script type="text\/plain" id="app-source">[\s\S]*?<\/script>/, "");
let bad = [];
for (const b of page.matchAll(/<style(?![^>]*(?:id="q-glass"|data-ql="0"))[^>]*>([\s\S]*?)<\/style>/g))
  for (const d of tr(b[1]).matchAll(/(?:^|[;{\s])color\s*:\s*(#[0-9a-f]{6})\b/g)) if (d[1] !== "#ffffff" && lum(d[1]) > 0.33) bad.push(d[1]);
ok("no pale text left in the glass style sheets", bad.length === 0, [...new Set(bad)].slice(0, 12).join(" "));

// 4b. warm: text readable too; slate: a dark look (surfaces stay dark, violet becomes teal, white stays white)
bad = [];
for (const b of page.matchAll(/<style(?![^>]*(?:id="q-|data-ql="0"))[^>]*>([\s\S]*?)<\/style>/g))
  for (const d of Q._tr(b[1], "warm").matchAll(/(?:^|[;{\s])color\s*:\s*(#[0-9a-f]{6})\b/g)) if (d[1] !== "#ffffff" && lum(d[1]) > 0.33) bad.push(d[1]);
ok("no pale text left in the warm style sheets", bad.length === 0, [...new Set(bad)].slice(0, 12).join(" "));
const sl = c => Q._tr(c, "slate");
ok("slate: navy surface becomes slate", (() => { const h = sl(".a{background:#0e1538}").match(/#[0-9a-f]{6}/)[0]; return lum(h) < 0.05 && h !== "#0e1538"; })(), sl(".a{background:#0e1538}"));
ok("slate: violet becomes teal", /#[0-9a-f]{6}/.test(sl(".a{color:#7c3aed}")) && (() => { const h = sl(".a{color:#7c3aed}").match(/#([0-9a-f]{6})/)[1]; const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16); return g > r; })(), sl(".a{color:#7c3aed}"));
ok("slate: white text stays white", sl(".a{color:rgba(255,255,255,.7)}") === ".a{color:rgba(255,255,255,.7)}");
for (const id of ["q-look-slate", "q-look-warm"]) ok(id + " ships switched off", new RegExp('<style id="' + id + '" media="not all">').test(html));
ok("warm backdrop picture is in the repo", fs.existsSync(path.join(__dirname, "../../ws-art2/warm-room.jpg")));
Q.save("u2", "slate"); ok("slate can be saved", Q.read("u2", {}) === "slate");

// 5. the page: glass sheet is off by default, the chooser sheet is never recoloured, robots skip the chooser
ok("glass sheet ships switched off", /<style id="q-glass" media="not all">/.test(html));
ok("chooser sheet is marked never-recolour", /<style id="q-look-ui" data-ql="0">/.test(html));
for (const f of ["robot.js", "signup.js"]) ok(f + " skips the one-time chooser", /\^q_look_asked:/.test(fs.readFileSync(path.join(__dirname, "../robot", f), "utf8")));

console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
