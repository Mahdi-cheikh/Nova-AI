/* Nova AI service worker — network-first for HTML, cache-first for static assets.
   v16+: index.html is fetched from the network on every load so deploys take
   effect immediately. Old caches are wiped on activate, the new SW takes over
   without waiting (skipWaiting + clients.claim). */
const VERSION = 'nova-pwa-v16';
const ASSETS  = ['./manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.io')) return;
  if (url.origin !== location.origin) return;
  const isAsset = ASSETS.some(p => url.pathname.endsWith(p.replace('./', '/')));
  if (isAsset) {
    // Cache-first for icons / manifest — these change rarely.
    e.respondWith(caches.match(req).then(c => c || fetch(req).then(r => { caches.open(VERSION).then(cc => cc.put(req, r.clone())); return r; })));
    return;
  }
  // Network-first for everything else (index.html, queue.html, check.html, JS).
  // Falls back to a cached copy only if the network call fails.
  e.respondWith(
    fetch(req)
      .then(r => { caches.open(VERSION).then(cc => cc.put(req, r.clone())); return r; })
      .catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
  );
});
self.addEventListener('push', (e) => {
  let data = {}; try { data = e.data ? e.data.json() : {}; } catch (_e) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Nova AI', {
    body: data.body || 'You have a new update.',
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: { url: data.url || './' }, tag: data.tag || 'nova',
    requireInteraction: !!da