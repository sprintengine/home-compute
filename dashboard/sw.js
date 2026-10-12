// The dashboard's service worker: its static files work offline (fetched
// from the network while there is one, from the cache when there is not).
// The API (/v1/*) and Cloudflare Access (/cdn-cgi/*) are never cached: they
// always go to the network, so nothing a person may not see is kept here.

const CACHE = "hc-dashboard-v1";
const FILES = [
  "/", "/manifest.webmanifest", "/assets/app.css", "/assets/icon.svg", "/assets/app.js", "/assets/lib.js", "/assets/ui.js",
  "/assets/data.js", "/assets/overview.js", "/assets/job.js", "/assets/run.js", "/assets/machines.js", "/assets/timetable.js",
  "/assets/admin.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(FILES.map((file) => cache.add(file).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

/** Only a whole, same-origin answer is kept: never an Access redirect or an error page. */
function keep(request, response) {
  if (response.ok && response.type === "basic" && !response.redirected) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/cdn-cgi/")) return;
  if (request.mode === "navigate") {
    // The page itself: the network first (Access may need to sign in again), the cached shell offline.
    event.respondWith(fetch(request).then((response) => keep(new Request("/"), response)).catch(() => caches.match("/")));
    return;
  }
  // Files: the network first, so a new release never mixes with an old module; the cache when offline.
  event.respondWith(fetch(request).then((response) => keep(request, response)).catch(() => caches.match(request)));
});
