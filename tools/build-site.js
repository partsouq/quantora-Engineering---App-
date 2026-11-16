// Builds the published website from the working files (16 Nov 2026, owner approved).
// The working copy stays readable; what visitors receive is compiled and scrambled:
//   - the app is compiled ahead of time (no Babel in the browser, so it also starts faster)
//   - all code is minified: comments removed, inner names shortened
//   - comments are removed from the style sheets
// Usage: node tools/build-site.js <out dir>      (needs @babel/standalone and terser)
const fs = require("fs"), path = require("path");
const Babel = require("@babel/standalone");
const { minify } = require("terser");
const ROOT = path.resolve(__dirname, ".."), OUT = path.resolve(process.argv[2] || "_site");
const SKIP = new Set([".git", ".github", "tests", "supabase", "tools", "node_modules", "_site", ".gitignore"]);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const n of fs.readdirSync(src)) {
    if (SKIP.has(n) && src === ROOT) continue;
    const a = path.join(src, n), b = path.join(dst, n);
    if (fs.statSync(a).isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  }
}
const noScriptEnd = (js) => js.replace(/<\/(script)/gi, "<\\/$1");
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
async function tiny(js) {
  const r = await minify(js, { compress: { passes: 1 }, mangle: true, format: { comments: false }, toplevel: false });
  if (r.code === undefined) throw new Error("minify failed");
  return r.code;
}

async function buildIndex(file) {
  let s = fs.readFileSync(file, "utf8");
  const m = s.match(/<script type="text\/plain" id="app-source">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("app-source not found");
  const compiled = Babel.transform(m[1], { presets: [["react", { runtime: "classic" }], "typescript"], filename: "app.tsx", comments: false, compact: false }).code;
  const app = noScriptEnd(await tiny(compiled));
  s = s.replace(m[0], () => `<script type="text/plain" id="app-compiled">${app}</script>`);
  // the start-up reads the compiled app and never downloads Babel
  const boot = /var source = document\.getElementById\("app-source"\)\.textContent;\s*var output = Babel\.transform\(source, \{[\s\S]*?\}\)\.code;/;
  if (!boot.test(s)) throw new Error("boot block not found");
  s = s.replace(boot, 'var output = document.getElementById("app-compiled").textContent;');
  const lib = 'var okBabel = await __loadLib([';
  if (!s.includes(lib)) throw new Error("babel loader not found");
  s = s.replace(lib, 'var okBabel = true || await __loadLib([');
  // every other inline script: minified; style sheets: no comments; html comments removed
  const parts = [];
  for (const mm of s.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="(?:text\/plain|application\/ld\+json|application\/json)")([^>]*)>([\s\S]*?)<\/script>/g)) parts.push(mm);
  for (const mm of parts.reverse()) {
    let code;
    try { code = noScriptEnd(await tiny(mm[2])); } catch (e) { code = mm[2]; }
    s = s.slice(0, mm.index) + `<script${mm[1]}>${code}</script>` + s.slice(mm.index + mm[0].length);
  }
  s = s.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, a, b, c) => a + stripCssComments(b) + c);
  s = s.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
  // Visitors see nothing in the browser console (16 Nov 2026, owner approved). Errors are still
  // reported to the server by the app's own error reporter. Add ?debug=1 once to see the console
  // again on that browser (stored as q_debug).
  const quiet = '<script>(function(){try{var d=/[?&]debug=1/.test(location.search);if(d)localStorage.setItem("q_debug","1");if(d||localStorage.getItem("q_debug")==="1")return;}catch(e){}var n=function(){};["log","info","debug","warn","error","trace","table","dir","group","groupCollapsed","groupEnd","time","timeEnd","count","assert"].forEach(function(k){try{console[k]=n}catch(e){}});})();</script>';
  s = s.replace(/<head>/i, (h) => h + quiet);
  fs.writeFileSync(file, s);
  return s.length;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  copyTree(ROOT, OUT);
  const before = fs.statSync(path.join(ROOT, "index.html")).size, after = await buildIndex(path.join(OUT, "index.html"));
  for (const f of ["sw.js", "visit.js"]) { const p = path.join(OUT, f); if (fs.existsSync(p)) try { fs.writeFileSync(p, await tiny(fs.readFileSync(p, "utf8"))); } catch (e) {} }
  console.log(`built ${OUT}: index.html ${before} -> ${after} bytes`);
})().catch((e) => { console.error("BUILD FAILED:", e.message); process.exit(1); });
