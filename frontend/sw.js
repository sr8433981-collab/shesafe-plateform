/**
 * SheSafe service worker.
 *
 * Deliberately conservative about location and emergency data:
 *
 * * **The app shell is cached** so the dashboard opens offline and the emergency
 *   information is reachable without a network.
 * * **No API response is ever cached or replayed.** A stale SOS record or a stale
 *   location is worse than an error, so `/api/*` always goes to the network.
 * * **Offline emergency information is baked into the shell** as a static page,
 *   because a helpline number must not depend on connectivity.
 * * Background Sync is not used: the OS may never fire it, and pretending
 *   otherwise would be a lie about capability.
 */

const VERSION = 'shesafe-v6';
const SHELL_CACHE = `${VERSION}-shell`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './track.html',
  './offline.html',
  './css/app.css',
  './js/app.js',
  './js/track.js',
  './js/core/api.js',
  './js/core/dom.js',
  './js/core/ui.js',
  './js/core/store.js',
  './js/core/router.js',
  './js/core/feedback.js',
  './js/core/location.js',
  './js/core/mapkit.js',
  './js/modules/dashboard.js',
  './js/modules/sos.js',
  './js/modules/sharing.js',
  './js/modules/contacts.js',
  './js/modules/intelligence.js',
  './js/modules/places.js',
  './js/modules/journey.js',
  './js/modules/reports.js',
  './js/modules/security.js',
  './js/modules/voice.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll fails the whole install if any single asset 404s, so add
      // individually and tolerate partial success.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'shesafe:skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Leaflet CDN, fonts, tiles
  if (url.pathname.startsWith('/api/')) return; // never cache API responses

  // Navigations: network first, cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('./index.html', { ignoreSearch: true });
        return cached || new Response(
          '<!doctype html><meta charset="utf-8"><title>SheSafe is offline</title>'
          + '<body style="font:16px system-ui;padding:24px">'
          + '<h1>SheSafe is offline</h1>'
          + '<p>The app could not reach the network. In an emergency call <a href="tel:112">112</a>.</p>'
          + '</body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
        );
      }),
    );
    return;
  }

  // Static assets: cache first, revalidate in the background.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
