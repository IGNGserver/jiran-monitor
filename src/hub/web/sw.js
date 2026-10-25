/* Workbox owns the complete public shell graph; API data never enters it. */
import { PrecacheController } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
const CACHE = 'jiran-web-development';
const PRECACHE = self.__WB_MANIFEST;
const precache = new PrecacheController({ cacheName: CACHE });
precache.addToCacheList(PRECACHE);
const publicFiles = new Set(PRECACHE.map((entry) => new URL(typeof entry === 'string' ? entry : entry.url, self.location.origin).pathname));
const hashedAsset = (path) => /^\/assets\/[^/]+-[A-Z0-9]{8}\.(?:js|css)$/.test(path)
  || /^\/icons\/pwa-[a-f0-9]{16}-[^/]+\.png$/.test(path);

self.addEventListener('install', (event) => {
  if (PRECACHE.length) event.waitUntil(precache.install(event).catch(async (error) => {
    await caches.delete(CACHE); // A partial candidate must not displace the previous complete graph.
    throw error;
  }));
});
// A candidate never forces itself over an open editor. The page sends this
// message only after the user chooses Update and accepts any draft warning.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await precache.activate(event);
    // A window can span several updates. Its late resources may belong to any
    // earlier complete graph, not necessarily the most recently cached one.
    const windows = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    if (windows.length === 0) {
      const previous = (await caches.keys()).filter((key) => key.startsWith('jiran-web-') && key !== CACHE);
      await Promise.all(previous.map((key) => caches.delete(key)));
    }
    await self.clients.claim();
  })());
});

registerRoute(({ request, url, sameOrigin }) => {
  if (!sameOrigin || request.method !== 'GET' || request.headers.has('Authorization')) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  return PRECACHE.length > 0 && (request.mode === 'navigate' || publicFiles.has(url.pathname) || hashedAsset(url.pathname));
}, async ({ request, url }) => {
  const key = request.mode === 'navigate' ? '/index.html' : url.pathname;
  const cached = await precache.matchPrecache(key);
  if (cached) return cached;
  // A tab left open across an update may still request its previous graph.
  if (hashedAsset(key)) {
    for (const name of (await caches.keys()).filter((name) => name.startsWith('jiran-web-')).reverse()) {
      const old = await (await caches.open(name)).match(request);
      if (old) return old;
    }
  }
  return fetch(request);
});
