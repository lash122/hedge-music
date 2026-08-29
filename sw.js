const CACHE = 'hedge-music-v8';
const APP_SHELL = [
  './',
  './index.html',
  './music.html',
  './admin.html',
  './music.css',
  './music.js',
  './manifest.webmanifest',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE && k!=='tracks-v1').map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  const {request} = e;
  if(request.method!=='GET') return;
  const url = new URL(request.url);
  // Supabase API/storage should be network-first (fresh tracks/queue)
  if(url.hostname.includes('supabase.co')){
    // Cache MP3s for offline after first play if user clicks cache — handles public and private (signed) URLs, skip Range requests
    if(url.pathname.includes('/storage/v1/object/') && url.pathname.includes('/tracks/')){
      if(request.headers.has('range')) return;
      e.respondWith(caches.match(request).then(cached=> cached || fetch(request).then(r=>{
        const copy=r.clone();
        caches.open('tracks-v1').then(c=>c.put(request, copy));
        return r;
      })));
      return;
    }
    return; // other supabase -> network only
  }
  if(url.origin!==self.location.origin) return;
  if(request.mode==='navigate'){
    e.respondWith(fetch(request).then(r=>{ const c=r.clone(); caches.open(CACHE).then(cache=>cache.put(request,c)); return r; }).catch(()=>caches.match(request).then(c=>c||caches.match('./music.html'))));
    return;
  }
  if(request.url.endsWith('.js')||request.url.endsWith('.css')){
    e.respondWith(fetch(request).then(r=>{ if(r.ok) caches.open(CACHE).then(c=>c.put(request,r.clone())); return r; }).catch(()=>caches.match(request)));
    return;
  }
  e.respondWith(caches.match(request).then(cached=>{
    if(cached) return cached;
    return fetch(request).then(r=>{ if(r.ok) caches.open(CACHE).then(c=>c.put(request,r.clone())); return r; });
  }));
});
