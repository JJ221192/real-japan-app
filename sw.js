/*
 * REAL JAPAN offline cache (decisions D29).
 * - Scope comes from the registration, so it works at "/" and under the GitHub Pages basePath.
 * - Install precaches the app shell for Travel and My Page (HTML + the JS/CSS/fonts they reference),
 *   so phrases and the saved Trip Kit open with no connection after the first visit.
 * - Pages: network-first (fresh content when online), cache fallback offline.
 * - /_next/static/*: cache-first (file names are content-hashed).
 * - Other same-origin GETs: stale-while-revalidate.
 * Purchase/entitlement data is never cached here (there is none in Phase0).
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `real-japan-${VERSION}`;
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname.replace(/\/$/, ""); // "" or "/real-japan-app"
const SHELL = ["/", "/travel", "/my-japan"];

const pageKey = (url) => {
  const u = new URL(url, SCOPE);
  const path = u.pathname.replace(/\/index\.html$/, "").replace(/\/$/, "") || BASE || "/";
  return new URL(path, SCOPE).href;
};

async function cleanCopy(res) {
  // a redirected response can't be used to answer a navigation; copy the body
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function precache() {
  const cache = await caches.open(CACHE);
  const assets = new Set();
  for (const p of SHELL) {
    const url = new URL(BASE + p, SCOPE.origin).href;
    try {
      const res = await fetch(url, { cache: "reload", credentials: "same-origin" });
      if (!res.ok) continue;
      const html = await res.clone().text();
      await cache.put(pageKey(url), await cleanCopy(res));
      for (const m of html.matchAll(/["'(]([^"'()]*\/_next\/static\/[^"'()\s]+)/g)) assets.add(m[1]);
    } catch {
      // offline during install: keep going, runtime caching fills gaps later
    }
  }
  for (const a of Array.from(assets)) {
    const url = new URL(a, SCOPE.origin).href;
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) continue;
      if (url.endsWith(".css")) {
        const css = await res.clone().text();
        for (const m of css.matchAll(/url\(([^)]+\/_next\/static\/media\/[^)]+)\)/g)) {
          const fontUrl = new URL(m[1].replace(/["']/g, ""), url).href;
          const f = await fetch(fontUrl).catch(() => null);
          if (f && f.ok) await cache.put(fontUrl, f);
        }
      }
      await cache.put(url, res);
    } catch {
      // ignore single asset failures
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("real-japan-") && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function offlinePage() {
  const home = BASE + "/";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · REAL JAPAN</title><body style="font-family:system-ui,sans-serif;background:#f5f3ef;color:#111315;padding:32px 20px;line-height:1.6">
<h1 style="font-size:22px">You're offline</h1><p>This page hasn't been saved on this device yet.</p>
<p>These work offline after your first visit:</p>
<p><a href="${BASE}/travel/">Travel phrases</a> · <a href="${BASE}/my-japan/">My Page (saved Trip Kit)</a></p>
<p><a href="${home}">Try again</a></p></body></html>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(BASE + "/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) await cache.put(pageKey(req.url), await cleanCopy(res.clone()));
          return res;
        } catch {
          return (await cache.match(pageKey(req.url))) || offlinePage();
        }
      })(),
    );
    return;
  }

  if (url.pathname.includes("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: false });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit || Response.error());
      return hit || network;
    }),
  );
});
