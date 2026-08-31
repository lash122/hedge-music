#!/usr/bin/env node
/**
 * Laptop Ingest Server - yt-dlp -x --audio-format mp3 -> Supabase
 * Parallel, work-stealing, retries with backoff. Supports ANY yt-dlp site.
 * Usage: node ingest.js --once   (process pending queue once)
 *        node ingest.js --watch  (poll every 10s, 3 concurrent workers)
 *        node ingest.js --check  (check deps only)
 */
import { createClient } from '@supabase/supabase-js';
// ws only needed if supabase realtime used in Node; not used in ingest -> safe to keep but optional
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, unlinkSync, readdirSync, mkdirSync, createReadStream } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pipeline } from 'node:stream/promises';
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
const CONCURRENCY = Math.max(1, parseInt(process.env.INGEST_CONCURRENCY || '3', 10));
const BATCH_LIMIT = parseInt(process.env.INGEST_BATCH_LIMIT || '20', 10);
const MAX_ATTEMPTS = parseInt(process.env.INGEST_MAX_ATTEMPTS || '5', 10);
const SPAWN_TIMEOUT_MS = parseInt(process.env.INGEST_SPAWN_TIMEOUT_MS || '300000', 10); // 5 min per yt-dlp
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const ONCE = args.includes('--once');
const CHECK = args.includes('--check');
const DRY = args.includes('--dry-run');

const WORKER_ID = `${hostname()}-${process.pid}`;
const localTmp = join(__dirname, 'tmp');
try { mkdirSync(localTmp, { recursive: true }); } catch {}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function err(msg) { console.error(`[ERR] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Hand-rolled semaphore (no p-limit dep) ---
function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      return new Promise(resolve => {
        if (active < max) { active++; resolve(); return; }
        waiters.push(() => { active++; resolve(); });
      });
    },
    release() {
      if (active > 0) active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    if (url.hostname === 'youtu.be') {
      url.hostname = 'www.youtube.com';
      const id = url.pathname.replace('/', '');
      url.pathname = '/watch';
      url.searchParams.set('v', id);
    }
    ['t', 'si', 'st', 'utm_source', 'utm_medium', 'utm_campaign'].forEach(p => url.searchParams.delete(p));
    url.searchParams.sort();
    return url.toString();
  } catch { return u; }
}

// --- Subprocess with timeout ---
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout || SPAWN_TIMEOUT_MS;
    const p = spawn(cmd, cmdArgs, { ...opts, detached: false });
    let out = '', errout = '';
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      try { process.kill(p.pid, 'SIGKILL'); } catch {}
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs/1000)}s`));
    }, timeoutMs);
    p.stdout?.on('data', d => out += d);
    p.stderr?.on('data', d => errout += d);
    p.on('close', code => {
      clearTimeout(t);
      if (killed) return;
      code === 0 ? resolve({ out, errout }) : reject(new Error(`${cmd} exit ${code}: ${errout.slice(0, 800)}`));
    });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

function isRetryable(e) {
  const msg = String(e.message || '').toLowerCase();
  return /429|503|timeout|timed out|econnreset|etimedout|unavailable|temporarily|try again|sign in/i.test(msg);
}

async function withRetry(fn, { retries = 3, baseMs = 2000 } = {}) {
  let lastErr;
  for (let a = 0; a <= retries; a++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (a === retries || !isRetryable(e)) throw e;
      const jitter = Math.random() * 800;
      await sleep(baseMs * Math.pow(2, a) + jitter);
    }
  }
  throw lastErr;
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
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { error } = await sb.from('tracks').select('id').limit(1);
  if (error && !error.message.includes('does not exist')) err(`Supabase ping failed: ${error.message}`);
  else log(`Supabase ${SUPABASE_URL} ✓`);
  log(`Worker ${WORKER_ID} — concurrency ${CONCURRENCY}, batch ${BATCH_LIMIT}, attempts ${MAX_ATTEMPTS}.`);
  log('All checks pass.');
}

async function getMetadata(url) {
  const a = ['--print-json', '--no-download', '--no-warnings', '--no-playlist', '--socket-timeout', '15', '--retries', '3'];
  if (COOKIES && existsSync(COOKIES)) a.push('--cookies', COOKIES);
  a.push(url);
  const { out } = await withRetry(() => run(YT_DLP, a), { retries: 2, baseMs: 1500 });
  const firstLine = out.trim().split('\n')[0];
  if (!firstLine) throw new Error('yt-dlp returned empty metadata (possibly rate-limited)');
  return JSON.parse(firstLine);
}

