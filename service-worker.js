
// service-worker.js

// A version for the cache. Change this to force an update of the cached files.
const CACHE_VERSION = 1;
const CACHE_NAME = `nimfile-cache-v${CACHE_VERSION}`;

// The list of files that make up the "app shell" that will be cached on install.
const APP_SHELL_URLS = [
  '/', // Caches the root URL (index.html)
  'index.html',
  'about.html',
  'terms.html',
  'style.css',
  'main.js',
  'theme.js',
  'manifest.json',
  'assets/icon.png',
  'assets/favicon.png',
  'assets/icon-192x192.png',
  'assets/icon-512x512.png',
  // External dependencies from CDNs
  'https://fonts.googleapis.com/icon?family=Material+Icons',
  'https://cdn.jsdelivr.net/npm/web-streams-polyfill@2.0.2/dist/ponyfill.min.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.3/StreamSaver.min.js',
  'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js'
];

/**
 * The install event is fired when the service worker is first installed.
 * We use this to pre-cache our app shell.
 */
self.addEventListener('install', event => {
  console.log('[Service Worker] Install');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Service Worker] Pre-caching app shell');
      return cache.addAll(APP_SHELL_URLS);
    })
  );
});

/**
 * The activate event is fired after installation.
 * We use this to clean up old caches.
 */
self.addEventListener('activate', event => {
  console.log('[Service Worker] Activate');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // If a cache is not our current one, delete it.
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

/**
 * The fetch event is fired for every network request.
 * We use a "Cache, falling back to network" strategy.
 */
self.addEventListener('fetch', event => {
  // We only want to cache GET requests.
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 1. Check if the request is already in the cache.
      const cachedResponse = await cache.match(event.request);
      if (cachedResponse) {
        // If we found it in the cache, return it.
        return cachedResponse;
      }

      // 2. If not in cache, fetch from the network.
      try {
        const networkResponse = await fetch(event.request);
        // If the fetch is successful, clone the response and store it in the cache for next time.
        // This is useful for caching resources loaded on-demand, like the actual font files.
        if (networkResponse.ok) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (error) {
        // If the network fetch fails (e.g., user is offline), we can't do much
        // since the item wasn't in the cache. The browser will show its default offline error.
        console.error('[Service Worker] Fetch failed; returning offline page instead.', error);
        // Optionally, you could return a generic offline fallback page here.
      }
    })
  );
});
