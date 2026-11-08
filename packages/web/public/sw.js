/* LootDen's service worker: lets the web app install on phones and PCs, opens offline to the
   last page shell, and shows push notifications. API calls are never cached. */
const SHELL = "lootden-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add("/")).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Pages: the network first, then the last copy of the app when offline.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/emulators/")) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/", copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match("/").then((r) => r || Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let msg = { title: "LootDen" };
  try {
    msg = event.data ? event.data.json() : msg;
  } catch (e) {
    msg = { title: "LootDen", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || "LootDen", {
      body: msg.body || "",
      tag: msg.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { link: msg.link || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = new URL((event.notification.data && event.notification.data.link) || "/", location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === location.origin && "focus" in w) {
          w.navigate(link).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
