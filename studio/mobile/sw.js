const VERSION='fujiframe-studio-mobile-v1';
const ASSETS=['./','./index.html','./style.css','./app.js','./engine.js','./worker.js','./storage.js','./icon.svg','./manifest.webmanifest','./apple-touch-icon.png','./app-icon-192.png','./app-icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('fujiframe-studio-mobile-')&&k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin!==self.location.origin||event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match(new URL('./index.html',self.registration.scope).href)));return;}
  if(ASSETS.some(path=>new URL(path,self.registration.scope).href===url.href))event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(VERSION).then(cache=>cache.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request)));
});
