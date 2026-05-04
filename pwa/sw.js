/* Nova AI — service worker
   Cache-first for the app shell so the PWA opens instantly even on slow 3G,
   network-first for API calls so data is always fresh.
*/

const VERSION = 'nova-pwa-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache Supabase API calls — always go to the network so data is fresh.
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.io')) return;

  // Same-origin: cache-first for shell assets, network-first for everything else.
  if (url.origin === location.origin) {
    if (SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')))) {
      event.respondWith(
        caches.match(req).then((cached) => cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        }))
      );
      return;
    }
    // Network-first with cache fallback
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }
});

/* Web push: when a pushed notification arrives (e.g. a new lab result is ready),
   show it natively. Click navigates the user to the relevant in-app route. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) {}
  const title = data.title || 'Nova AI';
  const opts = {
    body: data.body || 'You have a new update.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: data.url || './' },
    tag: data.tag || 'nova',
    renotify: true,
    requireInteraction: !!data.urgent,
    vibrate: data.urgent ? [200, 100, 200] : [120],
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) { client.navigate(target); return client.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
