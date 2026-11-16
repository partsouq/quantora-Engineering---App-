// Takes the admin screens out of the code every visitor downloads (16 Nov 2026, owner approved).
// The admin part goes into a locked pack inside the page. Only a signed-in owner or Admin Team member
// can open it: the server (admin-analytics, action "admin_unlock") hands back the pack's key after it
// has checked who is asking. Everyone else downloads only the locked bytes.
//
// How the split is chosen: start from the admin entry screens (ROOTS) and add every top-level piece of
// code that is used only by admin code. Anything also used elsewhere stays in the public code. Each
// entry screen is replaced by a small stand-in that opens the pack when it is first shown.
const crypto = require("crypto");
const Babel = require("@babel/standalone");

const ROOTS = ["AdminPortal", "AdminLiveChatWatcher"];

function walkIds(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) walkIds(n, out); return; }
  if (node.type === "Identifier" || node.type === "JSXIdentifier") out.add(node.name);
  for (const k in node) {
    if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
    const v = node[k];
    if (v && typeof v === "object") walkIds(v, out);
  }
}

function declNames(st) {
  if (st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") return st.id ? [st.id.name] : [];
  if (st.type === "VariableDeclaration") {
    const names = [];
    for (const d of st.declarations) { const s = new Set(); walkIds(d.id, s); names.push(...s); }
    return names;
  }
  return [];
}

function split(code) {
  const ast = Babel.transform(code, { ast: true, code: false, sourceType: "script", babelrc: false, configFile: false }).ast;
  const body = ast.program.body;
  const items = body.map((st) => {
    const names = declNames(st);
    const ids = new Set(); walkIds(st, ids);
    for (const n of names) ids.delete(n);
    return { st, names, ids, start: st.start, end: st.end };
  });
  const byName = new Map();
  items.forEach((it, i) => it.names.forEach((n) => byName.set(n, i)));
  for (const r of ROOTS) if (!byName.has(r)) throw new Error(`admin split: ${r} not found`);
  // who refers to each item
  const users = items.map(() => new Set());
  items.forEach((it, i) => { for (const id of it.ids) { const j = byName.get(id); if (j !== undefined && j !== i) users[j].add(i); } });
  const inPack = new Set(ROOTS.map((r) => byName.get(r)));
  for (let grew = true; grew;) {
    grew = false;
    items.forEach((it, i) => {
      if (inPack.has(i) || !it.names.length || it.names.length > 1) return;
      const u = users[i];
      if (u.size && [...u].every((j) => inPack.has(j))) { inPack.add(i); grew = true; }
    });
  }
  // the entry screens are reached from public code through stand-ins; nothing else may be
  for (const i of inPack) {
    const n = items[i].names[0];
    if (ROOTS.includes(n)) continue;
    for (const j of users[i]) if (!inPack.has(j)) throw new Error(`admin split: ${n} is used outside admin`);
  }
  const order = [...inPack].sort((a, b) => a - b);
  let pack = "(function(){\n";
  for (const i of order) pack += code.slice(items[i].start, items[i].end) + "\n";
  pack += `window.__qAdm={${ROOTS.map((r) => `${r}:${r}`).join(",")}};\n})();`;
  let main = "";
  let at = 0;
  for (const i of order) {
    main += code.slice(at, items[i].start);
    const n = items[i].names[0];
    if (ROOTS.includes(n)) main += `var ${n} = __qAdmStub(${JSON.stringify(n)});`;
    at = items[i].end;
  }
  main += code.slice(at);
  main = LOADER + "\n" + main;
  return { main, pack, names: order.map((i) => items[i].names[0]) };
}

// The stand-in shows "Opening admin..." while the pack is fetched and opened, then the real screen.
const LOADER = `
var __qAdmP = null;
function __qAdmLoad() {
  if (window.__qAdm) return Promise.resolve();
  if (__qAdmP) return __qAdmP;
  __qAdmP = (async function () {
    var el = document.getElementById("q-adm");
    if (!el) throw new Error("admin pack missing");
    var p = JSON.parse(el.textContent);
    var r = await callAdminAnalytics("admin_unlock", { wk: p.wk });
    if (!r || !r.k) throw new Error("admin pack locked");
    var b = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
    var key = await crypto.subtle.importKey("raw", b(r.k), "AES-GCM", false, ["decrypt"]);
    var ct = b(p.ct), tag = b(p.tag), all = new Uint8Array(ct.length + tag.length);
    all.set(ct); all.set(tag, ct.length);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(p.iv) }, key, all);
    // a direct eval, so the admin code sees the public code it uses (its constants live in this scope)
    eval(new TextDecoder().decode(pt));
    if (!window.__qAdm) throw new Error("admin pack empty");
  })();
  __qAdmP.catch(function () { __qAdmP = null; });
  return __qAdmP;
}
function __qAdmStub(name) {
  var S = function (props) {
    var st = React.useState(window.__qAdm ? 1 : 0), f = st[1];
    React.useEffect(function () {
      if (window.__qAdm) return;
      var on = true;
      __qAdmLoad().then(function () { if (on) f(1); }, function () { if (on) f(2); });
      return function () { on = false; };
    }, []);
    var m = window.__qAdm;
    if (m && m[name]) return React.createElement(m[name], props);
    if (name !== "AdminPortal") return null;
    return React.createElement("div", { style: { padding: "60px 20px", textAlign: "center", color: "#64748b", fontSize: 14 } },
      st[0] === 2 ? React.createElement("span", null, "Admin could not open. ",
        React.createElement("button", { onClick: function () { f(0); __qAdmLoad().then(function () { f(1); }, function () { f(2); }); }, style: { textDecoration: "underline" } }, "Try again"))
        : "Opening admin\\u2026");
  };
  S.displayName = name;
  return S;
}
`;

// AES-256-GCM with a fresh key each build; the key is wrapped with the server's public key.
function lock(pack, publicPem) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(pack, "utf8"), c.final()]), tag = c.getAuthTag();
  const wk = crypto.publicEncrypt({ key: publicPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64"), wk: wk.toString("base64") };
}

module.exports = { split, lock, ROOTS };
