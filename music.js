'use strict';
// Hedge Music - PWA frontend: queue yt-dlp URLs -> Supabase, play tracks, playlists
const SUPABASE_URL = 'https://mgwaehtmdecvptzzigwv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nd2FlaHRtZGVjdnB0enppZ3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3Nzk4NjEsImV4cCI6MjEwMzM1NTg2MX0.iXHwe9wQgC_fHvOqh9TFRcJu9ypJpRdXVvOaKweGreQ';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;');
function isValidThumb(url){ try{ const u=new URL(url); return u.protocol==='https:'; }catch{ return false; } }
function toast(m){ const t=$('toast'); if(!t) return; t.textContent=m; t.classList.add('show'); t.style.display='block'; clearTimeout(toast._t); toast._t=setTimeout(()=>{t.classList.remove('show'); t.style.display='none';},2500); }
function vibrate(p=10){ try{ navigator.vibrate&&navigator.vibrate(p);}catch{} }

// --- State ---
let tracks = [];
let queue = [];
let playlists = [];
let playlistTracks = [];
let activePlaylistId = null;
let filter = 'all';
let searchQ = '';
let queuePos = 0;
let curTrackId = null;
let isPlaying = false;
let repeat = false;
let pendingSheetTrackId = null;
const LIKES_KEY='hedge-likes';
function getLikes(){ try{ return new Set(JSON.parse(localStorage.getItem(LIKES_KEY)||'[]')); }catch{ return new Set(); } }
let likes=getLikes();
function isLiked(id){ return likes.has(id); }
function toggleLike(id){
  if(likes.has(id)) likes.delete(id); else likes.add(id);
  try{ localStorage.setItem(LIKES_KEY, JSON.stringify([...likes])); }catch{}
  vibrate(8);
  renderTracks();
  toast(likes.has(id) ? '♥ Liked' : '♡ Unliked');
}

// --- Auth ---
let currentUser=null;
function getInitial(email){ return (email||'?').trim().charAt(0).toUpperCase(); }
function toggleProfileMenu(show){
  const m=$('profile-menu'), b=$('avatar-btn');
  if(!m||!b) return;
  const willShow = show ?? m.style.display==='none';
  m.style.display = willShow ? 'flex' : 'none';
  b.setAttribute('aria-expanded', willShow ? 'true' : 'false');
}
function renderAuth(){
  const area=$('auth-area');
  if(!area) return;
  if(currentUser){
    const initial=getInitial(currentUser.email);
    area.innerHTML=`<button id="avatar-btn" class="avatar-btn" aria-label="Profile menu" aria-expanded="false">${esc(initial)}</button><div id="profile-menu" class="profile-menu" style="display:none"><div class="profile-email" title="${esc(currentUser.email)}">${esc(currentUser.email)}</div><button id="open-settings" class="btn btn-ghost" style="width:100%">⚙ Settings</button><button id="auth-logout" class="btn btn-ghost" style="width:100%">Log out</button></div>`;
    $('avatar-btn')?.addEventListener('click', (e)=>{ e.stopPropagation(); toggleProfileMenu(); });
    $('open-settings')?.addEventListener('click', ()=>{ toggleProfileMenu(false); openSettings(); });
    $('auth-logout')?.addEventListener('click', async()=>{ toggleProfileMenu(false); await sb.auth.signOut(); });
  } else {
    area.innerHTML=`<button id="auth-open" class="btn btn-ghost" style="padding:5px 10px">Log in</button><button id="open-settings-guest" class="btn btn-ghost" style="padding:5px 8px" title="Settings">⚙</button>`;
    $('auth-open')?.addEventListener('click', ()=> showAuth('login'));
    $('open-settings-guest')?.addEventListener('click', ()=> openSettings());
  }
}
function openSettings(){ const s=$('settings-sheet'), o=$('settings-overlay'); if(!s||!o) return; s.classList.add('open'); s.setAttribute('aria-hidden','false'); o.style.display='block'; document.body.style.overflow='hidden'; }
function closeSettings(){ const s=$('settings-sheet'), o=$('settings-overlay'); if(!s||!o) return; s.classList.remove('open'); s.setAttribute('aria-hidden','true'); o.style.display='none'; document.body.style.overflow=''; }
$('settings-close')?.addEventListener('click', closeSettings);
$('settings-overlay')?.addEventListener('click', closeSettings);
document.addEventListener('click', (e)=>{
  const area=$('auth-area'); const menu=$('profile-menu');
  if(!menu||menu.style.display==='none') return;
  if(area && !area.contains(e.target)) toggleProfileMenu(false);
});
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') toggleProfileMenu(false); });
function showAuth(mode){
  $('auth-title').textContent = mode==='signup' ? 'Sign up' : 'Log in';
  $('auth-error').textContent='';
  $('auth-dialog').style.display='grid';
  setTimeout(()=>$('auth-email').focus(), 80);
}
function hideAuth(){ $('auth-dialog').style.display='none'; $('auth-error').textContent=''; }
$('auth-close')?.addEventListener('click', hideAuth);
$('auth-dialog')?.addEventListener('click', e=>{ if(e.target.id==='auth-dialog') hideAuth(); });
$('auth-login')?.addEventListener('click', async()=>{
  const email=$('auth-email').value.trim(), pass=$('auth-pass').value;
  if(!email||!pass) return $('auth-error').textContent='Enter email & password';
  $('auth-error').textContent='…';
  const {error}=await sb.auth.signInWithPassword({email,password:pass});
  if(error) $('auth-error').textContent=error.message; else { hideAuth(); toast('Logged in'); }
});
$('auth-signup')?.addEventListener('click', async()=>{
  const email=$('auth-email').value.trim(), pass=$('auth-pass').value;
  if(!email||!pass) return $('auth-error').textContent='Enter email & password';
  if(pass.length<6) return $('auth-error').textContent='Password min 6 chars';
  $('auth-error').textContent='…';
  const {error}=await sb.auth.signUp({email,password:pass});
  if(error) $('auth-error').textContent=error.message; else { hideAuth(); toast('Account created — check email if confirmation required'); }
});
let authRedirectDone=false;
function redirectToLogin(){
  if(authRedirectDone) return;
  authRedirectDone=true;
  showAuth('login');
  toast('Private library — log in to continue');
}
async function isApproved(){
  try{ const { data, error } = await sb.rpc('is_approved'); if(!error) return !!data; }catch{}
  return true;
}
async function initAuth(){
  const {data:{session}}=await sb.auth.getSession();
  currentUser=session?.user||null;
  renderAuth();
  if(currentUser){
    const approved = await isApproved();
    if(!approved){
      queue=[]; playlists=[]; playlistTracks=[]; tracks=[];
      $('tracks-list').innerHTML=`<div class="empty"><div class="empty-icon">⏳</div><div>Awaiting approval</div><small style="color:var(--text-tertiary)">Admin will approve your account soon — you can browse after approval</small></div>`;
      const qc=$('queue-count'); if(qc) qc.textContent='awaiting approval';
      const pl=$('playlists-list'); if(pl) pl.innerHTML='<small style="color:var(--text-tertiary)">Awaiting approval</small>';
      toast('Awaiting admin approval');
      return;
    }
    await Promise.all([loadQueue(), loadPlaylists(), loadTracks()]);
  }
  else { queue=[]; playlists=[]; playlistTracks=[]; tracks=[]; const qc=$('queue-count'); if(qc) qc.textContent='— log in to queue'; const pl=$('playlists-list'); if(pl) pl.innerHTML='<small style="color:var(--text-tertiary)">Log in to see your private library</small>'; $('tracks-list').innerHTML=`<div class="empty"><div class="empty-icon">🔒</div><div>Private library — log in required</div><button id="gate-login-btn" class="btn btn-main" style="margin-top:8px">Log in</button></div>`; setTimeout(()=>{ const b=$('gate-login-btn'); if(b) b.addEventListener('click', ()=> showAuth('login')); if(!sessionStorage.getItem('login-redirect')){ sessionStorage.setItem('login-redirect','1'); setTimeout(()=> redirectToLogin(), 400); } },0); }
}
sb.auth.onAuthStateChange(async (_event, session)=>{
  currentUser=session?.user||null;
  renderAuth();
  if(currentUser){
    const approved = await isApproved();
    if(!approved){
      queue=[]; playlists=[]; playlistTracks=[]; tracks=[];
      $('tracks-list').innerHTML=`<div class="empty"><div class="empty-icon">⏳</div><div>Awaiting approval</div><small style="color:var(--text-tertiary)">Admin will approve your account soon</small></div>`;
      toast('Awaiting admin approval');
      return;
    }
    authRedirectDone=false; sessionStorage.removeItem('login-redirect'); await Promise.all([loadQueue(), loadPlaylists(), loadTracks()]);
  } else { queue=[]; playlists=[]; playlistTracks=[]; tracks=[]; renderPlaylists(); renderTracks(); if(!authRedirectDone) setTimeout(()=> redirectToLogin(), 200); }
});
initAuth();

