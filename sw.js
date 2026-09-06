const CACHE = "pon-se-board-v4-3-iphone-shapes";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=4.3.0",
  "./v4.css?v=4.3.0",
  "./v43.css?v=4.3.0",
  "./app.js?v=4.3.0",
  "./permission-fix.js?v=4.3.0",
  "./owner-sync-fix.js?v=4.3.0",
  "./v43-fix.js?v=4.3.0",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache:"no-store" }).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
  );
});
