'use strict';
// Hedge Music - PWA frontend: queue yt-dlp URLs -> Supabase, play tracks, playlists
// Config: new project mgwaehtmdecvptzzigwv (provided anon key)
const SUPABASE_URL = 'https://mgwaehtmdecvptzzigwv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nd2FlaHRtZGVjdnB0enppZ3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3Nzk4NjEsImV4cCI6MjEwMzM1NTg2MX0.iXHwe9wQgC_fHvOqh9TFRcJu9ypJpRdXVvOaKweGreQ';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),2500); }

// --- State ---
let tracks = [];
let queue = [];
let playlists = [];
let playlistTracks = []; // current view join
let activePlaylistId = null; // null = all
let filter = 'all';
let searchQ = '';
let queuePos = 0;
let curTrackId = null;
let isPlaying = false;
let repeat = false;

// --- Helpers ---
function publicUrl(storagePath){ return `${SUPABASE_URL}/storage/v1/object/public/tracks/${encodeURIComponent(storagePath)}`; }
function fmtTime(s){ if(!isFinite(s)) return '0:00'; const m=Math.floor(s/60), sec=Math.floor(s%60); return m+':'+String(sec).padStart(2,'0'); }

// --- Collapsible ingest ---
function setIngest(open){
  const panel=$('ingest-panel'), btn=$('toggle-ingest');
  const willOpen = open ?? panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', !willOpen);
  panel.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
  btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  btn.textContent = willOpen ? '✕ Close' : '＋ Queue';
  if(willOpen) setTimeout(()=>$('yt-url').focus(), 120);
}
$('toggle-ingest')?.addEventListener('click', ()=> setIngest());
$('close-ingest')?.addEventListener('click', ()=> setIngest(false));
document.addEventListener('keydown', e=>{ if(e.key==='Escape') setIngest(false); });

// --- Install prompt ---
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredPrompt=e; $('install-btn').style.display=''; });
$('install-btn').addEventListener('click', async()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; $('install-btn').style.display='none'; });

