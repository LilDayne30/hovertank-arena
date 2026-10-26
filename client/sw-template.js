// Service worker (generated into dist/sw.js by vite.config.js; __VERSION__ / __PRECACHE__ are filled in).
// - every file of the build is precached; the cache name carries a hash of the whole build, so a new
//   deploy installs a new cache and the old one is deleted
// - the page itself (navigations) is network-first, so a deploy shows up on the next launch;
//   offline it falls back to the cached copy
// - built files, models and icons are cache-first (served instantly, no network on a warm start)
// - /api/* (matchmaking, rooms, WebSockets) is never touched: the game always talks to the server live
const VERSION = '__VERSION__';
const CACHE = `ht-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ht-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && url.pathname === '/') (await caches.open(CACHE)).put('/', res.clone());
        return res;
      } catch {
        const c = await caches.open(CACHE);
        return (await c.match(url.pathname === '/' ? '/' : url.pathname, { ignoreSearch: true })) || (await c.match('/')) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && /^\/(build|assets|icons)\//.test(url.pathname)) c.put(req, res.clone());
    return res;
  })());
});
