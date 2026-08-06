/* DEADPIXEL service worker — offline-first, versioned cache. */
const VERSION = 'dp-v1.3.0';
const CORE = [
  './', 'index.html', 'css/ui.css',
  'js/main.js', 'js/engine.js', 'js/brushes.js', 'js/tools.js',
  'js/filters.js', 'js/io.js', 'js/ui.js', 'js/vendor/fflate.js',
  'fonts/big-shoulders-var.woff2', 'fonts/vt323.woff2',
  'fonts/pack/fonts.css', 'fonts/pack/fonts.json',
  'icons/favicon.svg', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fetchAndCache = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => hit);
      // cache-first for fonts (immutable), network-first-ish for the rest via background refresh
      return hit || fetchAndCache;
    })
  );
});
