'use strict';
// Hedge Music - PWA frontend: queue yt-dlp URLs -> Supabase, play tracks, playlists
const SUPABASE_URL = 'https://mgwaehtmdecvptzzigwv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nd2FlaHRtZGVjdnB0enppZ3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3Nzk4NjEsImV4cCI6MjEwMzM1NTg2MX0.iXHwe9wQgC_fHvOqh9TFRcJu9ypJpRdXVvOaKweGreQ';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;');
function isValidThumb(url){ try{ const u=new URL(url); return u.protocol==='https:'; }catch{ return false; } }
function toast(m, kind){
  const t=$('toast'); if(!t) return;
  t.textContent=m;
  t.classList.toggle('toast--err', kind==='error');
  t.classList.add('show'); t.style.display='block';
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>{t.classList.remove('show','toast--err'); t.style.display='none';},2500);
}
toast.error = m => toast(m, 'error');
function vibrate(p=10){ try{ navigator.vibrate&&navigator.vibrate(p);}catch{} }

// --- State ---
let tracks = [];
let popularCache = null;      // Map trackId -> plays, fetched once per session
let queue = [];
let playlists = [];
let playlistTracks = [];
let activePlaylistId = null;
let filter = 'recent';    // smart views: recent | popular | likes
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
  const liked = likes.has(id);
  // fast path: patch like buttons in place — no full list rebuild (keeps scroll + smooth)
  let patched = false;
  document.querySelectorAll(`[data-like="${CSS.escape(String(id))}"]`).forEach(btn=>{
    patched = true;
    btn.classList.toggle('liked', liked);
    const use = btn.querySelector('use');
    if(use) use.setAttribute('href', liked ? '#i-heart-filled' : '#i-heart');
    btn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
  });
  // Likes tab needs a re-render (row appears/disappears); otherwise skip it
  const isLikesView = isMobile() && document.body.getAttribute('data-mobile-tab')==='likes';
  if(isLikesView || !patched) renderTracks();
  else patchPlayingRow();
  updateLikesCount();
  toast(liked ? 'Added to Likes' : 'Removed from Likes');
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
    area.innerHTML=`<button id="avatar-btn" class="avatar-btn" aria-label="Profile menu" aria-expanded="false">${esc(initial)}</button><div id="profile-menu" class="profile-menu" style="display:none"><div class="profile-email" title="${esc(currentUser.email)}">${esc(currentUser.email)}</div><button id="open-settings" class="btn btn-ghost">Settings</button><button id="auth-logout" class="btn btn-ghost">Log out</button></div>`;
    $('avatar-btn')?.addEventListener('click', (e)=>{ e.stopPropagation(); toggleProfileMenu(); });
    $('open-settings')?.addEventListener('click', ()=>{ toggleProfileMenu(false); openSettings(); });
    $('auth-logout')?.addEventListener('click', async()=>{ toggleProfileMenu(false); await sb.auth.signOut(); });
  } else {
    area.innerHTML=`<button id="auth-open" class="btn btn-ghost" style="min-height:32px">Log in</button><button id="open-settings-guest" class="btn btn-ghost btn-icon-only" style="width:32px;height:32px" title="Settings" aria-label="Settings"><svg width="15" height="15"><use href="#i-gear"/></svg></button>`;
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
// --- Instant-boot snapshot: last library painted before network resolves ---
// Rendered synchronously when a session exists, then silently revalidated.
// (Logged-out / unapproved boots never hydrate — gate wipes state instead.)
const SNAP_KEY='hedge-snap-v1';
let firstRenderDone=false;
let _snapT=0;
function saveSnapshot(){
  const now=Date.now();
  if(now-_snapT<2000 || !tracks.length) return;
  _snapT=now;
  try{
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      uid: currentUser?.id || null,
      tracks: tracks.slice(0,50), playlists, playlistTracks, ts: now
    }));
  }catch{}
}
function restoreSnapshot(){
  try{
    const s=JSON.parse(localStorage.getItem(SNAP_KEY)||'null');
    if(!s || !Array.isArray(s.tracks) || !s.tracks.length) return false;
    // never paint another user's cached library (shared device)
    if(!currentUser || s.uid !== currentUser.id) return false;
    tracks=s.tracks;
    if(Array.isArray(s.playlists)) playlists=s.playlists;
    if(Array.isArray(s.playlistTracks)) playlistTracks=s.playlistTracks;
    const tc=$('tracks-count'); if(tc) tc.textContent=tracks.length+'+ tracks';
    renderPlaylists(); renderTracks();
    return true;
  }catch{ return false; }
}
function clearSnapshot(){ try{ localStorage.removeItem(SNAP_KEY); }catch{} }
// --- Resume: now-playing (+position) across reloads. Tap to play (autoplay policy). ---
const RESUME_KEY='hedge-resume-v1';
const UI_KEY='hedge-ui-v1';
let _resumeT=0, _uiT=0;
function saveResume(force=false){
  if(!curTrackId || !audio) return;
  const now=Date.now();
  if(!force && now-_resumeT<5000) return;
  _resumeT=now;
  try{
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      id:curTrackId, pos:audio.currentTime||0,
      q:(window._playQueue||[]).map(t=>t.id).slice(0,200), ts:now
    }));
  }catch{}
}
function persistUI(){
  const now=Date.now();
  if(now-_uiT<500) return;
  _uiT=now;
  try{
    const s=$('search');
    localStorage.setItem(UI_KEY, JSON.stringify({ y: window.scrollY||0, q: s ? s.value : '' }));
  }catch{}
}
async function restorePlaying(){
  if(curTrackId) return; // user already started something
  let r=null;
  try{ r=JSON.parse(localStorage.getItem(RESUME_KEY)||'null'); }catch{}
  if(!r?.id || !currentUser) return;
  const tr=tracks.find(t=>t.id===r.id);
  if(!tr?.storage_path) return;
  curTrackId=r.id;
  const map=new Map(tracks.map(t=>[t.id,t]));
  const q=Array.isArray(r.q) ? r.q.map(id=>map.get(id)).filter(Boolean) : [];
  window._playQueue=q.length?q:[tr];
  queuePos=Math.max(0, window._playQueue.findIndex(t=>t.id===r.id));
  isPlaying=false;
  updatePlayerUI(tr);
  patchPlayingRow();
  try{
    const url=await getSignedUrl(tr.storage_path);
    if(url && curTrackId===r.id && !isPlaying){
      audio.src=url;
      const at=Math.max(0, r.pos||0);
      if(at>1){
        const apply=()=>{ try{ audio.currentTime=Math.min(at, Math.max(0,(audio.duration||at+1)-0.5)); }catch{} };
        if(audio.readyState>=1) apply();
        else audio.addEventListener('loadedmetadata', apply, {once:true});
      }
    }
  }catch{}
  const artist=$('player-artist');
  if(artist) artist.textContent=((tr.artist||tr.extractor||'')+' • tap to resume').trim();
}
function restoreUIState(){
  let u=null;
  try{ u=JSON.parse(localStorage.getItem(UI_KEY)||'null'); }catch{}
  if(!u) return;
  try{
    const s=$('search');
    if(s && u.q){ s.value=u.q; searchQ=u.q; updateSearchClear(); renderTracks(); }
    if(u.y>0) requestAnimationFrame(()=> window.scrollTo(0, u.y));
  }catch{}
}
async function isApproved(){
  // fail-CLOSED: any RPC error means "not approved" (locked gate, never open library)
  try{ const { data, error } = await sb.rpc('is_approved'); if(!error) return !!data; }catch{}
  return false;
}
async function initAuth(){
  const {data:{session}}=await sb.auth.getSession();
  currentUser=session?.user||null;
  renderAuth();
  if(currentUser){
    const approved = await isApproved();
    if(!approved){
      queue=[]; playlists=[]; playlistTracks=[]; tracks=[];
      clearSnapshot();
      $('tracks-list').innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Awaiting approval</strong></div><small>Your account is pending review — you will see your library once approved.</small></div>`;
      const qc=$('queue-count'); if(qc) qc.textContent='awaiting approval';
      const pl=$('playlists-list'); if(pl) pl.innerHTML='<small style="color:var(--text-tertiary)">Awaiting approval</small>';
      toast('Awaiting admin approval');
      return;
    }
    restoreSnapshot(); // instant paint from last session, then silent revalidate below
    await Promise.all([loadQueue(), loadPlaylists(), loadTracks()]);
    loadPopular(); // fire-and-forget: fills play badges on rows
    restoreUIState();
    restorePlaying();
  }
  else { queue=[]; playlists=[]; playlistTracks=[]; tracks=[]; clearSnapshot(); const qc=$('queue-count'); if(qc) qc.textContent='— log in to queue'; const pl=$('playlists-list'); if(pl) pl.innerHTML='<small style="color:var(--text-tertiary)">Log in to see the shared library</small>'; $('tracks-list').innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Members only</strong></div><small>Log in to browse the shared library.</small><button id="gate-login-btn" class="btn btn-main">Log in</button></div>`; setTimeout(()=>{ const b=$('gate-login-btn'); if(b) b.addEventListener('click', ()=> showAuth('login')); },0); }
}
sb.auth.onAuthStateChange(async (_event, session)=>{
  currentUser=session?.user||null;
  renderAuth();
  if(currentUser){
    const approved = await isApproved();
    if(!approved){
      queue=[]; playlists=[]; playlistTracks=[]; tracks=[];
      $('tracks-list').innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Awaiting approval</strong></div><small>Admin will approve your account soon.</small></div>`;
      toast('Awaiting admin approval');
      return;
    }
    sessionStorage.removeItem('login-redirect'); restoreSnapshot(); await Promise.all([loadQueue(), loadPlaylists(), loadTracks()]); loadPopular(); restoreUIState(); restorePlaying();
  } else { queue=[]; playlists=[]; playlistTracks=[]; tracks=[]; clearSnapshot(); renderPlaylists(); renderTracks(); }
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
  toast('Log in to browse the shared library');
  return false;
}
function isMobile(){ return window.innerWidth<=860; }
function canonicalUrl(u){
  try{
    const url=new URL(u);
    if(url.protocol!=='http:' && url.protocol!=='https:') return u;
    url.hash='';
    if(url.hostname==='youtu.be'){ url.hostname='www.youtube.com'; const id=url.pathname.replace('/',''); url.pathname='/watch'; url.searchParams.set('v', id); }
    if(url.hostname==='m.youtube.com' || url.hostname==='music.youtube.com') url.hostname='www.youtube.com';
    ['t','si','st','utm_source','utm_medium','utm_campaign','utm_term','utm_content',
     'list','index','ab_channel','feature','pp','rad','playnext','spfreload','vl',
     'emb_logo','enablejsapi','origin','widget_referrer'].forEach(p=>url.searchParams.delete(p));
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
function setMobileTab(tab, keepFilter){
  document.body.setAttribute('data-mobile-tab', tab);
  document.querySelectorAll('.bottom-tabs .tab').forEach(b=>{
    const active=b.dataset.tab===tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active?'true':'false');
  });
  try{ localStorage.setItem('hedge-tab', tab); }catch{}
  if(location.hash!=='#'+tab) history.replaceState(null,'','#'+tab);
  // keep Library chips in sync with tabs (likes <-> likes chip, library <-> recent),
  // unless the caller just set the filter from a chip (keepFilter)
  const chipFor = tab==='likes' ? 'likes' : (tab==='library' ? 'recent' : null);
  if(chipFor && isMobile() && !keepFilter){
    filter=chipFor;
    document.querySelectorAll('.chip').forEach(x=>{
      const on=x.dataset.filter===chipFor;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on?'true':'false');
    });
    updateLikesCount();
  }
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
  if(btn) { btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false'); btn.innerHTML = willOpen ? '<svg width="13" height="13"><use href="#i-x"/></svg><span>Close</span>' : '<svg width="13" height="13"><use href="#i-plus"/></svg><span>Queue</span>'; }
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
    // wait until the list has painted — no banner pop-in over a blank screen
    let waits=0;
    const tick=()=>{
      if(!firstRenderDone && waits++ < 5){ setTimeout(tick, 1000); return; }
      if(sessionStorage.getItem('pwa-fallback-shown')) return;
      sessionStorage.setItem('pwa-fallback-shown','1');
      const b=$('pwa-banner');
      if(b){
        b.style.display='flex';
        const btn=$('pwa-install');
        if(btn && !deferredPrompt) { btn.textContent='How to install'; btn.onclick = () => { toast('On phone: browser menu → Add to Home Screen / Install app'); }; }
      }
    };
    setTimeout(tick, 1500);
  }
}, 0);

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
    $('queue-status').textContent='Queued as pending — run on laptop: node tools/ingest.js --watch';
    $('queue-status').className='status ok';
    toast('Queued');
    await loadQueue();
    logEvent('queue', null, { url: url.slice(0,120) });
  }catch(e){
    $('queue-status').textContent=e.message; $('queue-status').className='status err';
    if(e.message.includes('does not exist') || e.message.includes('relation')){
      $('queue-status').textContent += ' — Run supabase-setup.sql first.';
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
      const cls = q.status==='pending' ? 'is-pending' : (q.status==='error' || q.status==='failed') ? 'is-error' : '';
      const label = esc(q.status || 'queued');
      return `<div class="pending-item"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.original_url.slice(0,54))}${q.error? `<br><small>${esc(q.error.slice(0,60))}</small>`:''}</span><span class="pending-status ${cls}">${label}</span></div>`;
    }).join('') || '<div class="empty" style="padding:16px"><small>No queued URLs</small></div>';
    if(queue.length>12) pl.innerHTML += `<small style="color:var(--text-tertiary);padding:8px 12px;display:block">+ ${queue.length-12} more</small>`;
  }
}

// --- Tracks ---
const TRACK_PAGE = 50;
let tracksPage = 0;
let tracksAllLoaded = false;
let tracksLoading = false;
let tracksEpoch = 0; // bumps on every loadTracks call; in-flight stale responses are discarded
function showSkeleton(){
  const el=$('tracks-list'); if(!el) return;
  el.innerHTML = Array(3).fill(0).map(()=> `<div class="track skeleton" style="pointer-events:none"><div style="width:52px;height:52px;border-radius:8px;background:var(--surface-hover)"></div><div style="flex:1;display:flex;flex-direction:column;gap:8px"><div style="height:12px;width:60%;background:var(--surface-hover);border-radius:6px"></div><div style="height:10px;width:40%;background:var(--surface-hover);border-radius:6px"></div></div></div>`).join('');
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
async function loadTracks(reset=true, opts={}){
  if(!reset && (tracksLoading || tracksAllLoaded)) return; // page fetch: skip while one is in flight — observer retries
  const epoch = ++tracksEpoch;   // this call supersedes any in-flight response (reset beats stale page)
  tracksLoading=true;
  const silent = !!opts.silent;
  // Smooth refresh: keep old rows on screen while revalidating.
  // Only show skeleton on true first load (empty list). Refresh just spins the button.
  if(reset){ tracksPage=0; tracksAllLoaded=false; if(!tracks.length && !silent) showSkeleton(); }
  try{
  const start = tracksPage*TRACK_PAGE;
  const { data, error } = await sb.from('tracks')
    .select('id,original_url,extractor,extractor_id,title,artist,thumbnail_url,storage_path,duration_sec,file_size,created_at')
    .order('created_at', {ascending:false})
    .order('id', {ascending:false})         // stable tiebreaker — same row can't land on 2 pages
    .range(start, start+TRACK_PAGE-1);
  if(epoch !== tracksEpoch) return;         // a newer load/reset started — discard this stale response
  if(error){
    console.warn('tracks load', error.message);
    if(error.message.includes('does not exist')) $('tracks-list').innerHTML = '<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Setup required</strong></div><small>Run <code>supabase-setup.sql</code> in Supabase SQL Editor, then queue a URL.</small></div>';
    else $('tracks-list').innerHTML = '<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Could not load tracks</strong></div><small>Check your connection and try refreshing.</small></div>';
    return;
  }
  if(!data || !data.length) tracksAllLoaded=true;
  if(reset){
    // skip re-render when nothing changed — refresh feels instant, no flicker
    const prevSig = tracks.length ? tracks.map(t=>t.id).join(',') : null;
    const nextSig = (data||[]).map(t=>t.id).join(',');
    tracks = data||[];
    if(prevSig === nextSig && !opts.forceRender){
      const tc0=$('tracks-count'); if(tc0) tc0.textContent = tracks.length+' tracks';
      return;
    }
  }
  else{
    const known = new Set(tracks.map(t=>t.id));
    tracks = [...tracks, ...(data||[]).filter(t=>!known.has(t.id))]; // deduped merge — no repeats on races/edge ties
  }
  tracksPage++;
  const tc=$('tracks-count'); if(tc) tc.textContent = tracks.length+' tracks';
  // members-only gate: enforce login + approval
  if(!currentUser){
    const el=$('tracks-list'); if(el) el.innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Members only</strong></div><small>Log in to browse the shared library.</small><button id="empty-login-btn" class="btn btn-main">Log in</button></div>`;
    setTimeout(()=>{ const b=$('empty-login-btn'); if(b) b.addEventListener('click', ()=> showAuth('login')); },0);
    return;
  }
  // check approval async — if not approved, loadTracks already gated in initAuth, but handle direct call
  sb.rpc('is_approved').then(({data})=>{ if(!data){ const el=$('tracks-list'); if(el) el.innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Awaiting approval</strong></div><small>Admin will approve your account soon.</small></div>`; } }).catch(()=>{});
  renderTracks();
  }finally{ tracksLoading=false; }
}

// Pagination guard: playlist may reference tracks beyond loaded pages — fetch missing by id
const _fetchedPlaylistIds = new Set();
async function ensurePlaylistTracksLoaded(ids){
  if(!ids?.length) return;
  const missing = ids.filter(id => !tracks.some(t=>t.id===id) && !_fetchedPlaylistIds.has(id));
  if(!missing.length) return;
  missing.forEach(id=>_fetchedPlaylistIds.add(id));
  try{
    const { data } = await sb.from('tracks')
      .select('id,original_url,extractor,extractor_id,title,artist,thumbnail_url,storage_path,duration_sec,file_size,created_at')
      .in('id', missing.slice(0,100));
    if(data?.length){
      tracks = [...tracks, ...data];
      renderTracks();
    }
  }catch(e){ console.warn('playlist fetch', e.message); }
}

function filteredTracks(){
  let t = tracks;
  // Likes view: chip on desktop, bottom-tab on mobile
  if(filter==='likes' || (isMobile() && document.body.getAttribute('data-mobile-tab')==='likes')){
    t = t.filter(x=>likes.has(x.id));
  }
  if(activePlaylistId){
    const ids = new Set(playlistTracks.filter(pt=>pt.playlist_id===activePlaylistId).map(pt=>pt.track_id));
    t = t.filter(x=>ids.has(x.id));
    const pos = Object.fromEntries(playlistTracks.filter(pt=>pt.playlist_id===activePlaylistId).map(pt=>[pt.track_id, pt.position]));
    t = [...t].sort((a,b)=>(pos[a.id]||0)-(pos[b.id]||0));
    ensurePlaylistTracksLoaded([...ids]); // pagination guard: fetch any tracks not yet paged in
  }
  if(searchQ) {
    const q=searchQ.toLowerCase();
    t = t.filter(x=> (x.title||'').toLowerCase().includes(q) || (x.artist||'').toLowerCase().includes(q) || (x.extractor||'').toLowerCase().includes(q));
  }
  // Most played: order by plays (falls back to newest when no plays yet)
  if(filter==='popular') t = [...t].sort((a,b)=>((popularCache?.get(b.id))||0)-((popularCache?.get(a.id))||0));
  // safety net: never emit duplicate rows regardless of merge path
  const seen = new Set();
  return t.filter(x=>{ if(seen.has(x.id)) return false; seen.add(x.id); return true; });
}

// --- Popular (plays from track_events via gated RPC) ---
async function loadPopular(){
  if(!currentUser) return;
  try{
    const { data, error } = await sb.rpc('get_popular_tracks', { p_limit: 500, p_offset: 0 });
    if(error){ console.warn('popular', error.message); return; }
    popularCache = new Map((data||[]).map(r=>[r.id, r.plays]));
    renderTracks();
  }catch(e){ console.warn('popular', e.message); }
}
let _likesCountShown = -1;
function updateLikesCount(){
  const el=$('likes-count');
  if(!el) return;
  const n=likes.size;
  if(n===_likesCountShown) return;
  _likesCountShown=n;
  el.textContent = n ? ` · ${n}` : '';
}

async function removeFromPlaylist(pid, tid){
  if(!pid || !tid) return;
  if(!requireAuth()) return;
  const { error } = await sb.from('playlist_tracks').delete().eq('playlist_id', pid).eq('track_id', tid);
  if(error){
    if(error.message.includes('policy') || error.message.includes('permission')) toast('Not allowed — not owner');
    else toast.error('Remove failed: '+error.message);
    return;
  }
  toast('Removed from playlist');
  await loadPlaylists();
}
function clearAllFilters(){
  const s=$('search'); if(s) s.value='';
  searchQ=''; filter='recent'; activePlaylistId=null;
  document.querySelectorAll('.chip').forEach(c=>{c.classList.remove('active'); c.setAttribute('aria-selected','false')});
  const recent=document.querySelector('[data-filter=recent]');
  if(recent){recent.classList.add('active'); recent.setAttribute('aria-selected','true')}
  updateListHead(); renderPlaylists(); renderTracks(); updateSearchClear();
}
function renderTracks(){
  const list = filteredTracks();
  const el=$('tracks-list');
  if(!el) return;
  ensureTrackDelegation();
  firstRenderDone=true;
  updateLikesCount();
  saveSnapshot();
  const keepSentinel = el.querySelector('#track-sentinel'); // preserve observer node across innerHTML
  if(!list.length){
    const isLikesView = isMobile() && document.body.getAttribute('data-mobile-tab')==='likes';
    const isFiltered = isLikesView || activePlaylistId || filter!=='recent' || searchQ;
    if(isLikesView){
      el.innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-heart"/></svg></div><div><strong>No liked songs yet</strong></div><small>Tap the heart on any track and it will show up here.</small></div>`;
      return;
    }
    if(isFiltered){
      el.innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-search"/></svg></div><div><strong>No tracks match</strong></div><small>Try a different search or filter.</small><button id="clear-filters-btn" class="btn btn-ghost">Clear filters</button></div>`;
    } else {
      el.innerHTML=`<div class="empty"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>No tracks yet</strong></div><small>Queue a link and run the laptop ingest to add music.</small><button id="empty-queue-btn" class="btn btn-main">Queue your first track</button></div>`;
    }
    return;
  }
  el.innerHTML = list.map(tr=>{
    const isCur = tr.id===curTrackId;
    const playingClass = isCur ? 'playing' + (isPlaying ? ' is-playing' : '') : '';
    const art = (tr.thumbnail_url && isValidThumb(tr.thumbnail_url)) ? `<img src="${esc(tr.thumbnail_url)}" loading="lazy" decoding="async" width="52" height="52" alt="">` : `<div class="t-ph"><svg><use href="#i-music"/></svg></div>`;
    const dur = tr.duration_sec ? fmtTime(tr.duration_sec) : '--:--';
    const plays = popularCache?.get(tr.id) || 0;
    const playBadge = plays ? `${plays} plays` : '';
    const artistLine = tr.artist || tr.extractor || '';
    const meta = [esc(artistLine), playBadge ? esc(playBadge) : '', esc(dur)].filter(Boolean).join('<span class="sep">·</span>');
    const progress = isCur && isFinite(audio.duration) && audio.duration ? Math.round(audio.currentTime/audio.duration*100) : 0;
    const liked=isLiked(tr.id);
    return `<div class="track ${playingClass}" data-id="${esc(tr.id)}">
      ${art}
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:6px;min-width:0"><div class="t-title" style="flex:1">${esc(tr.title)}</div><div class="t-eq" aria-hidden="true"><span></span><span></span><span></span></div></div>
        <div class="t-sub">${meta}</div>
      </div>
      <div class="t-actions">
        <button class="mini play-mini ${isCur && isPlaying?'playing':''}" data-play="${esc(tr.id)}" aria-label="${isCur && isPlaying ? 'Pause' : 'Play'}"><svg width="12" height="12" class="i-play-icon"><use href="#i-play"/></svg><svg width="12" height="12" class="i-pause-icon"><use href="#i-pause"/></svg></button>
        <button class="like-btn ${liked?'liked':''}" data-like="${esc(tr.id)}" aria-label="${liked ? 'Unlike' : 'Like'}"><svg><use href="${liked ? '#i-heart-filled' : '#i-heart'}"/></svg></button>
        <button class="track-more" data-more="${esc(tr.id)}" aria-label="More actions"><svg><use href="#i-dots"/></svg></button>
      </div>
      <div class="t-progress" aria-hidden="true"><div class="t-progress-bar" data-bar="${esc(tr.id)}" style="width:${progress}%"></div></div>
    </div>`;
  }).join('');
  if(keepSentinel) el.appendChild(keepSentinel); // re-attach before rows' end so observer keeps working
  else trackSentinel(); // first render creates it
}

// Single delegated click handler — attaching ~200 listeners per render was the main jank source
function ensureTrackDelegation(){
  const el=$('tracks-list');
  if(!el || el._delegated) return;
  el._delegated = true;
  el.addEventListener('click', e=>{
    const likeBtn = e.target.closest('[data-like]');
    if(likeBtn){ e.stopPropagation(); toggleLike(likeBtn.getAttribute('data-like')); return; }
    const moreBtn = e.target.closest('[data-more]');
    if(moreBtn){ e.stopPropagation(); vibrate(8); openTrackSheet(moreBtn.getAttribute('data-more')); return; }
    const playBtn = e.target.closest('[data-play]');
    if(playBtn){
      e.stopPropagation();
      vibrate(8);
      const id=playBtn.getAttribute('data-play');
      if(id===curTrackId && isPlaying){ audio.pause(); } else { playTrack(id); }
      return;
    }
    const clearBtn = e.target.closest('#clear-filters-btn');
    if(clearBtn){ vibrate(8); clearAllFilters(); return; }
    const qBtn = e.target.closest('#empty-queue-btn');
    if(qBtn){ vibrate(8); setIngest(true); return; }
    const loginBtn = e.target.closest('#empty-login-btn');
    if(loginBtn){ showAuth('login'); return; }
    const row = e.target.closest('.track');
    if(row?.dataset?.id){
      vibrate(8);
      if(row.dataset.id === curTrackId) openPlayerSheet();
      else playTrack(row.dataset.id);
    }
  });
}

// --- Track Sheet ---
function openTrackSheet(trackId){
  const tr=tracks.find(t=>t.id===trackId);
  if(!tr) return;
  pendingSheetTrackId=trackId;
  const sheet=$('track-sheet'), overlay=$('track-overlay');
  const head=$('track-sheet-head');
  const art = (tr.thumbnail_url && isValidThumb(tr.thumbnail_url)) ? `<img src="${esc(tr.thumbnail_url)}" alt="">` : `<div class="as-head-ph"><svg width="20" height="20"><use href="#i-music"/></svg></div>`;
  head.innerHTML=`${art}<div class="as-head-text"><div class="as-head-title">${esc(tr.title)}</div><div class="as-head-sub">${esc(tr.artist||tr.extractor||'')}</div></div>`;
  // contextual remove — show only if currently viewing that playlist and track is in it
  let removeHtml = '';
  if(activePlaylistId && playlistTracks.some(pt=>pt.playlist_id===activePlaylistId && pt.track_id===trackId)){
    const plName = playlists.find(p=>p.id===activePlaylistId)?.name || 'this playlist';
    removeHtml = `<button id="as-remove" class="as-btn as-remove"><svg><use href="#i-x"/></svg><span>Remove from ${esc(plName)}</span></button><div class="as-divider"></div>`;
  }
  const plWrap=$('as-playlists');
  if(playlists.length){
    plWrap.innerHTML = removeHtml + playlists.map(p=> `<button class="as-pl-btn" data-pid="${esc(p.id)}">${esc(p.name)}</button>`).join('');
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
  if(tr && idx>=0){ q.splice(idx+1,0,tr); window._playQueue=q; toast('Will play next'); if(upnextSheet?.classList.contains('open')) renderUpNext(); }
  else if(tr) playTrack(tr.id);
  closeTrackSheet();
});
// swipe down to dismiss track sheet (hardened: cancel/multi-touch can never latch a stuck transform)
(function attachSheetSwipe(){
  const sheet=$('track-sheet');
  if(!sheet) return;
  let startY=0, curY=0, dragging=false;
  function endSheetSwipe(cancelled){
    dragging=false; sheet.style.transition='';
    sheet.style.transform='';
    if(!cancelled && curY>90) closeTrackSheet();
    curY=0;
  }
  sheet.addEventListener('touchstart', e=>{ if(e.touches.length>1){ dragging=false; return; } startY=e.touches[0].clientY; curY=0; dragging=true; sheet.style.transition='none'; }, {passive:true});
  sheet.addEventListener('touchmove', e=>{
    if(!dragging) return;
    curY=e.touches[0].clientY - startY;
    if(curY>0) sheet.style.transform=`translateY(${Math.min(curY,160)}px)`;
  }, {passive:true});
  sheet.addEventListener('touchend', ()=> endSheetSwipe(false));
  sheet.addEventListener('touchcancel', ()=> endSheetSwipe(true));
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
function selectPlaylist(id){
  // toggle: clicking active All stays All, clicking active playlist again goes back to All
  if(id === activePlaylistId){ activePlaylistId = null; }
  else activePlaylistId = id || null;
  const titleEl=$('list-title'); if(titleEl) titleEl.textContent = activePlaylistId ? (playlists.find(p=>p.id===activePlaylistId)?.name || 'Playlist') : 'All tracks';
  updateListHead();
  renderPlaylists(); renderTracks();
  if(isMobile()) setMobileTab('library');
  if(activePlaylistId) setTimeout(()=> document.querySelector('.main')?.scrollIntoView({behavior:'smooth', block:'start'}), 100);
}
function renderPlaylists(){
  const el=$('playlists-list');
  if(!el) return;
  saveSnapshot();
  if(!currentUser){ el.innerHTML='<small style="color:var(--text-tertiary)">Log in to create playlists</small>'; return; }
  // build list with All tracks on top
  const allCount = tracks.length;
  const allActive = !activePlaylistId ? 'active' : '';
  let html = `<div class="playlist-item ${allActive}" data-id="" tabindex="0" aria-label="Show all tracks">
      <span class="pl-name">All tracks</span>
      <span class="pl-count">${allCount}</span>
    </div>`;
  if(!playlists.length){
    html += '<small style="color:var(--text-tertiary);padding:10px 2px 2px;display:block">No playlists yet — create one above</small>';
  } else {
    html += playlists.map(p=>{
      const count = playlistTracks.filter(pt=>pt.playlist_id===p.id).length;
      return `<div class="playlist-item ${activePlaylistId===p.id?'active':''}" data-id="${esc(p.id)}" tabindex="0" aria-label="Show playlist ${esc(p.name)}">
        <span class="pl-name">${esc(p.name)}</span>
        <span style="display:flex;align-items:center;gap:6px;flex-shrink:0"><span class="pl-count">${count}</span><button class="del-pl" data-id="${esc(p.id)}" aria-label="Delete playlist"><svg width="12" height="12"><use href="#i-x"/></svg></button></span>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;
  el.querySelectorAll('.playlist-item').forEach(n=> n.addEventListener('click', e=>{
    if(e.target.closest('.del-pl')) return;
    selectPlaylist(n.dataset.id);
  }));
  el.querySelectorAll('.playlist-item').forEach(n=> n.addEventListener('keydown', e=>{
    if((e.key === 'Enter' || e.key === ' ') && e.target === n){
      e.preventDefault();
      selectPlaylist(n.dataset.id);
    }
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
      back.style.minHeight='32px';
      back.style.fontSize='12.5px';
      back.textContent='← All tracks';
      back.addEventListener('click', ()=>{ vibrate(8); activePlaylistId=null; updateListHead(); renderPlaylists(); renderTracks(); toast('Showing all tracks'); });
      head.insertBefore(back, titleEl);
    }
    back.style.display='';
    titleEl.style.display='none';
  } else {
    const isLikesView = isMobile() && document.body.getAttribute('data-mobile-tab')==='likes';
    titleEl.textContent = (isLikesView || filter==='likes') ? 'Liked' : (filter==='popular' ? 'Most played' : 'Recently added');
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
  if(!currentUser){ showAuth('login'); toast('Log in to play tracks'); return; }
  curTrackId=id;
  buildQueueFromCurrent(id);
  const url = await getSignedUrl(tr.storage_path);
  if(!url){ toast('File missing'); return; }
  audio.src = url;
  audio.play().catch(e=>{ toast.error('Playback failed'); console.warn(e); isPlaying=false; syncPlayButtons(); });
  isPlaying=true;
  updatePlayerUI(tr);
  patchPlayingRow(); // was renderTracks(): full rebuild killed scroll + caused flicker on every play
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
  const b=$('play-btn'); if(b) b.classList.toggle('playing', isPlaying);
  const pb=$('ps-play'); if(pb) pb.classList.toggle('playing', isPlaying);
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
  // ambient backdrop — blurred cover art behind the sheet
  const ambient=$('ps-ambient');
  if(ambient){
    if(tr.thumbnail_url && isValidThumb(tr.thumbnail_url)) ambient.style.backgroundImage=`url("${tr.thumbnail_url}")`;
    else ambient.style.backgroundImage='none';
  }
  renderUpNext();
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
  if(audio.paused){ audio.play().catch(()=>toast.error('Playback failed')); } else { audio.pause(); }
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
    if(btn) btn.classList.toggle('playing', isPlaying);
    const eq=row.querySelector('.t-eq'); if(eq) eq.style.display = isPlaying ? 'flex' : 'none';
    const bar=row.querySelector('.t-progress'); if(bar) bar.style.display = isPlaying ? 'block' : 'none';
  }
}
audio.addEventListener('ended', ()=>{ if(repeat) audio.play().catch(()=>{}); else next(); });
audio.addEventListener('play', ()=>{ isPlaying=true; syncPlayButtons(); patchPlayingRow(); if('mediaSession' in navigator) try{navigator.mediaSession.playbackState='playing';}catch{} });
audio.addEventListener('pause', ()=>{ isPlaying=false; syncPlayButtons(); patchPlayingRow(); saveResume(true); if('mediaSession' in navigator) try{navigator.mediaSession.playbackState='paused';}catch{} });
let audioErrRetries = 0;
audio.addEventListener('error', async ()=>{
  isPlaying=false; syncPlayButtons();
  const tr=tracks.find(t=>t.id===curTrackId);
  // one signed-URL refresh only — persistent failures (deleted file, revoked access)
  // must surface, never loop
  if(tr && currentUser && tr.storage_path && audioErrRetries < 1){
    audioErrRetries++;
    urlCache.delete(tr.storage_path);
    const u=await getSignedUrl(tr.storage_path,true);
    if(u && u!==audio.src){ audio.src=u; audio.play().catch(()=>{ toast.error('Audio load error — file may be missing'); }); return; }
  }
  audioErrRetries = 0;
  toast.error('Audio load error — file may be missing');
});
audio.addEventListener('play', ()=>{ audioErrRetries = 0; });
function onTimeUpdate(){
  if(!isFinite(audio.duration)) return;
  saveResume(); // throttled internally — powers tap-to-resume after reload
  const cur=fmtTime(audio.currentTime), dur=fmtTime(audio.duration);
  const ct=$('cur-time'); if(ct) ct.textContent=cur;
  const dt=$('dur-time'); if(dt) dt.textContent=dur;
  const v=Math.round(audio.currentTime/audio.duration*1000);
  const seek=$('seek'), psSeek=$('ps-seek');
  if(seek){ seek.value=v; seek.style.setProperty('--fill', (v/10)+'%'); }
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
  if(!tr?.storage_path) return toast('File missing');
  const url=await getSignedUrl(tr.storage_path);
  if(!url) return toast('File missing');
  try{
    // fetch-through: the SW intercepts this request and stores it in `tracks-v1`
    // under a token-stripped key, so it survives signed-URL rotation and plays offline
    toast('Caching for offline playback…');
    const r=await fetch(url);
    if(!r.ok) throw new Error('HTTP '+r.status);
    await r.arrayBuffer(); // drain fully so the whole file is cached
    toast('Saved — plays offline');
  }catch(e){ toast.error('Cache failed: '+e.message); }
});

// --- Online / offline indicator ---
function updateNetDot(){
  const d=$('net-dot'); if(!d) return;
  const on = navigator.onLine !== false;
  d.classList.toggle('offline', !on);
  d.classList.toggle('online', on);
  d.title = on ? 'Online' : 'Offline — changes sync when reconnected';
}
window.addEventListener('online', ()=>{ updateNetDot(); toast('Back online'); });
window.addEventListener('offline', ()=>{ updateNetDot(); toast.error('Offline — playback of cached tracks still works'); });
updateNetDot();

// Player sheet
const playerSheet=$('player-sheet'), playerOverlay=$('player-overlay');
function openPlayerSheet(){
  if(!curTrackId){ toast('Play something first'); return; }
  // clear any latched drag transform from an interrupted gesture
  playerSheet.style.transition=''; playerSheet.style.transform='';
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

// --- Up Next queue sheet ---
const upnextSheet=$('upnext-sheet'), upnextOverlay=$('upnext-overlay');
function openUpNext(){
  if(!upnextSheet) return;
  renderUpNext();
  upnextSheet.classList.add('open'); upnextSheet.setAttribute('aria-hidden','false');
  if(upnextOverlay) upnextOverlay.style.display='block';
  document.body.style.overflow='hidden';
}
function closeUpNext(){
  if(!upnextSheet) return;
  upnextSheet.classList.remove('open'); upnextSheet.setAttribute('aria-hidden','true');
  if(upnextOverlay) upnextOverlay.style.display='none';
  document.body.style.overflow='';
}
function renderUpNext(){
  const el=$('upnext-list'); if(!el) return;
  const q = window._playQueue || [];
  if(!q.length){ el.innerHTML=`<div class="empty" style="padding:20px"><div class="empty-art"><svg><use href="#i-music"/></svg></div><div><strong>Queue is empty</strong></div><small>Play a track to build the queue.</small></div>`; return; }
  el.innerHTML = q.map((t,i)=>{
    const now = t.id===curTrackId;
    const art = (t.thumbnail_url && isValidThumb(t.thumbnail_url)) ? `<img src="${esc(t.thumbnail_url)}" loading="lazy" alt="">` : `<div class="up-ph"><svg><use href="#i-music"/></svg></div>`;
    return `<div class="upnext-item ${now?'is-now':''}" data-upnext="${esc(t.id)}">
      ${art}
      <div style="min-width:0">
        <div class="upnext-title">${now?'<span class="upnext-now">Now playing&nbsp;&nbsp;·&nbsp;&nbsp;</span>':''}${esc(t.title)}</div>
        <div class="upnext-artist">${esc(t.artist||t.extractor||'')}</div>
      </div>
      ${now?'':`<span class="upnext-idx">${i+1}</span><button class="upnext-remove" data-remove="${esc(t.id)}" aria-label="Remove from queue"><svg><use href="#i-x"/></svg></button>`}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-upnext]').forEach(node=>{
    node.addEventListener('click', e=>{
      if(e.target.closest('[data-remove]')) return;
      vibrate(6);
      playTrack(node.getAttribute('data-upnext'));
      renderUpNext();
    });
  });
  el.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      vibrate(8);
      const id=btn.getAttribute('data-remove');
      const q=window._playQueue||[];
      const idx=q.findIndex(t=>t.id===id);
      if(idx>=0){
        if(idx < queuePos) queuePos--; // keep position consistent when removing an earlier item
        q.splice(idx,1);
        window._playQueue=q;
      }
      renderUpNext();
      toast('Removed from queue');
    });
  });
}
$('ps-queue-btn')?.addEventListener('click', ()=>{ vibrate(8); openUpNext(); });
$('upnext-close')?.addEventListener('click', ()=>{ vibrate(6); closeUpNext(); });
upnextOverlay?.addEventListener('click', closeUpNext);
$('upnext-clear')?.addEventListener('click', ()=>{
  const q=window._playQueue||[];
  const cur=q.find(t=>t.id===curTrackId);
  window._playQueue = cur ? [cur] : [];
  queuePos = cur ? 0 : -1;
  renderUpNext();
  toast('Queue cleared');
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeUpNext(); });
// re-render Up Next when open, as playback advances
audio.addEventListener('play', ()=>{ if(upnextSheet?.classList.contains('open')) renderUpNext(); });