async function downloadMp3(url, outTemplate) {
  const a = ['-x', '--audio-format', 'mp3', '--audio-quality', QUALITY, '--no-playlist', '--restrict-filenames', '--no-warnings', '--socket-timeout', '15', '--retries', '3', '--fragment-retries', '3'];
  if (COOKIES && existsSync(COOKIES)) a.push('--cookies', COOKIES);
  a.push('-o', outTemplate, url);
  await withRetry(() => run(YT_DLP, a), { retries: 2, baseMs: 3000 });
}

// Cleanup tmp files: by explicit path and sweep old ones (>1h) so they don't accumulate
function cleanupTmp(exceptPath) {
  try {
    for (const f of readdirSync(localTmp).filter(x => x.startsWith('hedge3-'))) {
      const p = join(localTmp, f);
      try {
        if (p === exceptPath) continue;
        if (Date.now() - statSync(p).mtimeMs > 3600000) unlinkSync(p);
      } catch {}
    }
  } catch {}
}

async function processOne(sb, job) {
  const idShort = job.id.slice(0, 8);
  const canon = job.canonical_url || canonicalUrl(job.original_url);
  log(`[${idShort}] claimed by ${WORKER_ID} ← ${canon}`);
  // If another engine claimed it before we got job list, ignore
  try {
    // 1. Metadata
    const meta = await getMetadata(canonicalUrl(job.original_url) || job.original_url);
    const extractor = meta.extractor || job.extractor || 'unknown';
    const extractorId = String(meta.id || meta.display_id || job.id);
    const title = (meta.title || meta.track || meta.fulltitle || 'Unknown').slice(0, 200);
    const artist = (meta.artist || meta.uploader || meta.channel || meta.creator || '').slice(0, 120);
    const thumb = meta.thumbnail || meta.thumbnails?.at(-1)?.url || null;
    const duration = Math.round(meta.duration || 0) || null;

    // dedup check
    const { data: dup } = await sb.from('tracks').select('id').eq('original_url', job.original_url).maybeSingle();
    if (dup) { log(`  ↳ duplicate by url, marking done (track ${dup.id})`); await sb.from('ingest_queue').update({ status: 'done', extractor, extractor_id: extractorId, error: null }).eq('id', job.id); return; }
    const { data: dup2 } = await sb.from('tracks').select('id').eq('extractor_id', extractorId).eq('extractor', extractor).maybeSingle();
    if (dup2) { log(`  ↳ duplicate extractor_id, marking done`); await sb.from('ingest_queue').update({ status: 'done', extractor, extractor_id: extractorId, error: null }).eq('id', job.id); return; }

    // 2. Download
    const safeExtractor = String(extractor).replace(/[^a-z0-9]/gi, '_').slice(0, 30) || 'unknown';
    const safeId = extractorId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpBase = join(localTmp, `hedge3-${safeExtractor}-${safeId}-${job.id.slice(0, 8)}`);
    const template = `${tmpBase}.%(ext)s`;
    log(`  ↳ downloading yt-dlp -x --audio-format mp3 --audio-quality ${QUALITY} ...`);
    if (!DRY) await downloadMp3(job.original_url, template);

    // find produced mp3
    let mp3Path = `${tmpBase}.mp3`;
    if (!existsSync(mp3Path)) {
      const candidates = readdirSync(localTmp).filter(f => f.startsWith(`hedge3-${safeExtractor}-${safeId}-`) && f.endsWith('.mp3')).map(f => join(localTmp, f));
      candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates[0] && Date.now() - statSync(candidates[0]).mtimeMs < 60000) mp3Path = candidates[0];
      else throw new Error(`MP3 not found at ${tmpBase}.mp3 after yt-dlp`);
    }
    const st = statSync(mp3Path);
    const size = st.size;
    if (size > MAX_FILE_BYTES) throw new Error(`File too large ${(size / 1024 / 1024).toFixed(1)}MB >100MB`);
    log(`  ↳ ${(size / 1024 / 1024).toFixed(2)} MB, uploading to tracks bucket...`);

    // 3. Streaming upload
    const storagePath = `${safeExtractor}-${safeId}.mp3`;
    if (!DRY) {
      const stream = createReadStream(mp3Path);
      const { error: upErr } = await sb.storage.from('tracks').upload(storagePath, stream, { contentType: 'audio/mpeg', upsert: false, duplex: 'half' });
      if (upErr) {
        if (upErr.message.includes('already exists') || upErr.message.includes('duplicate') || upErr.statusCode === '409' || upErr.status === 409) log('  ↳ storage already exists, ok');
        else throw new Error(`Storage upload: ${upErr.message}`);
      }
    }
    try { unlinkSync(mp3Path); } catch {}
    cleanupTmp();

    // 4. Insert track row
    const trackPayload = {
      original_url: job.original_url,
      canonical_url: canon,
      extractor,
      extractor_id: extractorId,
      title,
      artist,
      thumbnail_url: thumb,
      storage_path: storagePath,
      duration_sec: duration,
      file_size: size,
    };
    if (job.owner_id) trackPayload.owner_id = job.owner_id;
    const { error: insErr } = await sb.from('tracks').insert(trackPayload);
    if (insErr) {
      if (insErr.message.includes('duplicate') || insErr.code === '23505') log('  ↳ already in tracks, ok');
      else throw new Error(`DB insert: ${insErr.message}`);
    }

    await sb.from('ingest_queue').update({ status: 'done', extractor, extractor_id: extractorId, error: null, claimed_at: null, claimed_by: null, next_retry_at: null }).eq('id', job.id);
    log(`  ✓ done → ${title} - ${artist} [${extractor}]`);
  } catch (e) {
    const attempts = (job.attempts || 0) + 1;
    const retryable = isRetryable(e);
    err(`  ✗ attempt ${attempts}/${MAX_ATTEMPTS} failed: ${e.message.slice(0, 120)}`);
    if (retryable && attempts < MAX_ATTEMPTS) {
      const backoffSec = Math.min(3600, 30 * Math.pow(2, attempts));
      const next = new Date(Date.now() + backoffSec * 1000).toISOString();
      await sb.from('ingest_queue').update({ status: 'pending', error: String(e.message).slice(0, 500), attempts, next_retry_at: next, claimed_at: null, claimed_by: null }).eq('id', job.id);
      log(`  ↳ retry in ${Math.round(backoffSec)}s`);
    } else {
      await sb.from('ingest_queue').update({ status: 'error', error: String(e.message).slice(0, 500), claimed_at: null, claimed_by: null }).eq('id', job.id);
      err(`  ✗ marked error (not retryable / max attempts)`);
    }
    cleanupTmp();
  }
}