// --- Helpers ---
function publicUrl(storagePath){
  if(!storagePath) return '';
  // fallback for legacy public bucket; private bucket uses signed URL via getSignedUrl
  return `${SUPABASE_URL}/storage/v1/object/public/tracks/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
}
const urlCache = new Map();
async function getSignedUrl(storagePath, force=false){
  if(!storagePath) return '';
  if(!force){
    const hit = urlCache.get(storagePath);
    if(hit && Date.now()-hit.ts < 55*60*1000) return hit.url;
  }
  try{
    const { data, error } = await sb.storage.from('tracks').createSignedUrl(storagePath, 3600);
    if(!error && data?.signedUrl){ urlCache.set(storagePath,{url:data.signedUrl, ts:Date.now()}); return data.signedUrl; }
  }catch{}
  // fallback to publicUrl for legacy public bucket during migration
  return publicUrl(storagePath);
}
function fmtTime(s){ if(!isFinite(s) || s==null) return '--:--'; const m=Math.floor(s/60), sec=Math.floor(s%60); return m+':'+String(sec).padStart(2,'0'); }
function requireAuth(){
  if(currentUser) return true;
  showAuth('login');
  toast('Log in to see your private library — tracks are owner-only');
  return false;
}
function isMobile(){ return window.innerWidth<=860; }
function canonicalUrl(u){
  try{
    const url=new URL(u);
    url.hash='';
    if(url.hostname==='youtu.be'){ url.hostname='www.youtube.com'; const id=url.pathname.replace('/',''); url.pathname='/watch'; url.searchParams.set('v', id); }
    ['t','si','st','utm_source','utm_medium','utm_campaign'].forEach(p=>url.searchParams.delete(p));
    url.searchParams.sort();
    return url.toString();
  }catch{ return u; }
}
// --- Analytics (buffered, batched, fire-and-forget) ---
const eventQueue=[];
function logEvent(event, trackId, meta){
  try{
    const payload={ event, meta: meta||null };
    if(trackId) payload.track_id=trackId;
    if(currentUser?.id) payload.user_id=currentUser.id;
    if(currentUser?.email) { payload.meta = {...(payload.meta||{}), email: currentUser.email }; }
    eventQueue.push(payload);
    if(eventQueue.length>=20) flushEvents();
  }catch{}
}
function flushEvents(){
  if(!eventQueue.length) return;
  const batch=eventQueue.splice(0, eventQueue.length);
  try{ sb.from('track_events').insert(batch).then(()=>{},()=>{}); }catch{}
}
setInterval(flushEvents, 5000);
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') flushEvents(); });

// --- Mobile Tabs ---
const MOBILE_TABS=['library','playlists','likes'];
function setMobileTab(tab){
  document.body.setAttribute('data-mobile-tab', tab);
  document.querySelectorAll('.bottom-tabs .tab').forEach(b=>{
    const active=b.dataset.tab===tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active?'true':'false');
  });
  try{ localStorage.setItem('hedge-tab', tab); }catch{}
  if(location.hash!=='#'+tab) history.replaceState(null,'','#'+tab);
  updateListHead();
  renderTracks();
}
function initTabs(){
  const tabs=document.querySelectorAll('.bottom-tabs .tab');
  tabs.forEach(b=> b.addEventListener('click', ()=>{
    vibrate(8);
    setMobileTab(b.dataset.tab);
  }));
  // default from hash / localStorage ('queue' legacy -> library)
  let initial = location.hash.replace('#','') || (localStorage.getItem('hedge-tab')||'library');
  if(!MOBILE_TABS.includes(initial)) initial='library';
  setMobileTab(initial);
  window.addEventListener('hashchange', ()=>{
    const h=location.hash.replace('#','');
    if(MOBILE_TABS.includes(h)) setMobileTab(h);
  });
}
initTabs();

// --- Collapsible ingest / Bottom Sheet (queue is always a sheet now, FAB opens it) ---
function setIngest(open){
  const panel=$('ingest-panel');
  const overlay=$('sheet-overlay');
  const willOpen = open ?? panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', !willOpen);
  panel.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
  const btn=$('toggle-ingest');
  if(btn) { btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false'); btn.textContent = willOpen ? '✕ Close' : '＋ Queue'; }
  if(overlay){
    overlay.style.display = willOpen && isMobile() ? 'block' : 'none';
  }
  if(willOpen) setTimeout(()=>$('yt-url')?.focus(), 180);
}
$('toggle-ingest')?.addEventListener('click', ()=> setIngest());
$('close-ingest')?.addEventListener('click', ()=> setIngest(false));
$('sheet-overlay')?.addEventListener('click', ()=> setIngest(false));
$('fab-queue')?.addEventListener('click', ()=>{ vibrate(10); setIngest(true); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ setIngest(false); closePlayerSheet(); closeTrackSheet(); closeSettings(); toggleProfileMenu(false); }});

// Paste helper
$('paste-btn')?.addEventListener('click', async()=>{
  try{
    const txt = await navigator.clipboard.readText();
    if(txt){ $('yt-url').value=txt.trim(); $('yt-url').focus(); toast('Pasted'); }
  }catch{ toast('Paste failed — long-press input'); $('yt-url').focus(); }
});

// Search clear
const searchInput=$('search');
const searchClear=$('search-clear');
function updateSearchClear(){ if(!searchClear||!searchInput) return; searchClear.style.display = searchInput.value ? 'block' : 'none'; }
searchClear?.addEventListener('click', ()=>{ searchInput.value=''; searchQ=''; renderTracks(); updateSearchClear(); searchInput.focus(); });

// Share target: ?url= or ?text=
(function handleShareTarget(){
  const p=new URLSearchParams(location.search);
  const shared = p.get('url') || p.get('text') || p.get('title');
  if(shared){
    const urlMatch = shared.match(/https?:\/\/\S+/);
    const url = urlMatch ? urlMatch[0] : shared;
    setTimeout(()=>{
      if($('yt-url')) $('yt-url').value=url;
      setIngest(true);
      // clean url without reload loop
      history.replaceState(null,'', location.pathname + location.hash);
    }, 300);
  }
  const action=p.get('action');
  if(action==='queue') setTimeout(()=> setIngest(true), 300);
})();

// --- PWA Install ---
let deferredPrompt=null;
const PWA_DISMISS_KEY='pwa-dismissed';
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
function showPwaBanner(){
  if(isStandalone) return;
  if(localStorage.getItem(PWA_DISMISS_KEY)) return;
  const b=$('pwa-banner');
  if(b) b.style.display='flex';
}
function hidePwaBanner(persist=false){
  const b=$('pwa-banner'), ios=$('pwa-ios');
  if(b) b.style.display='none';
  if(ios) ios.style.display='none';
  const ib=$('install-btn'); if(ib) ib.style.display='none';
  if(persist) try{localStorage.setItem(PWA_DISMISS_KEY, Date.now());}catch{}
}
window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  deferredPrompt=e;
  const ib=$('install-btn'); if(ib) ib.style.display='';
  showPwaBanner();
});
$('install-btn')?.addEventListener('click', async()=>{
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  const choice=await deferredPrompt.userChoice;
  if(choice.outcome==='accepted') hidePwaBanner(true);
  deferredPrompt=null;
});
$('pwa-install')?.addEventListener('click', async()=>{
  if(!deferredPrompt) { hidePwaBanner(true); toast('Use browser menu → Install app'); return; }
  deferredPrompt.prompt();
  const c=await deferredPrompt.userChoice;
  if(c.outcome==='accepted') toast('Installing…');
  hidePwaBanner(true);
  deferredPrompt=null;
});
$('pwa-dismiss')?.addEventListener('click', ()=> hidePwaBanner(false));
$('pwa-ios-dismiss')?.addEventListener('click', ()=> hidePwaBanner(false));
window.addEventListener('appinstalled', ()=> hidePwaBanner(true));
if(isIOS && !isStandalone){
  setTimeout(()=>{
    if(!localStorage.getItem(PWA_DISMISS_KEY) && !deferredPrompt){
      const ios=$('pwa-ios');
      if(ios) ios.style.display='flex';
    }
  }, 1500);
}
setTimeout(()=>{
  const isDismissed = localStorage.getItem(PWA_DISMISS_KEY);
  const urlParams = new URLSearchParams(location.search);
  const force = urlParams.has('install') || urlParams.has('pwa');
  if(force) { try{localStorage.removeItem(PWA_DISMISS_KEY);}catch{} const b=$('pwa-banner'); if(b) b.style.display='flex'; return; }
  if(isStandalone || isDismissed) return;
  if(deferredPrompt) { showPwaBanner(); return; }
  if(!sessionStorage.getItem('pwa-fallback-shown')){
    sessionStorage.setItem('pwa-fallback-shown','1');
    const b=$('pwa-banner');
    if(b){
      b.style.display='flex';
      const btn=$('pwa-install');
      if(btn && !deferredPrompt) { btn.textContent='How to install'; btn.onclick = () => { toast('On phone: browser menu → Add to Home Screen / Install app'); }; }
    }
  }
}, 1500);

// --- Queue ingest ---
$('queue-btn')?.addEventListener('click', queueNow);
$('yt-url')?.addEventListener('keydown', e=>{ if(e.key==='Enter') queueNow(); });
async function queueNow(){
  const url = $('yt-url').value.trim();
  if(!url){ toast('Paste a URL'); return; }
  try { new URL(url); } catch{ toast('Invalid URL'); return; }
  if(!/^https?:\/\//i.test(url)){ toast('URL must start https://'); return; }
  if(!requireAuth()) return;
  $('queue-btn').disabled=true;
  $('queue-status').textContent='Queuing...'; $('queue-status').className='status';
  try{
    const canon = canonicalUrl(url);
    const payload={ original_url: url, canonical_url: canon };
    if(currentUser) payload.owner_id=currentUser.id;
    const { error } = await sb.from('ingest_queue').insert(payload);
    if(error){
      if(error.code==='23505'){ $('queue-status').textContent='Already queued (pending)'; $('queue-status').className='status ok'; toast('Already in queue'); await loadQueue(); return; }
      throw error;
    }
    $('yt-url').value='';
    $('queue-status').textContent='✓ Queued as pending. Run laptop: node tools/ingest.js --watch';
    $('queue-status').className='status ok';
    toast('Queued! Run laptop ingest');
    await loadQueue();
    logEvent('queue', null, { url: url.slice(0,120) });
  }catch(e){
    $('queue-status').textContent='✗ '+e.message; $('queue-status').className='status err';
    if(e.message.includes('does not exist') || e.message.includes('relation')){
      $('queue-status').textContent += ' — Run supabase-music.sql first.';
    }
    if(e.message.includes('row-level security') || e.message.includes('policy')) $('queue-status').textContent += ' — Log in first';
  } finally { $('queue-btn').disabled=false; }
}

async function loadQueue(){
  if(!currentUser){ const qc=$('queue-count'); if(qc) qc.textContent='— log in to queue'; const badge=$('queue-badge'); if(badge) badge.style.display='none'; const dot=$('fab-queue-dot'); if(dot) dot.style.display='none'; const pl=$('pending-list'); if(pl) pl.innerHTML='<small style="color:var(--text-tertiary)">Log in to queue and see your pending uploads</small>'; return; }
  const { data, error } = await sb.from('ingest_queue').select('*').order('created_at', {ascending:false}).limit(50);
  if(error){ console.warn('queue load', error.message); return; }
  queue = data||[];
  const pending = queue.filter(q=>q.status==='pending');
  const qc=$('queue-count'); if(qc) qc.textContent = pending.length+' pending';
  const badge = $('queue-badge');
  if(badge){ if(pending.length){ badge.style.display=''; badge.textContent = pending.length+' queued'; } else badge.style.display='none'; }
  const dot=$('fab-queue-dot'); if(dot) dot.style.display = pending.length ? 'block' : 'none';
  const pl=$('pending-list');
  if(pl){
    pl.innerHTML = queue.slice(0,12).map(q=>{
      const s = q.status==='pending'?'⏳': q.status==='done'?'✓': q.status==='processing'?'⚙️':'✗';
      return `<div class="pending-item"><span>${s} ${esc(q.original_url.slice(0,54))}</span><small>${esc(q.status)} ${q.error? '· '+esc(q.error.slice(0,40)):''}</small></div>`;
    }).join('') || '<div class="empty" style="padding:12px">No queued URLs</div>';
    if(queue.length>12) pl.innerHTML += `<small style="color:var(--text-tertiary);padding:6px 10px;display:block">+ ${queue.length-12} more</small>`;
  }
}

// --- Tracks ---
const TRACK_PAGE = 50;
let tracksPage = 0;
let tracksAllLoaded = false;
let tracksLoading = false;
function showSkeleton(){
  const el=$('tracks-list'); if(!el) return;
  el.innerHTML = Array(3).fill(0).map(()=> `<div class="track skeleton" style="pointer-events:none"><div style="width:46px;height:46px;border-radius:6px;background:var(--surface-hover)"></div><div style="flex:1;display:flex;flex-direction:column;gap:8px"><div style="height:12px;width:60%;background:var(--surface-hover);border-radius:6px"></div><div style="height:10px;width:40%;background:var(--surface-hover);border-radius:6px"></div></div></div>`).join('');
}
function trackSentinel(){
  let el=$('track-sentinel');
  if(!el){
    el=document.createElement('div');
    el.id='track-sentinel';
    el.style.height='1px';
    const list=$('tracks-list'); if(list) list.appendChild(el);
    new IntersectionObserver((entries)=>{
      entries.forEach(en=>{ if(en.isIntersecting && !tracksAllLoaded && !tracksLoading && currentUser) loadTracks(false); });
    }).observe(el);
  }
}
async function loadTracks(reset=true){
  if(tracksLoading) return;
  if(!reset && tracksAllLoaded) return;
  tracksLoading=true;
  if(reset){ tracksPage=0; tracksAllLoaded=false; tracks=[]; showSkeleton(); }
  const start = tracksPage*TRACK_PAGE;
  const { data, error } = await sb.from('tracks')
    .select('id,original_url,extractor,extractor_id,title,artist,thumbnail_url,storage_path,duration_sec,file_size,created_at')
    .order('created_at', {ascending:false}).range(start, start+TRACK_PAGE-1);
  tracksLoading=false;
  if(error){
    console.warn('tracks load', error.message);
    if(error.message.includes('does not exist')) $('tracks-list').innerHTML = '<div class="empty"><div class="empty-icon">♪</div><div>Run <code>supabase-music.sql</code> in Supabase SQL Editor, then queue a URL.</div></div>';
    else $('tracks-list').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><div>Failed to load tracks</div></div>';
    return;
  }
  if(!data || !data.length) tracksAllLoaded=true;
  if(reset) tracks = data||[];
  else tracks = [...tracks, ...(data||[])];
  tracksPage++;
  const tc=$('tracks-count'); if(tc) tc.textContent = tracks.length+' tracks';
  // private library: enforce login + approval gate
  if(!currentUser){
    const el=$('tracks-list'); if(el) el.innerHTML=`<div class="empty"><div class="empty-icon">🔒</div><div>Private library — log in to see your tracks</div><button id="empty-login-btn" class="btn btn-main" style="margin-top:8px">Log in</button></div>`;
    setTimeout(()=>{ const b=$('empty-login-btn'); if(b) b.addEventListener('click', ()=> showAuth('login')); },0);
    return;
  }
  // check approval async — if not approved, loadTracks already gated in initAuth, but handle direct call
  sb.rpc('is_approved').then(({data})=>{ if(!data){ const el=$('tracks-list'); if(el) el.innerHTML=`<div class="empty"><div class="empty-icon">⏳</div><div>Awaiting approval</div><small style="color:var(--text-tertiary)">Admin will approve your account soon</small></div>`; } }).catch(()=>{});
  renderTracks();
  trackSentinel();
}

function filteredTracks(){
  let t = tracks;
  // mobile Likes tab: only liked songs
  if(isMobile() && document.body.getAttribute('data-mobile-tab')==='likes'){
    t = t.filter(x=>likes.has(x.id));
  }
  if(activePlaylistId){
    const ids = new Set(playlistTracks.filter(pt=>pt.playlist_id===activePlaylistId).map(pt=>pt.track_id));
    t = t.filter(x=>ids.has(x.id));
    const pos = Object.fromEntries(playlistTracks.filter(pt=>pt.playlist_id===activePlaylistId).map(pt=>[pt.track_id, pt.position]));
    t = [...t].sort((a,b)=>(pos[a.id]||0)-(pos[b.id]||0));
  }
  if(filter!=='all') t = t.filter(x=>(x.extractor||'').toLowerCase()===filter);
  if(searchQ) {
    const q=searchQ.toLowerCase();
    t = t.filter(x=> (x.title||'').toLowerCase().includes(q) || (x.artist||'').toLowerCase().includes(q) || (x.extractor||'').toLowerCase().includes(q));
  }
  return t;
}

async function removeFromPlaylist(pid, tid){
  if(!pid || !tid) return;
  if(!requireAuth()) return;
  const { error } = await sb.from('playlist_tracks').delete().eq('playlist_id', pid).eq('track_id', tid);
  if(error){
    if(error.message.includes('policy') || error.message.includes('permission')) toast('Not allowed — not owner');
    else toast('Remove failed: '+error.message);
    return;
  }
  toast('Removed from playlist');
  await loadPlaylists();
}
function renderTracks(){
  const list = filteredTracks();
  const el=$('tracks-list');
  if(!el) return;
  if(!list.length){
    const isLikesView = isMobile() && document.body.getAttribute('data-mobile-tab')==='likes';
    const isFiltered = isLikesView || activePlaylistId || filter!=='all' || searchQ;
    if(isLikesView){
      el.innerHTML=`<div class="empty"><div class="empty-icon">♥</div><div>No liked songs yet</div><small style="color:var(--text-tertiary)">Tap the ♥ on any track and it shows up here</small></div>`;
      return;
    }
    if(isFiltered){
      el.innerHTML=`<div class="empty"><div class="empty-icon">🔍</div><div>No tracks match</div><small style="color:var(--text-tertiary)">Try clearing search or filter</small><button id="clear-filters-btn" class="btn btn-ghost" style="margin-top:8px">Clear filters</button></div>`;
      setTimeout(()=>{ const b=$('clear-filters-btn'); if(b) b.addEventListener('click', ()=>{ const s=$('search'); if(s) s.value=''; searchQ=''; filter='all'; activePlaylistId=null; document.querySelectorAll('.chip').forEach(c=>{c.classList.remove('active'); c.setAttribute('aria-selected','false')}); const all=document.querySelector('[data-filter=all]'); if(all){all.classList.add('active'); all.setAttribute('aria-selected','true')} updateListHead(); renderPlaylists(); renderTracks(); updateSearchClear(); }); }, 0);
    } else {
      el.innerHTML=`<div class="empty"><div class="empty-icon">♪</div><div>No tracks yet</div><small style="color:var(--text-tertiary)">Queue a URL and run your laptop ingest</small><button id="empty-queue-btn" class="btn btn-main" style="margin-top:8px">＋ Queue first track</button></div>`;
      setTimeout(()=>{ const b=$('empty-queue-btn'); if(b) b.addEventListener('click', ()=> setIngest(true)); }, 0);
    }
    return;
  }
  el.innerHTML = list.map(tr=>{
    const isCur = tr.id===curTrackId;
    const playingClass = isCur ? 'playing' + (isPlaying ? ' is-playing' : '') : '';
    const art = (tr.thumbnail_url && isValidThumb(tr.thumbnail_url)) ? `<img src="${esc(tr.thumbnail_url)}" loading="lazy" alt="">` : `<div style="width:64px;height:64px;background:var(--bg);border:1px solid var(--border);border-radius:8px;display:grid;place-items:center;font-size:18px;flex-shrink:0">♪</div>`;
    const dur = tr.duration_sec ? fmtTime(tr.duration_sec) : '--:--';
    const size = tr.file_size ? (tr.file_size/1024/1024).toFixed(1)+'MB' : '';
    const meta = [esc(tr.artist||tr.extractor||''), esc(tr.extractor||''), dur, size].filter(Boolean).join(' · ');
    const progress = isCur && isFinite(audio.duration) && audio.duration ? Math.round(audio.currentTime/audio.duration*100) : 0;
    const liked=isLiked(tr.id);
    return `<div class="track ${playingClass}" data-id="${esc(tr.id)}">
      ${art}
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:6px;min-width:0"><div class="t-title" style="flex:1">${esc(tr.title)}</div><div class="t-eq" aria-hidden="true"><span></span><span></span><span></span></div></div>
        <div class="t-sub">${meta}</div>
      </div>
      <div class="t-actions">
        <button class="mini play-mini" data-play="${esc(tr.id)}" aria-label="Play">${isCur && isPlaying?'⏸':'▶'}</button>
        <button class="like-btn ${liked?'liked':''}" data-like="${esc(tr.id)}" aria-label="Like"><svg width="18" height="18"><use href="${liked ? '#i-heart-filled' : '#i-heart'}"/></svg></button>
        <button class="track-more" data-more="${esc(tr.id)}" aria-label="More">⋯</button>
      </div>
      <div class="t-progress" aria-hidden="true"><div class="t-progress-bar" data-bar="${esc(tr.id)}" style="width:${progress}%"></div></div>
    </div>`;
  }).join('');
  el.querySelectorAll('.track').forEach(node=>{
    node.addEventListener('click', e=>{
      if(e.target.closest('[data-more]') || e.target.closest('[data-play]')) return;
      vibrate(8);
      if(node.dataset.id === curTrackId){
        openPlayerSheet();
      } else {
        playTrack(node.dataset.id);
      }
    });
  });
  el.querySelectorAll('[data-play]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      vibrate(8);
      const id=btn.getAttribute('data-play');
      if(id===curTrackId && isPlaying){ audio.pause(); } else { playTrack(id); }
    });
  });
  el.querySelectorAll('[data-more]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      vibrate(8);
      openTrackSheet(btn.getAttribute('data-more'));
    });
  });
  el.querySelectorAll('[data-like]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      toggleLike(btn.getAttribute('data-like'));
    });
  });
}

// --- Track Sheet ---
function openTrackSheet(trackId){
  const tr=tracks.find(t=>t.id===trackId);
  if(!tr) return;
  pendingSheetTrackId=trackId;
  const sheet=$('track-sheet'), overlay=$('track-overlay');
  const head=$('track-sheet-head');
  const art = tr.thumbnail_url ? `<img src="${esc(tr.thumbnail_url)}" alt="">` : `<div style="width:48px;height:48px;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:grid;place-items:center">♪</div>`;
  head.innerHTML=`${art}<div class="as-head-text"><div class="as-head-title">${esc(tr.title)}</div><div class="as-head-sub">${esc(tr.artist||tr.extractor||'')}</div></div>`;
  // contextual remove — show only if currently viewing that playlist and track is in it
  let removeHtml = '';
  if(activePlaylistId && playlistTracks.some(pt=>pt.playlist_id===activePlaylistId && pt.track_id===trackId)){
    const plName = playlists.find(p=>p.id===activePlaylistId)?.name || 'this playlist';
    removeHtml = `<button id="as-remove" class="as-btn as-remove" style="border-color:#3a2a2a;color:#e8a0a0;background:#1f1414">✕ Remove from ${esc(plName)}</button><div class="as-divider"></div>`;
  }
  const plWrap=$('as-playlists');
  if(playlists.length){
    plWrap.innerHTML = removeHtml + playlists.map(p=> `<button class="as-pl-btn" data-pid="${esc(p.id)}">＋ ${esc(p.name)}</button>`).join('');
    const rmBtn = plWrap.querySelector('#as-remove');
    if(rmBtn) rmBtn.addEventListener('click', async()=>{
      await removeFromPlaylist(activePlaylistId, pendingSheetTrackId);
      closeTrackSheet();
    });
    plWrap.querySelectorAll('.as-pl-btn').forEach(b=>{
      b.addEventListener('click', async()=>{
        await addToPlaylist(b.dataset.pid, pendingSheetTrackId);
        closeTrackSheet();
      });
    });
  } else {
    plWrap.innerHTML= removeHtml + '<small style="color:var(--text-tertiary)">No playlists — create one first</small>';
    const rmBtn = plWrap.querySelector('#as-remove');
    if(rmBtn) rmBtn.addEventListener('click', async()=>{
      await removeFromPlaylist(activePlaylistId, pendingSheetTrackId);
      closeTrackSheet();
    });
  }
  sheet.classList.add('open'); sheet.setAttribute('aria-hidden','false');
  overlay.style.display='block';
}
function closeTrackSheet(){
  const sheet=$('track-sheet'), overlay=$('track-overlay');
  if(sheet) sheet.classList.remove('open');
  if(sheet) sheet.setAttribute('aria-hidden','true');
  if(overlay) overlay.style.display='none';
  pendingSheetTrackId=null;
}
$('track-overlay')?.addEventListener('click', closeTrackSheet);
$('as-close')?.addEventListener('click', closeTrackSheet);
$('as-play')?.addEventListener('click', ()=>{ if(pendingSheetTrackId) playTrack(pendingSheetTrackId); closeTrackSheet(); });
$('as-next')?.addEventListener('click', ()=>{
  if(!pendingSheetTrackId) return;
  const q=window._playQueue||filteredTracks();
  const idx=q.findIndex(t=>t.id===curTrackId);
  const tr=tracks.find(t=>t.id===pendingSheetTrackId);
  if(tr && idx>=0){ q.splice(idx+1,0,tr); window._playQueue=q; toast('Will play next'); }
  else if(tr) playTrack(tr.id);
  closeTrackSheet();
});
// swipe down to dismiss track sheet
(function attachSheetSwipe(){
  const sheet=$('track-sheet');
  if(!sheet) return;
  let startY=0, curY=0, dragging=false;
  sheet.addEventListener('touchstart', e=>{ startY=e.touches[0].clientY; dragging=true; sheet.style.transition='none'; }, {passive:true});
  sheet.addEventListener('touchmove', e=>{
    if(!dragging) return;
    curY=e.touches[0].clientY - startY;
    if(curY>0) sheet.style.transform=`translateY(${curY}px)`;
  }, {passive:true});
  sheet.addEventListener('touchend', ()=>{
    dragging=false; sheet.style.transition='';
    sheet.style.transform='';
    if(curY>90) closeTrackSheet();
    curY=0;
  });
})();

// --- Playlists ---
async function loadPlaylists(){
  if(!currentUser){ playlists=[]; playlistTracks=[]; renderPlaylists(); renderTracks(); return; }
  const { data, error } = await sb.from('playlists').select('*').order('created_at');
  if(error){ console.warn('playlists', error.message); return; }
  playlists=data||[];
  const { data: pts, error:e2 } = await sb.from('playlist_tracks').select('*').order('position');
  if(e2) console.warn(e2.message);
  playlistTracks = pts||[];
  renderPlaylists();
  renderTracks();
}
function renderPlaylists(){
  const el=$('playlists-list');
  if(!el) return;
  if(!currentUser){ el.innerHTML='<small style="color:var(--text-tertiary)">Log in to make your own playlists — library is public to browse</small>'; return; }
  // build list with All tracks on top
  const allCount = tracks.length;
  const allActive = !activePlaylistId ? 'active' : '';
  let html = `<div class="playlist-item ${allActive}" data-id="">
      <span>♫ All tracks <small>(${allCount})</small></span>
      <small style="color:var(--text-tertiary)">view all</small>
    </div>`;
  if(!playlists.length){
    html += '<small style="color:var(--text-tertiary);padding:8px 2px;display:block">No playlists yet — create one above</small>';
  } else {
    html += playlists.map(p=>{
      const count = playlistTracks.filter(pt=>pt.playlist_id===p.id).length;
      return `<div class="playlist-item ${activePlaylistId===p.id?'active':''}" data-id="${esc(p.id)}">
        <span>▶ ${esc(p.name)} <small>(${count})</small></span>
        <button class="mini del-pl" data-id="${esc(p.id)}" style="background:#1f1f2a;border:1px solid var(--border);padding:4px 8px;border-radius:6px;cursor:pointer">✕</button>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;
  el.querySelectorAll('.playlist-item').forEach(n=> n.addEventListener('click', e=>{
    if(e.target.closest('.del-pl')) return;
    const id = n.dataset.id;
    // toggle: clicking active All stays All, clicking active playlist again goes back to All
    if(id === activePlaylistId){ activePlaylistId = null; }
    else activePlaylistId = id || null;
    const titleEl=$('list-title'); if(titleEl) titleEl.textContent = activePlaylistId ? (playlists.find(p=>p.id===activePlaylistId)?.name || 'Playlist') : 'All tracks';
    // update header back affordance
    updateListHead();
    renderPlaylists(); renderTracks();
    if(isMobile()) setMobileTab('library');
    // scroll tracks into view
    if(activePlaylistId) setTimeout(()=> document.querySelector('.main')?.scrollIntoView({behavior:'smooth', block:'start'}), 100);
  }));
  el.querySelectorAll('.del-pl').forEach(b=> b.addEventListener('click', async e=>{
    e.stopPropagation();
    const id=b.dataset.id;
    if(!confirm('Delete playlist?')) return;
    await sb.from('playlists').delete().eq('id', id);
    if(activePlaylistId===id){ activePlaylistId=null; const t=$('list-title'); if(t) t.textContent='All tracks'; updateListHead(); }
    await loadPlaylists();
  }));
  updateListHead();
}
function updateListHead(){
  const titleEl=$('list-title');
  const head=document.querySelector('.list-head');
  if(!head||!titleEl) return;
  let back=head.querySelector('#back-to-all');
  if(activePlaylistId){
    const name = playlists.find(p=>p.id===activePlaylistId)?.name || 'Playlist';
    titleEl.textContent = name;
    if(!back){
      back=document.createElement('button');
      back.id='back-to-all';
      back.className='btn btn-ghost';
      back.style.padding='6px 10px';
      back.style.fontSize='12px';
      back.textContent='← All tracks';
      back.addEventListener('click', ()=>{ vibrate(8); activePlaylistId=null; updateListHead(); renderPlaylists(); renderTracks(); toast('Showing all tracks'); });
      head.insertBefore(back, titleEl);
    }
    back.style.display='';
    titleEl.style.display='none';
  } else {
    const isLikesView = isMobile() && document.body.getAttribute('data-mobile-tab')==='likes';
    titleEl.textContent = isLikesView ? '♥ Liked' : 'All tracks';
    titleEl.style.display='';
    if(back) back.style.display='none';
  }
}
$('create-playlist-btn')?.addEventListener('click', async()=>{
  if(!requireAuth()) return;
  const name=$('new-playlist-name').value.trim();
  if(!name) return toast('Enter name');
  const payload={name}; if(currentUser) payload.owner_id=currentUser.id;
  const { error } = await sb.from('playlists').insert(payload);
  if(error) toast(error.message); else { $('new-playlist-name').value=''; await loadPlaylists(); toast('Playlist created');}
});
$('new-playlist-name')?.addEventListener('keydown', e=>{ if(e.key==='Enter') $('create-playlist-btn').click(); });
async function addToPlaylist(pid, tid){
  const maxPos = Math.max(0, ...playlistTracks.filter(pt=>pt.playlist_id===pid).map(pt=>pt.position));
  const { error } = await sb.from('playlist_tracks').insert({playlist_id:pid, track_id:tid, position: maxPos+1});
  if(error) {
    if(error.message.includes('duplicate')) toast('Already in playlist');
    else toast(error.message);
  } else { toast('Added to playlist'); await loadPlaylists(); logEvent('playlist_add', tid, { playlist_id: pid }); }
}