// swipe: down to close + left/right for next/prev
// (hardened: touchcancel / multi-touch / off-screen slides snap back instead of
// latching a stuck inline transform that used to survive close + reopen)
(function(){
  if(!playerSheet) return;
  let sx=0, sy=0, dx=0, dy=0, drag=false;
  const TH_X=60, TH_Y=90, MAX_FOLLOW=28, MAX_DOWN=160;
  function resetSheetPos(){
    drag=false; playerSheet.style.transition=''; playerSheet.style.transform='';
  }
  function endPlayerSwipe(cancelled){
    resetSheetPos();
    if(!cancelled){
      if(Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TH_X){
        vibrate(10);
        if(dx < 0) next(); else prev();
      } else if(dy > TH_Y) closePlayerSheet();
    }
    dx=0; dy=0;
  }
  playerSheet.addEventListener('touchstart', e=>{ if(e.touches.length>1){ drag=false; return; } sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0; dy=0; drag=true; playerSheet.style.transition='none'; }, {passive:true});
  playerSheet.addEventListener('touchmove', e=>{
    if(!drag) return;
    dx=e.touches[0].clientX - sx;
    dy=e.touches[0].clientY - sy;
    // prioritize vertical vs horizontal; clamped so a cancelled gesture
    // can never freeze the sheet far off-screen
    if(Math.abs(dx) > Math.abs(dy)){
      const cx=Math.max(-MAX_FOLLOW, Math.min(MAX_FOLLOW, dx*0.35));
      playerSheet.style.transform=`translateX(${cx}px)`;
    } else {
      if(dy>0) playerSheet.style.transform=`translateY(${Math.min(dy,MAX_DOWN)}px)`;
    }
  }, {passive:true});
  playerSheet.addEventListener('touchend', ()=> endPlayerSwipe(false));
  playerSheet.addEventListener('touchcancel', ()=> endPlayerSwipe(true));
  // desktop drag with mouse for testing
  let mx=0, my=0, mdx=0, mdy=0, mdrag=false;
  const artWrap=document.querySelector('.ps-art-wrap');
  if(artWrap){
    artWrap.addEventListener('mousedown', e=>{ mx=e.clientX; my=e.clientY; mdrag=true; });
    window.addEventListener('mousemove', e=>{ if(!mdrag) return; mdx=e.clientX - mx; mdy=e.clientY - my; });
    window.addEventListener('mouseup', ()=>{ if(!mdrag) return; mdrag=false; if(Math.abs(mdx) > TH_X && Math.abs(mdx) > Math.abs(mdy)){ if(mdx<0) next(); else prev(); } mdx=0; mdy=0; });
  }
})();

