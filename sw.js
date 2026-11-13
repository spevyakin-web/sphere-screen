const CACHE = 'kupol-v3';
const CORE = ['./', './index.html', './htm-preact.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url), same = url.origin === location.origin;
  const put = res => { if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return res; };
  if (same) { e.respondWith(fetch(req).then(put).catch(() => caches.match(req).then(h => h || caches.match('./index.html')))); return; }
  if (url.host.endsWith('fonts.googleapis.com') || url.host.endsWith('fonts.gstatic.com')) e.respondWith(caches.match(req).then(h => h || fetch(req).then(put)));
});
