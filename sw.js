// bump CACHE to force re-fetch after fix. Sync with query version on assets if needed.
const CACHE = 'hedge-music-v11';
const TRACK_CACHE = 'tracks-v1';
const TRACK_CACHE_MAX = 30; // LRU bound — phone storage protection
const APP_SHELL = [
  './',
  './music.html',
  './admin.html',
  './music.css',
  './music.js',
  './manifest.webmanifest',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE && k!==TRACK_CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

// LRU trim helper for MP3 cache — evicts oldest entries
async function trimTrackCache(){
  try{
    const c = await caches.open(TRACK_CACHE);
    const keys = await c.keys();
    if(keys.length > TRACK_CACHE_MAX){
      const drop = keys.slice(0, keys.length - TRACK_CACHE_MAX);
      await Promise.all(drop.map(k=>c.delete(k)));
    }
  }catch{}
}

// Normalized cache key: strip token query (signed URLs expire but path is stable)
function trackKey(req){
  try{
    const u = new URL(req.url);
    return u.origin + u.pathname;
  }catch{ return req.url; }
}

self.addEventListener('fetch', e=>{
  const {request} = e;
  if(request.method!=='GET') return;
  const url = new URL(request.url);
  // Supabase API/storage should be network-first (fresh tracks/queue)
  if(url.hostname.includes('supabase.co')){
    // Cache MP3s for offline — strip token from cache key so signed URL rotation doesn't invalidate
    if(url.pathname.includes('/storage/v1/object/') && url.pathname.includes('/tracks/')){
      if(request.headers.has('range')) return; // never cache partial/range — let network handle
      const key = trackKey(request);
      e.respondWith((async()=>{
        const c = await caches.open(TRACK_CACHE);
        const hit = await c.match(key);
        if(hit) return hit;
        try{
          const r = await fetch(request);
          if(r.ok && r.status===200){
            await c.put(key, r.clone());
            trimTrackCache();
          }
          return r;
        }catch(err){
          // no cached fallback and network failed → propagate
          throw err;
        }
      })());
      return;
    }
    return; // other supabase -> network only
  }
  if(url.origin!==self.location.origin) return;
  if(request.mode==='navigate'){
    e.respondWith(fetch(request).then(r=>{ const c=r.clone(); caches.open(CACHE).then(cache=>cache.put(request,c)); return r; }).catch(()=>caches.match(request).then(cached=>cached||caches.match('./music.html'))));
    return;
  }
  if(request.url.endsWith('.js')||request.url.endsWith('.css')){
    // stale-while-revalidate with 3s network timeout: race net vs timer, fallback to cache
    e.respondWith((async()=>{
      const cached = await caches.match(request);
      const netP = fetch(request).then(r=>{ if(r.ok){ const cp=r.clone(); caches.open(CACHE).then(c=>c.put(request,cp)); } return r; }).catch(()=>null);
      const timeoutP = new Promise(r=>setTimeout(()=>r(null), 3000));
      const winner = await Promise.race([netP, timeoutP]);
      if(winner && winner.ok) return winner;
      if(cached) return cached;
      const net = await netP; // still waiting? wait for it
      if(net && net.ok) return net;
      return cached || new Response('offline', {status:503});
    })());
    return;
  }
  e.respondWith(caches.match(request).then(cached=>{
    if(cached) return cached;
    return fetch(request).then(r=>{ if(r.ok) caches.open(CACHE).then(c=>c.put(request,r.clone())); return r; });
  }));
});
