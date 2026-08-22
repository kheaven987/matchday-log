// Service worker for Matchday Log — lets the app open even with zero network
// connectivity (useful at a venue with patchy WiFi/signal), by caching the app
// shell (this file, index.html, manifest, icons).
//
// Deliberately network-FIRST, not cache-first: this app gets pushed updates
// frequently, and a naive cache-first strategy would mean seeing a stale
// version after a fix ships until some separate "update available" flow
// fired. Network-first means every load with connectivity gets the latest
// version automatically (and refreshes the cache), and the cache only ever
// gets used as a fallback when there's genuinely no connection.
//
// Only intercepts same-origin GET requests — the API-Sports proxy, sync
// endpoint, Google Fonts, and the html2canvas CDN script all pass through
// untouched, since those are live/dynamic and must never be served stale.
const CACHE_NAME = 'matchday-log-v1';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't fail install over a caching hiccup
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