let processingBatch = false;
async function processQueue() {
  if (processingBatch) { log('Still processing previous tick, skipping'); return; }
  processingBatch = true;
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    // reap stale claims from crashed workers
    try { await sb.rpc('reap_stale_claims', { p_timeout: '15 minutes' }); } catch (e) { /* function may not exist yet, ignore */ }
    // atomic multi-claim
    const { data: jobs, error } = await sb.rpc('claim_queue_jobs', { p_limit: BATCH_LIMIT, p_worker: WORKER_ID });
    if (error) {
      // fallback: if RPC missing (migration not run), use old sequential claim so we don't break
      if (error.message.includes('function') || error.message.includes('does not exist')) {
        log('claim_queue_jobs RPC missing — run supabase-ingest-parallel.sql in SQL Editor');
        const { data: legacy, error: lerr } = await sb.from('ingest_queue').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(BATCH_LIMIT);
        if (lerr) { err(`Queue fetch: ${lerr.message}`); return; }
        if (!legacy?.length) { log('No pending jobs.'); return; }
        // process serially via old path for compatibility
        for (const job of legacy) {
          const { data: claimed } = await sb.from('ingest_queue').update({ status: 'processing', attempts: (job.attempts||0)+1, claimed_at: new Date().toISOString(), claimed_by: WORKER_ID }).eq('id', job.id).eq('status','pending').select('id').maybeSingle();
          if (claimed) await processOne(sb, job);
        }
        return;
      }
      err(`Queue claim: ${error.message}`); return;
    }
    if (!jobs?.length) { log('No pending jobs. Queue more URLs in PWA.'); return; }
    log(`Found ${jobs.length} job(s), processing with ${CONCURRENCY} concurrent workers...`);
    const semaphore = createSemaphore(CONCURRENCY);
    await Promise.all(jobs.map(job => semaphore.acquire().then(() => processOne(sb, job).finally(() => semaphore.release()))));
    log('\nBatch complete. PWA will auto-refresh via realtime.');
  } finally {
    processingBatch = false;
  }
}

async function main() {
  if (CHECK) { await checkDeps(); return; }
  await checkDeps();
  if (WATCH) {
    log(`Watching every ${POLL_MS/1000}s. Paste URLs in PWA, they will be batch-processed collectively. Ctrl+C to stop.`);
    process.on('SIGINT', async () => { log('Shutting down gracefully...'); process.exit(0); });
    process.on('SIGTERM', async () => { log('SIGTERM, exiting.'); process.exit(0); });
    await processQueue();
    setInterval(processQueue, POLL_MS);
  } else {
    await processQueue();
  }
}

main().catch(e => { err(e.stack || e.message); process.exit(1); });