// --- Player ---
const audio = $('player');
const psAudio = audio; // single element
function buildQueueFromCurrent(startId){
  const list = filteredTracks();
  const idx = list.findIndex(t=>t.id===startId);
  queuePos = idx>=0? idx:0;
  window._playQueue = list;
}
async function playTrack(id){
  const tr = tracks.find(t=>t.id===id);
  if(!tr) return;
  if(!tr.storage_path){ toast('File missing — re-ingest'); return; }
  if(!currentUser){ showAuth('login'); toast('Log in to play your private tracks'); return; }
  curTrackId=id;
  buildQueueFromCurrent(id);
  const url = await getSignedUrl(tr.storage_path);
  if(!url){ toast('File missing'); return; }
  audio.src = url;
  audio.play().catch(e=>{ toast('Playback failed'); console.warn(e); isPlaying=false; syncPlayButtons(); });
  isPlaying=true;
  updatePlayerUI(tr);
  renderTracks();
  logEvent('play', tr.id, { extractor: tr.extractor, title: tr.title?.slice(0,60) });
  if('mediaSession' in navigator){
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: tr.title, artist: tr.artist||tr.extractor||'', artwork: tr.thumbnail_url?[{src: tr.thumbnail_url, sizes:'512x512', type:'image/png'}]:[]
      });
      navigator.mediaSession.setActionHandler('play', ()=> audio.play().catch(()=>{}));
      navigator.mediaSession.setActionHandler('pause', ()=> audio.pause());
      navigator.mediaSession.setActionHandler('nexttrack', next);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('seekto', d=>{ if(d.seekTime!=null) audio.currentTime=d.seekTime; });
      navigator.mediaSession.setActionHandler('seekbackward', d=>{ audio.currentTime=Math.max(0,audio.currentTime-(d.seekOffset||10)); });
      navigator.mediaSession.setActionHandler('seekforward', d=>{ audio.currentTime=Math.min(audio.duration||Infinity, audio.currentTime+(d.seekOffset||10)); });
    } catch {}
  }
}
function syncPlayButtons(){
  const icon = isPlaying ? '⏸' : '▶';
  const b=$('play-btn'); if(b) b.textContent=icon;
  const pb=$('ps-play'); if(pb){
    const playIcon=pb.querySelector('.i-play-icon'), pauseIcon=pb.querySelector('.i-pause-icon');
    if(playIcon&&pauseIcon){ playIcon.style.display=isPlaying?'none':''; pauseIcon.style.display=isPlaying?'':'none'; }
    else pb.textContent=icon;
  }
}
function updatePlayerUI(tr){
  const title=$('player-title'), artist=$('player-artist'), psTitle=$('ps-title'), psArtist=$('ps-artist');
  if(title) title.textContent = tr.title;
  if(artist) artist.textContent = tr.artist||tr.extractor||'';
  if(psTitle) psTitle.textContent = tr.title;
  if(psArtist) psArtist.textContent = tr.artist||tr.extractor||'';
  const art=$('player-art'); if(art){ if(tr.thumbnail_url){ art.src=tr.thumbnail_url; art.style.display=''; } else art.style.display='none'; }
  const psArt=$('ps-art'), psPh=$('ps-art-ph');
  if(psArt && psPh){ if(tr.thumbnail_url){ psArt.src=tr.thumbnail_url; psArt.style.display=''; psPh.style.display='none'; } else { psArt.style.display='none'; psPh.style.display='grid'; } }
  syncPlayButtons();
}
function next(){
  const q = window._playQueue || filteredTracks();
  if(!q.length) return;
  queuePos = (queuePos+1) % q.length;
  playTrack(q[queuePos].id);
}
function prev(){
  const q = window._playQueue || filteredTracks();
  if(!q.length) return;
  queuePos = (queuePos-1+q.length)%q.length;
  playTrack(q[queuePos].id);
}
function togglePlay(){
  if(!curTrackId){ const f=filteredTracks(); if(f[0]) playTrack(f[0].id); return; }
  if(audio.paused){ audio.play().catch(()=>toast('Playback failed')); } else { audio.pause(); }
}
$('play-btn')?.addEventListener('click', ()=>{ vibrate(8); togglePlay(); });
$('ps-play')?.addEventListener('click', ()=>{ vibrate(8); togglePlay(); });
$('next-btn')?.addEventListener('click', ()=>{ vibrate(8); next(); });
$('ps-next')?.addEventListener('click', ()=>{ vibrate(8); next(); });
$('prev-btn')?.addEventListener('click', ()=>{ vibrate(8); prev(); });
$('ps-prev')?.addEventListener('click', ()=>{ vibrate(8); prev(); });
function setRepeat(v){
  repeat=v;
  document.querySelectorAll('#repeat-btn, #repeat-btn-ps').forEach(b=> b.classList.toggle('active', repeat));
}
$('repeat-btn')?.addEventListener('click', ()=>{ vibrate(8); setRepeat(!repeat); toast(repeat?'Repeat on':'Repeat off'); });
$('repeat-btn-ps')?.addEventListener('click', ()=>{ vibrate(8); setRepeat(!repeat); toast(repeat?'Repeat on':'Repeat off'); });
function patchPlayingRow(){
  document.querySelectorAll('.track.playing').forEach(n=>{ if(n.dataset.id!==curTrackId) n.classList.remove('playing','is-playing'); });
  const row = document.querySelector(`.track[data-id="${CSS.escape(String(curTrackId||''))}"]`);
  if(row){
    row.classList.add('playing');
    row.classList.toggle('is-playing', isPlaying);
    const btn=row.querySelector('[data-play]');
    if(btn) btn.textContent = isPlaying ? '⏸' : '▶';
    const eq=row.querySelector('.t-eq'); if(eq) eq.style.display = isPlaying ? 'flex' : 'none';
    const bar=row.querySelector('.t-progress'); if(bar) bar.style.display = isPlaying ? 'block' : 'none';
  }
}
audio.addEventListener('ended', ()=>{ if(repeat) audio.play().catch(()=>{}); else next(); });
audio.addEventListener('play', ()=>{ isPlaying=true; syncPlayButtons(); patchPlayingRow(); if('mediaSession' in navigator) try{navigator.mediaSession.playbackState='playing';}catch{} });
audio.addEventListener('pause', ()=>{ isPlaying=false; syncPlayButtons(); patchPlayingRow(); if('mediaSession' in navigator) try{navigator.mediaSession.playbackState='paused';}catch{} });
audio.addEventListener('error', async ()=>{ isPlaying=false; syncPlayButtons(); const tr=tracks.find(t=>t.id===curTrackId); if(tr && currentUser && tr.storage_path){ urlCache.delete(tr.storage_path); const u=await getSignedUrl(tr.storage_path,true); if(u && u!==audio.src){ audio.src=u; audio.play().catch(()=>{ toast('Audio load error — file may be missing'); }); return; } } toast('Audio load error — file may be missing'); });
function onTimeUpdate(){
  if(!isFinite(audio.duration)) return;
  const cur=fmtTime(audio.currentTime), dur=fmtTime(audio.duration);
  const ct=$('cur-time'); if(ct) ct.textContent=cur;
  const dt=$('dur-time'); if(dt) dt.textContent=dur;
  const v=Math.round(audio.currentTime/audio.duration*1000);
  const seek=$('seek'), psSeek=$('ps-seek');
  if(seek) seek.value=v;
  if(psSeek) psSeek.value=v;
  const fill=$('ps-fill'); if(fill) fill.style.width=(audio.currentTime/audio.duration*100)+'%';
  // row progress line
  const bar=document.querySelector(`.t-progress-bar[data-bar="${CSS.escape(curTrackId||'')}"]`);
  if(bar) bar.style.width = (audio.currentTime/audio.duration*100) + '%';
  if('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession){
    try{ navigator.mediaSession.setPositionState({duration: audio.duration||0, playbackRate: audio.playbackRate||1, position: audio.currentTime||0}); }catch{}
  }
}
audio.addEventListener('timeupdate', onTimeUpdate);
audio.addEventListener('loadedmetadata', onTimeUpdate);
function seekTo(frac){
  if(isFinite(audio.duration)) audio.currentTime = frac*audio.duration;
}
$('seek')?.addEventListener('input', ()=> seekTo($('seek').value/1000));
$('ps-seek')?.addEventListener('input', ()=>{ const v=$('ps-seek').value; seekTo(v/1000); const f=$('ps-fill'); if(f) f.style.width=(v/10)+'%'; });
$('vol')?.addEventListener('input', ()=> audio.volume=$('vol').value);
audio.volume=0.9;
$('shuffle-btn')?.addEventListener('click', ()=>{
  vibrate(10);
  const f=filteredTracks(); for(let i=f.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [f[i],f[j]]=[f[j],f[i]]; }
  window._playQueue=f; queuePos=-1; next(); toast('Shuffled');
});
$('play-all-btn')?.addEventListener('click', ()=>{ vibrate(8); const f=filteredTracks(); if(f[0]) playTrack(f[0].id); });
$('cache-btn')?.addEventListener('click', async()=>{
  if(!curTrackId) return toast('Play a track first');
  const tr=tracks.find(t=>t.id===curTrackId);
  const url=await getSignedUrl(tr.storage_path);
  try{
    const c=await caches.open('tracks-v1');
    toast('Caching for offline...');
    await c.add(url);
    toast('Cached offline ✓');
  }catch(e){ toast('Cache failed: '+e.message); }
});

