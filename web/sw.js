// =====================================================================
// Service worker: el "proceso de fondo" de la PWA.
// Hace dos trabajos:
//  1) Recibir notificaciones push aunque la app esté cerrada (evento `push`).
//  2) Guardar el cascarón de la app (HTML/CSS/JS) para que abra al instante y sin red.
// Los DATOS nunca se guardan en caché: siempre se piden frescos a la API.
// =====================================================================
const VERSION = "v3";
const CACHE = `alertas-gol-${VERSION}`;
const CASCARON = ["./", "index.html", "styles.css", "app.js", "config.js", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCARON)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // la API va directo a la red
  // "Red primero, caché de respaldo": siempre la última versión si hay internet.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { titulo: "Alertas de Gol", cuerpo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Alertas de Gol", {
    body: d.cuerpo || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: d.tag || undefined,      // mismo tag = reemplaza la notificación anterior en vez de apilar
    renotify: !!d.tag,
    vibrate: [200, 100, 200],
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destino = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if (c.url.startsWith(self.registration.scope)) { c.navigate(destino); return c.focus(); }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
