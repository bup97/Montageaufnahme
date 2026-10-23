/* Offline-Betrieb: App-Dateien vorab cachen; Netzwerk zuerst, sonst Cache. */
const CACHE = 'fw-recorder-v5.0.0';
const FILES = ['./', 'index.html', 'manifest.webmanifest',
  'js/layout.js', 'js/db.js', 'js/annotate.js', 'js/media.js', 'js/export.js', 'js/app.js',
  'lib/pptxgen.bundle.js',
  'img/logo.png', 'img/scan.png', 'img/label-eol.jpg', 'img/label-vp.jpg', 'img/label-fa.jpg',
  'img/icon-180.png', 'img/icon-192.png', 'img/icon-512.png'];
const ZXING = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(FILES);
    try { await c.add(new Request(ZXING, { mode: 'no-cors' })); } catch (err) { /* Scanner wird beim ersten Online-Start nachgeladen */ }
  })());
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith('fw-recorder-') && x !== CACHE).map(x => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const ours = url.origin === location.origin && url.pathname.startsWith(new URL('./', location).pathname);
  if (!ours && req.url !== ZXING) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(req);
      if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
      return r;
    } catch (err) {
      return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
    }
  })());
});
