/**
 * SheSafe service worker.
 *
 * Deliberately conservative about location and emergency data:
 *
 * * **The app shell is cached** so the dashboard opens offline and the SOS button
 *   is always reachable. Static assets only, never API responses.
 * * **No API response is ever cached or replayed.** A stale SOS record or a stale
 *   location is worse than an error, so `/api/*` always goes to the network.
 * * Background Sync is not used: the OS may never fire it, and pretending
 *   otherwise would be a lie about capability.
 */

const VERSION = 'shesafe-v2';
const SHELL_CACHE = `${VERSION}-shell`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './track.html',
  './css/app.css',
  './js/app.js',
  './js/track.js',
  './js/core/api.js',
  './js/core/dom.js',
  './js/core/store.js',
  './js/core/router.js',
  './js/core/feedback.js',
  './js/core/location.js',
  './js/core/mapkit.js',
  './js/modules/sos.js',
  './js/modules/sharing.js',
  './js/modules/contacts.js',
  './js/modules/intelligence.js',
  './js/modules/places.js',
  './js/modules/journey.js',
  './js/modules/reports.js',
  './js/modules/voice.js',
  './manifest.webmanifest',
  './icons/icon.svg',
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Leaflet CDN, fonts, tiles
  if (url.pathname.startsWith('/api/')) return; // never cache API responses

  // Navigations: network first, cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html', { ignoreSearch: true })),
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