// --- Queue ingest ---
$('queue-btn').addEventListener('click', queueNow);
$('yt-url').addEventListener('keydown', e=>{ if(e.key==='Enter') queueNow(); });
async function queueNow(){
  const url = $('yt-url').value.trim();
  if(!url){ toast('Paste a URL'); return; }
  try { new URL(url); } catch{ toast('Invalid URL'); return; }
  // Basic allow any url that yt-dlp can handle (not just youtube)
  if(!/^https?:\/\//i.test(url)){ toast('URL must start https://'); return; }
  $('queue-btn').disabled=true;
  $('queue-status').textContent='Queuing...'; $('queue-status').className='status';
  try{
    const { error } = await sb.from('ingest_queue').insert({ original_url: url });
    if(error) throw error;
    $('yt-url').value='';
    $('queue-status').textContent='✓ Queued as pending. Run your laptop: node tools/ingest.js --watch (batch will process all pending collectively)';
    $('queue-status').className='status ok';
    toast('Queued! Run laptop ingest to process');
    await loadQueue();
  }catch(e){
    $('queue-status').textContent='✗ '+e.message; $('queue-status').className='status err';
    // Hint if table not exists
    if(e.message.includes('does not exist') || e.message.includes('relation')){
      $('queue-status').textContent += ' — Run supabase-music.sql in Supabase SQL Editor first.';
    }
  } finally { $('queue-btn').disabled=false; }
}

async function loadQueue(){
  const { data, error } = await sb.from('ingest_queue').select('*').order('created_at', {ascending:false}).limit(50);
  if(error){ console.warn('queue load', error.message); return; }
  queue = data||[];
  const pending = queue.filter(q=>q.status==='pending');
  $('queue-count').textContent = pending.length+' pending';
  const badge = $('queue-badge');
  if(pending.length){ badge.style.display=''; badge.textContent = pending.length+' queued'; } else badge.style.display='none';
  $('pending-list').innerHTML = queue.slice(0,8).map(q=>{
    const s = q.status==='pending'?'⏳': q.status==='done'?'✓': q.status==='processing'?'⚙️':'✗';
    return `<div class="pending-item"><span>${s} ${esc(q.original_url.slice(0,54))}</span><small>${esc(q.status)} ${q.error? '· '+esc(q.error.slice(0,40)):''}</small></div>`;
  }).join('');
  if(queue.length>8) $('pending-list').innerHTML += `<small style="color:var(--muted)">+ ${queue.length-8} more</small>`;
}

// --- Tracks ---
async function loadTracks(){
  const { data, error } = await sb.from('tracks').select('*').order('created_at', {ascending:false}).limit(500);
  if(error){
    console.warn('tracks load', error.message);
    if(error.message.includes('does not exist')) $('tracks-list').innerHTML = '<div class="empty">Run <code>supabase-music.sql</code> in Supabase SQL Editor, then queue a URL.</div>';
    return;
  }
  tracks = data||[];
  $('tracks-count').textContent = tracks.length+' tracks';
  renderTracks();
}

function filteredTracks(){
  let t = tracks;
  if(activePlaylistId){
    const ids = new Set(playlistTracks.filter(pt=>pt.playlist_id===activePlaylistId).map(pt=>pt.track_id));
    t = t.filter(x=>ids.has(x.id));
    // order by position
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

function renderTracks(){
  const list = filteredTracks();
  const el=$('tracks-list');
  if(!list.length){ el.innerHTML='<div class="empty">No tracks match. Try clearing search/filter or queue some URLs.</div>'; return; }
  el.innerHTML = list.map(tr=>{
    const isCur = tr.id===curTrackId;
    const art = tr.thumbnail_url ? `<img src="${esc(tr.thumbnail_url)}" loading="lazy" alt="">` : `<div style="width:48px;height:48px;background:#0a0a12;border-radius:6px;display:grid;place-items:center">♪</div>`;
    return `<div class="track ${isCur?'playing':''}" data-id="${esc(tr.id)}">
      ${art}
      <div style="min-width:0">
        <div class="t-title">${esc(tr.title)}</div>
        <div class="t-sub">${esc(tr.artist||tr.extractor||'') } · ${esc(tr.extractor||'')} · ${tr.duration_sec? fmtTime(tr.duration_sec):''} · ${(tr.file_size/1024/1024).toFixed(1)}MB</div>
      </div>
      <div class="t-actions">
        <button class="mini play-mini">${isCur && isPlaying?'⏸':'▶'}</button>
        <select class="mini add-pl" data-id="${esc(tr.id)}" style="max-width:110px">
          <option value="">+ Playlist</option>
          ${playlists.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.track').forEach(node=>{
    node.addEventListener('click', e=>{
      if(e.target.closest('select')) return;
      playTrack(node.dataset.id);
    });
  });
  el.querySelectorAll('.add-pl').forEach(sel=>{
    sel.addEventListener('change', async e=>{
      const tid = e.target.dataset.id;
      const pid = e.target.value;
      if(!pid) return;
      await addToPlaylist(pid, tid);
      e.target.value='';
    });
  });
}

// --- Playlists ---
async function loadPlaylists(){
  const { data, error } = await sb.from('playlists').select('*').order('created_at');
  if(error){ console.warn('playlists', error.message); return; }
  playlists=data||[];
  // load all playlist_tracks for current active or all for filtering
  const { data: pts } = await sb.from('playlist_tracks').select('*').order('position');
  playlistTracks = pts||[];
  renderPlaylists();
  renderTracks();
}
function renderPlaylists(){
  const el=$('playlists-list');
  if(!playlists.length){ el.innerHTML='<small style="color:var(--muted)">No playlists yet</small>'; return; }
  el.innerHTML = playlists.map(p=>{
    const count = playlistTracks.filter(pt=>pt.playlist_id===p.id).length;
    return `<div class="playlist-item ${activePlaylistId===p.id?'active':''}" data-id="${esc(p.id)}">
      <span>▶ ${esc(p.name)} <small>(${count})</small></span>
      <button class="mini del-pl" data-id="${esc(p.id)}" style="background:#1f1f2a;border:1px solid var(--border);padding:4px 8px;border-radius:6px;cursor:pointer">✕</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.playlist-item').forEach(n=> n.addEventListener('click', e=>{
    if(e.target.closest('.del-pl')) return;
    activePlaylistId = n.dataset.id;
    $('list-title').textContent = playlists.find(p=>p.id===activePlaylistId)?.name || 'Playlist';
    renderPlaylists(); renderTracks();
  }));
  el.querySelectorAll('.del-pl').forEach(b=> b.addEventListener('click', async e=>{
    e.stopPropagation();
    const id=b.dataset.id;
    if(!confirm('Delete playlist?')) return;
    await sb.from('playlists').delete().eq('id', id);
    if(activePlaylistId===id){ activePlaylistId=null; $('list-title').textContent='All tracks'; }
    await loadPlaylists();
  }));
}
$('create-playlist-btn').addEventListener('click', async()=>{
  const name=$('new-playlist-name').value.trim();
  if(!name) return toast('Enter name');
  const { error } = await sb.from('playlists').insert({name});
  if(error) toast(error.message); else { $('new-playlist-name').value=''; await loadPlaylists(); toast('Playlist created');}
});
async function addToPlaylist(pid, tid){
  const maxPos = Math.max(0, ...playlistTracks.filter(pt=>pt.playlist_id===pid).map(pt=>pt.position));
  const { error } = await sb.from('playlist_tracks').insert({playlist_id:pid, track_id:tid, position: maxPos+1});
  if(error) {
    if(error.message.includes('duplicate')) toast('Already in playlist');
    else toast(error.message);
  } else { toast('Added to playlist'); await loadPlaylists(); }
}

// --- Player ---
const audio = $('player');
function buildQueueFromCurrent(startId){
  const list = filteredTracks();
  const idx = list.findIndex(t=>t.id===startId);
  queuePos = idx>=0? idx:0;
  // queue is the filtered list
  window._playQueue = list;
}
function playTrack(id){
  const tr = tracks.find(t=>t.id===id);
  if(!tr) return;
  curTrackId=id;
  buildQueueFromCurrent(id);
  const url = publicUrl(tr.storage_path);
  audio.src = url;
  audio.play().catch(()=>{});
  isPlaying=true;
  updatePlayerUI(tr);
  renderTracks();
  if('mediaSession' in navigator){
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tr.title, artist: tr.artist||tr.extractor||'', artwork: tr.thumbnail_url?[{src: tr.thumbnail_url}]:[]
    });
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('previoustrack', prev);
  }
}
function updatePlayerUI(tr){
  $('player-title').textContent = tr.title;
  $('player-artist').textContent = tr.artist||tr.extractor||'';
  const art=$('player-art'); if(tr.thumbnail_url){ art.src=tr.thumbnail_url; art.style.display=''; } else art.style.display='none';
  $('play-btn').textContent = isPlaying?'⏸':'▶';
}
function next(){
  const q = window._playQueue || filteredTracks();
  if(!q.length) return;
  queuePos = (queuePos+1) % q.length;
  if(queuePos===0 && !repeat) { /* optionally stop */ }
  playTrack(q[queuePos].id);
}
function prev(){
  const q = window._playQueue || filteredTracks();
  if(!q.length) return;
  queuePos = (queuePos-1+q.length)%q.length;
  playTrack(q[queuePos].id);
}
$('play-btn').addEventListener('click', ()=>{ if(!curTrackId){ const f=filteredTracks(); if(f[0]) playTrack(f[0].id); return; } if(audio.paused){ audio.play(); isPlaying=true; } else { audio.pause(); isPlaying=false; } $('play-btn').textContent=isPlaying?'⏸':'▶'; });
$('next-btn').addEventListener('click', next);
$('prev-btn').addEventListener('click', prev);
$('repeat-btn').addEventListener('click', ()=>{ repeat=!repeat; $('repeat-btn').classList.toggle('active', repeat); toast(repeat?'Repeat on':'Repeat off'); });
audio.addEventListener('ended', ()=>{ if(repeat) audio.play(); else next(); });
audio.addEventListener('play', ()=>{ isPlaying=true; $('play-btn').textContent='⏸'; });
audio.addEventListener('pause', ()=>{ isPlaying=false; $('play-btn').textContent='▶'; });
audio.addEventListener('timeupdate', ()=>{
  if(!isFinite(audio.duration)) return;
  $('cur-time').textContent = fmtTime(audio.currentTime);
  $('dur-time').textContent = fmtTime(audio.duration);
  $('seek').value = Math.round(audio.currentTime/audio.duration*1000);
});
$('seek').addEventListener('input', ()=>{ if(isFinite(audio.duration)) audio.currentTime = $('seek').value/1000*audio.duration; });
$('vol').addEventListener('input', ()=> audio.volume=$('vol').value);
audio.volume=0.9;
$('shuffle-btn').addEventListener('click', ()=>{
  const f=filteredTracks(); for(let i=f.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [f[i],f[j]]=[f[j],f[i]]; }
  window._playQueue=f; queuePos=-1; next(); toast('Shuffled');
});
$('play-all-btn').addEventListener('click', ()=>{ const f=filteredTracks(); if(f[0]) playTrack(f[0].id); });
$('cache-btn').addEventListener('click', async()=>{
  if(!curTrackId) return toast('Play a track first');
  const tr=tracks.find(t=>t.id===curTrackId);
  const url=publicUrl(tr.storage_path);
  try{
    const c=await caches.open('tracks-v1');
    toast('Caching for offline...');
    await c.add(url);
    toast('Cached offline ✓');
  }catch(e){ toast('Cache failed: '+e.message); }
});
// search/filter
$('search').addEventListener('input', ()=>{ searchQ=$('search').value; renderTracks(); });
document.querySelectorAll('.chip').forEach(c=> c.addEventListener('click', ()=>{ document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); filter=c.dataset.filter; renderTracks(); }));
$('refresh-btn').addEventListener('click', async()=>{ await Promise.all([loadTracks(), loadQueue(), loadPlaylists()]); toast('Refreshed'); });

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
setInterval(()=>{ loadQueue(); }, 15000);

// SW
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
