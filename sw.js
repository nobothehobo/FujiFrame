const CACHE = 'fujiframe-v1';
const FILES = ['./','./index.html','./style.css','./app.js','./framing.js','./metadata.js','./archive.js','./png-export.js','./logo.svg','./manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fujiframe-') && key !== CACHE).map(key => caches.delete(key))))); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  // Network-first so new deployments appear on reload; offline is a fallback.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || new Response('Offline: open FujiFrame online once first.', { status: 503 })));
});
