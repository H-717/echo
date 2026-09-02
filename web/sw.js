// Cache-first for everything we ship, so a repeat visit never waits on the
// network. The old site was network-first, which meant offline worked but slow
// connections still paid full price on every load.

const VERSION = 'sb-1';
const SHELL = [
  './', './index.html', './app.css', './app.js', './store.js', './render.js',
  './chords.js', './groove.js', './idb.js', './fold.js', './sync-worker.js',
  './manifest.webmanifest', './assets/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Deep links like /1482/amazing-grace are app routes, not files.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((r) => r || fetch(req)));
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
