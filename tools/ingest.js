#!/usr/bin/env node
/**
 * Laptop Ingest Server - yt-dlp -x --audio-format mp3 -> Supabase
 * Batch/collective, on-demand. Supports ANY yt-dlp site (YouTube, SoundCloud, Bandcamp, etc)
 * Usage: node ingest.js --once   (process pending queue once)
 *        node ingest.js --watch  (poll every 10s)
 *        node ingest.js --check  (check deps only)
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
globalThis.WebSocket = ws;
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env if present
try {
  const envPath = new URL('./.env', import.meta.url).pathname;
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const COOKIES = process.env.COOKIES_FILE;
const QUALITY = process.env.AUDIO_QUALITY || '0';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const ONCE = args.includes('--once');
const CHECK = args.includes('--check');

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { ...opts });
    let out = '', errout = '';
    p.stdout?.on('data', d => out += d);
    p.stderr?.on('data', d => errout += d);
    p.on('close', code => code === 0 ? resolve({ out, errout }) : reject(new Error(`${cmd} exit ${code}: ${errout.slice(0, 800)}`)));
    p.on('error', reject);
  });
}

async function checkDeps() {
  log('Checking dependencies...');
  try { const { out } = await run(YT_DLP, ['--version']); log(`yt-dlp ${out.trim()} ✓`); }
  catch (e) { err(`yt-dlp not found at "${YT_DLP}". Install: pip install yt-dlp or brew install yt-dlp. ${e.message}`); process.exit(1); }
  try { const { errout, out } = await run(FFMPEG, ['-version']); log(`ffmpeg ${(out||errout).split('\n')[0].slice(0,60)} ✓`); }
  catch (e) { err(`ffmpeg not found at "${FFMPEG}". Install: brew install ffmpeg / apt install ffmpeg. ${e.message}`); process.exit(1); }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    err('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in tools/.env (copy from tools/.env.example)');
    process.exit(1);
  }
  // quick supabase ping
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { error } = await sb.from('tracks').select('id').limit(1);
  if (error && !error.message.includes('does not exist')) err(`Supabase ping failed: ${error.message}`);
  else log(`Supabase ${SUPABASE_URL} ✓`);
  log('All checks pass.');
}

async function getMetadata(url) {
  const a = ['--print-json', '--no-download', '--no-warnings', '--no-playlist'];
  if (COOKIES && existsSync(COOKIES)) a.push('--cookies', COOKIES);
  a.push(url);
  const { out } = await run(YT_DLP, a);
  // yt-dlp prints one JSON per video (even for playlists with --no-playlist it's one)
  const firstLine = out.trim().split('\n')[0];
  return JSON.parse(firstLine);
}

async function downloadMp3(url, outTemplate) {
  const a = ['-x', '--audio-format', 'mp3', '--audio-quality', QUALITY, '--no-playlist', '--restrict-filenames', '--no-warnings'];
  if (COOKIES && existsSync(COOKIES)) a.push('--cookies', COOKIES);
  a.push('-o', outTemplate, url);
  await run(YT_DLP, a);
}

let isProcessing=false;
async function processQueue() {
  if(isProcessing) { log('Already processing, skipping overlapping tick'); return; }
  isProcessing=true;
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: pending, error } = await sb.from('ingest_queue').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(20);
  if (error) { err(`Queue fetch: ${error.message}`); isProcessing=false; return; }
  if (!pending?.length) { log('No pending jobs. Queue more URLs in PWA.'); isProcessing=false; return; }
  log(`Found ${pending.length} pending job(s) — processing collectively...`);

  for (const job of pending) {
    const idShort = job.id.slice(0, 8);
    log(`\n[${idShort}] ${job.original_url}`);
    try {
      // atomic claim: only process if still pending (prevents double-download with concurrent workers)
      const { data: claimed, error: claimErr } = await sb.from('ingest_queue').update({ status: 'processing' }).eq('id', job.id).eq('status','pending').select('id').maybeSingle();
      if(claimErr || !claimed){ log(`  ↳ already claimed by another worker, skipping`); continue; }

      // 1. Metadata (supports any site)
      const meta = await getMetadata(job.original_url);
      const extractor = meta.extractor || job.extractor || 'unknown';
      const extractorId = String(meta.id || meta.display_id || job.id);
      const title = (meta.title || meta.track || meta.fulltitle || 'Unknown').slice(0, 200);
      const artist = (meta.artist || meta.uploader || meta.channel || meta.creator || '').slice(0, 120);
      const thumb = meta.thumbnail || meta.thumbnails?.at(-1)?.url || null;
      const duration = Math.round(meta.duration || 0) || null;

      // dedup check
      const { data: dup } = await sb.from('tracks').select('id').eq('original_url', job.original_url).maybeSingle();
      if (dup) { log(`  ↳ duplicate, marking done (track ${dup.id})`); await sb.from('ingest_queue').update({ status: 'done', extractor, extractor_id: extractorId }).eq('id', job.id); continue; }
      const { data: dup2 } = await sb.from('tracks').select('id').eq('extractor_id', extractorId).eq('extractor', extractor).maybeSingle();
      if (dup2) { log(`  ↳ duplicate extractor_id, marking done`); await sb.from('ingest_queue').update({ status: 'done', extractor, extractor_id: extractorId }).eq('id', job.id); continue; }

      // 2. Download - use local tmp to avoid /tmp cleanup issues
      const localTmp = join(__dirname, 'tmp');
      try { mkdirSync(localTmp, { recursive: true }); } catch {}
      const safeExtractor = extractor.replace(/[^a-z0-9]/gi,'_').slice(0,30) || 'unknown';
      const safeId = extractorId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const tmpBase = join(localTmp, `hedge3-${safeExtractor}-${safeId}`);
      const template = `${tmpBase}.%(ext)s`;
      log(`  ↳ downloading yt-dlp -x --audio-format mp3 --audio-quality ${QUALITY} ...`);
      await downloadMp3(job.original_url, template);

      // find produced mp3 (yt-dlp adds .mp3, may sanitize)
      let mp3Path = `${tmpBase}.mp3`;
      if (!existsSync(mp3Path)) {
        // fallback search localTmp for recent hedge3-*.mp3
        const candidates = readdirSync(localTmp).filter(f => f.startsWith('hedge3-') && f.endsWith('.mp3')).map(f => join(localTmp, f));
        candidates.sort((a,b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (candidates[0] && Date.now() - statSync(candidates[0]).mtimeMs < 60000) mp3Path = candidates[0];
        else if (existsSync(join(tmpdir(), `hedge3-${safeId}.mp3`))) mp3Path = join(tmpdir(), `hedge3-${safeId}.mp3`);
        else throw new Error(`MP3 not found at ${tmpBase}.mp3 after yt-dlp`);
      }
      const buf = await readFile(mp3Path);
      const size = buf.length;
      log(`  ↳ ${ (size/1024/1024).toFixed(2)} MB, uploading to tracks bucket...`);

      // 3. Upload to Supabase Storage - global shared (flat name), private bucket + signed URLs
      if(size > 100*1024*1024) throw new Error(`File too large ${ (size/1024/1024).toFixed(1)}MB >100MB`);
      const safeStorageName = `${safeExtractor}-${safeId}.mp3`;
      const storagePath = safeStorageName;
      const { error: upErr } = await sb.storage.from('tracks').upload(storagePath, buf, { contentType: 'audio/mpeg', upsert: false });
      if (upErr) {
        if(upErr.message.includes('already exists') || upErr.message.includes('duplicate') || upErr.statusCode==='409') log(`  ↳ storage already exists, ok`);
        else throw new Error(`Storage upload: ${upErr.message}`);
      }
      // cleanup local tmp in both success and error paths
      try { unlinkSync(mp3Path); } catch {}
      // also clean any leftover tmp older than 1h
      try {
        for(const f of readdirSync(localTmp).filter(x=>x.startsWith('hedge3-'))){
          const p=join(localTmp,f);
          if(Date.now()-statSync(p).mtimeMs > 3600000) try{unlinkSync(p)}catch{}
        }
      } catch {}

      // 4. Insert track row - global public, owner_id for attribution (hybrid)
      const trackPayload = {
        original_url: job.original_url,
        extractor,
        extractor_id: extractorId,
        title,
        artist,
        thumbnail_url: thumb,
        storage_path: storagePath,
        duration_sec: duration,
        file_size: size,
      };
      if(job.owner_id) trackPayload.owner_id = job.owner_id;
      const { error: insErr } = await sb.from('tracks').insert(trackPayload);
      if (insErr) {
        if (insErr.message.includes('duplicate') || insErr.code === '23505') log(`  ↳ already in tracks, ok`);
        else throw new Error(`DB insert: ${insErr.message}`);
      }

      await sb.from('ingest_queue').update({ status: 'done', extractor, extractor_id: extractorId, error: null }).eq('id', job.id);
      log(`  ✓ done -> ${title} - ${artist} [${extractor}]`);

    } catch (e) {
      // cleanup local file on error too
      try { if(typeof mp3Path!=='undefined' && existsSync(mp3Path)) try{unlinkSync(mp3Path)}catch{} } catch {}
      err(`  ✗ failed: ${e.message}`);
      await sb.from('ingest_queue').update({ status: 'error', error: String(e.message).slice(0, 500) }).eq('id', job.id);
    }
  }
  isProcessing=false;
  log('\nBatch complete. PWA will auto-refresh via realtime.');
}

async function main() {
  if (CHECK) { await checkDeps(); return; }
  await checkDeps();
  if (WATCH) {
    log(`Watching every ${POLL_MS/1000}s. Paste URLs in PWA, they will be batch-processed collectively. Ctrl+C to stop.`);
    await processQueue();
    setInterval(processQueue, POLL_MS);
  } else {
    // default: process once (also for --once)
    await processQueue();
  }
}

main().catch(e => { err(e.stack||e.message); process.exit(1); });