// Player sheet
const playerSheet=$('player-sheet'), playerOverlay=$('player-overlay');
function openPlayerSheet(){
  if(!curTrackId){ toast('Play something first'); return; }
  playerSheet.classList.add('open'); playerSheet.setAttribute('aria-hidden','false');
  playerOverlay.style.display='block';
  document.body.style.overflow='hidden';
}
function closePlayerSheet(){
  if(!playerSheet) return;
  playerSheet.classList.remove('open'); playerSheet.setAttribute('aria-hidden','true');
  playerOverlay.style.display='none';
  document.body.style.overflow='';
}
$('player-expand')?.addEventListener('click', ()=>{ vibrate(8); openPlayerSheet(); });
$('ps-close')?.addEventListener('click', ()=>{ vibrate(8); closePlayerSheet(); });
playerOverlay?.addEventListener('click', closePlayerSheet);
$('ps-more')?.addEventListener('click', ()=>{ if(curTrackId) openTrackSheet(curTrackId); });
audio.volume=0.9;
audio.removeAttribute('crossorigin');

// swipe: down to close + left/right for next/prev
(function(){
  if(!playerSheet) return;
  let sx=0, sy=0, dx=0, dy=0, drag=false;
  const TH_X=60, TH_Y=90;
  playerSheet.addEventListener('touchstart', e=>{ sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0; dy=0; drag=true; playerSheet.style.transition='none'; }, {passive:true});
  playerSheet.addEventListener('touchmove', e=>{
    if(!drag) return;
    dx=e.touches[0].clientX - sx;
    dy=e.touches[0].clientY - sy;
    // prioritize vertical vs horizontal
    if(Math.abs(dx) > Math.abs(dy)){
      // horizontal drag — translateX subtle
      if(Math.abs(dx) < 80) playerSheet.style.transform=`translateX(${dx*0.35}px)`;
    } else {
      if(dy>0) playerSheet.style.transform=`translateY(${dy}px)`;
    }
  }, {passive:true});
  playerSheet.addEventListener('touchend', ()=>{
    drag=false; playerSheet.style.transition=''; playerSheet.style.transform='';
    if(Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TH_X){
      vibrate(10);
      if(dx < 0) next(); else prev();
    } else if(dy > TH_Y) closePlayerSheet();
    dx=0; dy=0;
  });
  // desktop drag with mouse for testing
  let mx=0, my=0, mdx=0, mdy=0, mdrag=false;
  const artWrap=document.querySelector('.ps-art-wrap');
  if(artWrap){
    artWrap.addEventListener('mousedown', e=>{ mx=e.clientX; my=e.clientY; mdrag=true; });
    window.addEventListener('mousemove', e=>{ if(!mdrag) return; mdx=e.clientX - mx; mdy=e.clientY - my; });
    window.addEventListener('mouseup', ()=>{ if(!mdrag) return; mdrag=false; if(Math.abs(mdx) > TH_X && Math.abs(mdx) > Math.abs(mdy)){ if(mdx<0) next(); else prev(); } mdx=0; mdy=0; });
  }
})();

