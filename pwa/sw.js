/* Nova AI service worker — cache-first shell, network-first data */
const VERSION = 'nova-pwa-v8';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).catch(()=>{}))); self.skipWaiting(); });
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
  if (SHELL.some(p => url.pathname.endsWith(p.replace('./', '/')))) {
    e.respondWith(caches.match(req).then(c => c || fetch(req).then(r => { caches.open(VERSION).then(cc => cc.put(req, r.clone())); return r; })));
    return;
  }
  e.respondWith(fetch(req).then(r => { caches.open(VERSION).then(cc => cc.put(req, r.clone())); return r; }).catch(() => caches.match(req).then(c => c || caches.match('./index.html'))));
});
self.addEventListener('push', (e) => {
  let data = {}; try { data = e.data ? e.data.json() : {}; } catch (_e) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Nova AI', {
    body: data.body || 'You have a new update.',
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: { url: data.url || './' }, tag: data.tag || 'nova',
    requireInteraction: !!data.urgent, vibrate: data.urgent ? [200,100,200] : [120],
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification?.data?.url || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  }));
});
