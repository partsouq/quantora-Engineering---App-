/* Quantora website visit counter (2026-11-09).
   Counts one visit per browser tab session. No cookies, nothing stored about the person:
   the server keeps only the page, the referring site, the campaign source and the country,
   plus a one-way daily code so the same visitor is counted once a day. Bots are ignored, and people
   already signed in to Quantora (our team and existing customers) are not counted as new visitors. */
(function () {
  try {
    if (navigator.webdriver) return;
    var k = "qv:" + location.pathname;
    if (sessionStorage.getItem(k)) return;
    sessionStorage.setItem(k, "1");
  } catch (e) {}
  try {
    var u = new URL(location.href), ref = "";
    try { if (document.referrer) { ref = new URL(document.referrer).hostname; if (ref === location.hostname) ref = ""; } } catch (e) {}
    var src = u.searchParams.get("utm_source") || u.searchParams.get("ref") || "";
    var m = "";
    try { for (var i = 0; i < localStorage.length; i++) { if (/^sb-.*-auth-token$/.test(localStorage.key(i) || "")) { m = "1"; break; } } } catch (e) {}
    fetch("https://mcwcvyuvlkmqsivnzvjy.supabase.co/rest/v1/rpc/q_site_visit", {
      method: "POST", keepalive: true,
      headers: { "content-type": "application/json", apikey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jd2N2eXV2bGttcXNpdm56dmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ5OTksImV4cCI6MjEwMDc0MDk5OX0.YhwsYhxZOyNjCKqeycQorP88TDqCSYRsZutwWnvoRY0", authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jd2N2eXV2bGttcXNpdm56dmp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjQ5OTksImV4cCI6MjEwMDc0MDk5OX0.YhwsYhxZOyNjCKqeycQorP88TDqCSYRsZutwWnvoRY0" },
      body: JSON.stringify({ p: { path: location.pathname, ref: ref, src: src.slice(0, 60), m: m } })
    }).catch(function () {});
  } catch (e) {}
})();