// search/filter - debounced; falls back to server query for tracks beyond loaded pages
let searchDebounce=null;
async function serverSearch(q){
  // sanitize for PostgREST ilike: % _ " ' \ and commas (OR separator) break/mutate the query
  const clean = String(q||'').replace(/[%_\\"'\n,]/g, '').trim().slice(0, 60);
  if(clean.length < 2) return;
  try{
    const { data } = await sb.from('tracks')
      .select('id,original_url,extractor,extractor_id,title,artist,thumbnail_url,storage_path,duration_sec,file_size,created_at')
      .or(`title.ilike.%${clean}%,artist.ilike.%${clean}%`)
      .limit(100);
    if(data?.length){
      const known = new Set(tracks.map(t=>t.id));
      const fresh = data.filter(t=>!known.has(t.id));
      if(fresh.length){ tracks=[...tracks, ...fresh]; renderTracks(); }
    }
  }catch(e){ console.warn('server search', e.message); }
}
searchInput?.addEventListener('input', ()=>{
  clearTimeout(searchDebounce);
  updateSearchClear();
  searchDebounce=setTimeout(async ()=>{
    searchQ=searchInput.value.trim();
    persistUI();
    renderTracks();
    if(searchQ.length>=2){
      logEvent('search', null, { q: searchQ.slice(0,40), filter });
      // if local pages hold no match, ask the server (covers unloaded pages)
      if(!filteredTracks().length) await serverSearch(searchQ);
    }
  }, 160);
});
document.querySelectorAll('.chip').forEach(c=> c.addEventListener('click', async ()=>{
  vibrate(5);
  document.querySelectorAll('.chip').forEach(x=>{ x.classList.remove('active'); x.setAttribute('aria-selected','false'); });
  c.classList.add('active'); c.setAttribute('aria-selected','true');
  filter=c.dataset.filter;
  updateLikesCount();
  if(filter==='popular' && !popularCache) await loadPopular();
  // on phones the track list lives under bottom tabs — route there, keeping the chip filter
  if(isMobile()){ setMobileTab(filter==='likes' ? 'likes' : 'library', true); return; }
  updateListHead(); renderTracks();
}));
let _refreshing = false;
$('refresh-btn')?.addEventListener('click', async()=>{
  if(_refreshing) return;
  const btn = $('refresh-btn');
  _refreshing = true;
  btn?.classList.add('spinning');
  btn?.setAttribute('disabled','true');
  try{
    // keep old list on screen (no skeleton), invalidate popular first so only ONE render happens
    popularCache = null;
    await Promise.all([loadTracks(true, {silent:true}), loadQueue(), loadPlaylists()]);
    await loadPopular();
    toast('Refreshed');
  } finally {
    _refreshing = false;
    btn?.classList.remove('spinning');
    btn?.removeAttribute('disabled');
  }
});

// --- Realtime (debounced: ingest inserts N rows fast — old code did full wipe+render per row) ---
let _rtTracksT = null, _rtQueueT = null, _rtPlT = null;
try{
  sb.channel('music-changes')
    .on('postgres_changes', {event:'*', schema:'public', table:'tracks'}, ()=>{ clearTimeout(_rtTracksT); _rtTracksT=setTimeout(()=> loadTracks(true, {silent:true}), 500); })
    .on('postgres_changes', {event:'*', schema:'public', table:'ingest_queue'}, ()=>{ clearTimeout(_rtQueueT); _rtQueueT=setTimeout(()=> loadQueue(), 500); })
    .on('postgres_changes', {event:'*', schema:'public', table:'playlists'}, ()=>{ clearTimeout(_rtPlT); _rtPlT=setTimeout(()=> loadPlaylists(), 500); })
    .subscribe();
}catch{}

// --- Theme (light default, dark toggle, persisted) ---
const THEME_COLORS={light:'#f9e3ed', dark:'#0c0c0f'};
function currentTheme(){ return document.documentElement.dataset.theme==='dark' ? 'dark' : 'light'; }
function syncThemeMeta(){
  const m=document.querySelector('meta[name="theme-color"]');
  if(m) m.content = THEME_COLORS[currentTheme()];
}
function syncThemeIcon(){
  const b=$('theme-btn');
  if(!b) return;
  const dark = currentTheme()==='dark';
  b.innerHTML=`<svg width="15" height="15"><use href="#${dark ? 'i-sun' : 'i-moon'}"/></svg>`;
  b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  b.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
function setTheme(t){
  document.documentElement.dataset.theme = t==='dark' ? 'dark' : 'light';
  try{ localStorage.setItem('hedge-theme', currentTheme()); }catch{}
  syncThemeIcon(); syncThemeMeta();
}
$('theme-btn')?.addEventListener('click', ()=>{ vibrate(8); setTheme(currentTheme()==='dark' ? 'light' : 'dark'); });
syncThemeIcon(); syncThemeMeta();

// --- Init ---
// NOTE: initAuth() already loads tracks/queue/playlists after session check.
// Unconditional loads here caused double-fetch + double-render on every page load (lag).
// realtime push is primary (see channel above); refresh queue only when tab becomes visible
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && currentUser) loadQueue(); });
// persist scroll for reload-restore (throttled); flush resume + UI when hidden
window.addEventListener('scroll', persistUI, {passive:true});
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden'){ saveResume(true); _uiT=0; persistUI(); } });

// SW — explicit scope + error log for Render vs GH Pages
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', {scope:'./'}).catch(e=>console.warn('SW fail',e));
