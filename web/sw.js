// =====================================================================
// Service worker: el "proceso de fondo" de la PWA.
// Hace dos trabajos:
//  1) Recibir notificaciones push aunque la app esté cerrada (evento `push`).
//  2) Guardar el cascarón de la app (HTML/CSS/JS) para que abra al instante y sin red.
// Los DATOS nunca se guardan en caché: siempre se piden frescos a la API.
// =====================================================================
// Botones Entré / No entro (spec 1.6): el service worker marca la entrada sin abrir la app.
// Lee la URL de la API de config.js y el token de sesión de IndexedDB (localStorage no existe aquí).
importScripts("config.js");
const VERSION = "v19";
const CACHE = `alertas-gol-${VERSION}`;
const CASCARON = ["./", "index.html", "styles.css", "marca.js", "app.js", "acceso.js", "config.js", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCARON.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
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
    // no-cache: revalida con el servidor y no usa la copia del navegador (GitHub Pages la guarda 10 min,
    // por eso un cambio de estilos podía tardar en verse)
    fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { titulo: "ADN Soccer", cuerpo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "ADN Soccer", {
    body: d.cuerpo || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: d.tag || undefined,      // mismo tag = reemplaza la notificación anterior en vez de apilar
    renotify: !!d.tag && !d.suave,
    // Alerta: doble vibración. Aviso de candidato ("suave"): una sola corta, para distinguirlos sin mirar.
    vibrate: d.suave ? [120] : [200, 100, 200],
    actions: d.acciones && d.alerta_id ? [{ action: "entre", title: "Entré" }, { action: "no_entro", title: "No entro" }] : [],
    data: { url: d.url || "./", alerta_id: d.alerta_id || null },
  }));
});

function leerSesion() {
  return new Promise((ok) => {
    try {
      const req = indexedDB.open("adn", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => {
        const g = req.result.transaction("kv", "readonly").objectStore("kv").get("sesion");
        g.onsuccess = () => ok(g.result || null); g.onerror = () => ok(null);
      };
      req.onerror = () => ok(null);
    } catch (_) { ok(null); }
  });
}

async function marcarDesdeNotificacion(n, decision) {
  const sesion = await leerSesion();
  const alerta = n.data?.alerta_id;
  try {
    if (!sesion || !alerta) throw new Error("sin sesión");
    const r = await fetch(self.CONFIG.API + "/entradas", {
      method: "POST", headers: { "Content-Type": "application/json", "x-sesion": sesion },
      body: JSON.stringify({ alerta_id: Number(alerta), decision, origen: "notificacion" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "error");
    // Reemplaza la notificación (mismo tag) por una confirmación silenciosa
    await self.registration.showNotification(decision === "entre" ? "Listo: marcaste Entré" : "Listo: no entras en este", {
      body: decision === "entre" ? "Si quieres, abre la app y escribe con cuánto entraste. Ya no te recordamos este partido."
                                 : "Ya no te recordamos este partido.",
      icon: "icons/icon-192.png", badge: "icons/badge-96.png", tag: n.tag || undefined, renotify: false, silent: true,
      data: { url: "./#ahora" },
    });
  } catch (_) {
    // Sin sesión o sin red: se abre la app en Ahora para marcarlo ahí
    return abrir("./#ahora");
  }
}

function abrir(url) {
  const destino = new URL(url || "./", self.registration.scope).href;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) {
      if (c.url.startsWith(self.registration.scope)) { c.navigate(destino); return c.focus(); }
    }
    return self.clients.openWindow(destino);
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (e.action === "entre" || e.action === "no_entro") return e.waitUntil(marcarDesdeNotificacion(e.notification, e.action));
  e.waitUntil(abrir(e.notification.data?.url));
});