// search/filter - debounced
let searchDebounce=null;
searchInput?.addEventListener('input', ()=>{
  clearTimeout(searchDebounce);
  updateSearchClear();
  searchDebounce=setTimeout(()=>{
    searchQ=searchInput.value.trim();
    renderTracks();
    if(searchQ.length>=2) logEvent('search', null, { q: searchQ.slice(0,40), filter });
  }, 160);
});
document.querySelectorAll('.chip').forEach(c=> c.addEventListener('click', ()=>{
  vibrate(5);
  document.querySelectorAll('.chip').forEach(x=>{ x.classList.remove('active'); x.setAttribute('aria-selected','false'); });
  c.classList.add('active'); c.setAttribute('aria-selected','true');
  filter=c.dataset.filter; renderTracks();
}));
$('refresh-btn')?.addEventListener('click', async()=>{ await Promise.all([loadTracks(), loadQueue(), loadPlaylists()]); toast('Refreshed'); });

// --- Realtime ---
try{
  sb.channel('music-changes')
    .on('postgres_changes', {event:'*', schema:'public', table:'tracks'}, ()=> loadTracks())
    .on('postgres_changes', {event:'*', schema:'public', table:'ingest_queue'}, ()=> loadQueue())
    .on('postgres_changes', {event:'*', schema:'public', table:'playlists'}, ()=> loadPlaylists())
    .subscribe();
}catch{}

// --- Init ---
loadTracks(); loadQueue(); loadPlaylists();
// realtime push is primary (see channel above); refresh queue only when tab becomes visible
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && currentUser) loadQueue(); });

// SW — explicit scope + error log for Render vs GH Pages
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', {scope:'./'}).catch(e=>console.warn('SW fail',e));
