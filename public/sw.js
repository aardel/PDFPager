/* PDFPager service worker — offline app shell + asset caching.
 *
 * Strategy:
 *  - /api/ and /s/ are NEVER touched (live scan-session traffic).
 *  - /assets/ (Vite content-hashed) and /vendor/ (OpenCV, 9MB, effectively
 *    immutable) are cache-first: a hash change is a new URL, and vendor
 *    changes must bump CACHE below to invalidate.
 *  - Everything else (index.html, scan.html, scan-worker.js, manifest,
 *    icons) is network-first with cache fallback, so deploys are picked up
 *    on the next load but the app still opens offline.
 */
const CACHE = 'pdfpager-v6'; // bump when /vendor/, scan-worker.js, or scan.html change materially

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return;

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Bypass the HTTP cache for the shell. Otherwise a heuristically-cached
      // index.html (no Cache-Control on older responses) gets served here and
      // keeps pointing at a content-hashed asset the latest deploy deleted →
      // 404 / blank page. 'no-store' guarantees we always revalidate the shell.
      const res = await fetch(e.request, { cache: 'no-store' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        const shell = await cache.match('/index.html') || await cache.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
