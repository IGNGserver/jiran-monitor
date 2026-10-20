/* Jiran hub web shell — cache app shell for offline reopen on mobile. */
// Replaced from the esbuild output graph by build-web.js. Unbuilt development
// serves modules directly and deliberately does not install an offline shell.
const CACHE = 'jiran-web-development';
const PRECACHE = /* generated-precache */ [];

self.addEventListener('install', (event) => {
  event.waitUntil(
    PRECACHE.length ? caches.open(CACHE).then(async (cache) => {
      // A complete version is atomic. Bypass a previous worker and HTTP caches.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    }) : Promise.resolve()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('jiran-web-') && key !== CACHE).map((key) => caches.delete(key))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache authenticated API payloads in the service worker.
  if (url.pathname.startsWith('/api/')) return;
  if (!PRECACHE.length) return;
  const navigation = req.mode === 'navigate';
  const asset = PRECACHE.includes(url.pathname);
  if (!navigation && !asset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Cache-first navigation is bounded even on a blackholed WAN. This worker
    // never mixes new HTML with its old graph; a new version waits until all old
    // tabs close (no skipWaiting/claim), then activates with its own complete cache.
    const key = navigation ? '/index.html' : url.pathname;
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      const fresh = await fetch(req, { signal: AbortSignal.timeout(3000) });
      if (fresh.ok && !navigation) await cache.put(key, fresh.clone());
      return fresh;
    } catch {
      return Response.error();
    }
  })());
});
