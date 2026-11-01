// Quantora service worker -- notifications only.
// Phones (Android Chrome) can only show a pop-up through a service worker. This file does nothing
// else: no caching and no fetch handling, so the website always loads fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { try { return await c.focus(); } catch (_) {} } }
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});

// Real push: arrives from the server even when no Quantora window is open.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Quantora", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Quantora", {
    body: d.body || "A customer is waiting in Live Chat.",
    icon: "/icon192.png", badge: "/icon192.png",
    tag: d.tag || "q-push", renotify: true, requireInteraction: true, vibrate: [200, 100, 200],
    data: { url: d.url || "/" },
  }));
});
