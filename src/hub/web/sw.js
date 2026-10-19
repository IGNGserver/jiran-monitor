/* Jiran hub web shell — cache app shell for offline reopen on mobile. */
const CACHE = 'jiran-web-v8-fluent';
const PRECACHE = [
  '/',
  '/index.html',
  '/js/boot.js',
  '/ui/styles/app.css',
  '/ui/styles/fluent-tokens.css',
  '/ui/vendor/fluent.js',
  '/ui/core/fluent.js',
  '/ui/core/syncHealth.js',
  '/ui/app.js',
  '/ui/transport/index.js',
  '/ui/transport/httpTransport.js',
  '/ui/core/i18n.js',
  '/ui/core/format.js',
  '/ui/core/data.js',
  '/ui/core/viewContext.js',
  '/ui/views/accounts.js',
  '/ui/views/devices.js',
  '/ui/views/home.js',
  '/ui/views/limits.js',
  '/ui/views/rows.js',
  '/ui/views/settings.js',
  '/ui/views/settingsDesktop.js',
  '/ui/views/trends.js',
  '/ui/views/usage.js',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache authenticated API payloads in the service worker.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const fresh = await fetch(req);
        cache.put('/index.html', fresh.clone());
        return fresh;
      } catch {
        return (await cache.match('/index.html')) || Response.error();
      }
    }

    const cached = await cache.match(req);
    if (cached) {
      event.waitUntil(fetch(req).then((fresh) => cache.put(req, fresh)).catch(() => {}));
      return cached;
    }

    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch {
      if (req.mode === 'navigate') {
        return (await cache.match('/index.html')) || Response.error();
      }
      throw new Error('offline');
    }
  })());
});
