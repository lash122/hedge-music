# Laptop Ingest Server

`yt-dlp -x --audio-format mp3` → Supabase `tracks` bucket. **Collective/batch, on-demand**: PWA queues URLs when laptop is off, you run this script later and all pending are processed at once.

## Prereqs

```bash
# yt-dlp + ffmpeg must be in PATH
pip install yt-dlp        # or brew install yt-dlp
brew install ffmpeg       # or apt install ffmpeg / choco install ffmpeg
node -v  # >=18 (see "engines" in package.json)

yt-dlp --version
ffmpeg -version
```

## Setup (once)

```bash
cd /home/saof/Desktop/Hedge3/hedge3-music/tools
npm install
cp .env.example .env
# edit .env -> fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
# find in Supabase Dashboard -> Project Settings -> API -> service_role (keep secret! never commit .env)

# run SQL first: in Supabase SQL Editor, paste ../supabase-setup.sql (canonical, idempotent)
```

## Usage

```bash
# check deps + Supabase connectivity (hard-fails when schema is missing)
node ingest.js --check

# process all pending queue once (collectively)
node ingest.js --once
# or
node ingest.js

# watch mode: poll every 10s, leave running while you queue from phone
node ingest.js --watch

# dry run: fetch metadata only, upload/insert nothing, leave jobs pending
node ingest.js --once --dry-run
# or: npm run dry

# Windows double-click:
# use ingest.bat
```

## Flow

1. Phone PWA: paste any `yt-dlp` URL (YouTube, SoundCloud, Bandcamp, etc) -> `ingest_queue` status='pending'
2. Laptop: `node ingest.js --watch` -> `claim_queue_jobs()` RPC atomically claims a batch (`FOR UPDATE SKIP LOCKED`) -> for each (up to `INGEST_CONCURRENCY` in parallel):
   - `yt-dlp --print-json --no-download <canonical-url>` -> metadata (supports any site)
   - dedup vs `tracks` by `original_url`, then `extractor+extractor_id`, then `canonical_url`
   - `yt-dlp -x --audio-format mp3 --audio-quality 0 -o tools/tmp/hedge3-<extractor>-<id>-<job>.%(ext)s <url>`
   - stream-upload to `tracks` bucket as `<extractor>-<id>.mp3` (`upsert:false`; `tracks` bucket is private)
   - `insert into tracks (...)` incl. `canonical_url` + `owner_id` from the queue row; orphan MP3 removed if the insert fails
   - `update ingest_queue status='done'`
   - on failure: non-retryable errors (private/deleted/age-gated/copyright/unsupported URL) mark `error` immediately; transient ones back off `30*2^n`s up to `INGEST_MAX_ATTEMPTS`
3. Phone PWA auto-refreshes via `supabase.channel('music-changes')` realtime on `tracks` / `ingest_queue` / `playlists`.
4. Attempts are counted once per failed attempt only (the claim itself does not consume one).

## Tuning (`.env`)

- `AUDIO_QUALITY=0` best 320k (~120 songs/GB free), `9` smallest 128k (~285 songs/GB)
- `POLL_INTERVAL_MS=10000`
- `INGEST_CONCURRENCY=3`, `INGEST_BATCH_LIMIT=20`, `INGEST_MAX_ATTEMPTS=5`, `INGEST_SPAWN_TIMEOUT_MS=300000`
- `YT_DLP_PATH` / `FFMPEG_PATH` when binaries aren't in PATH
- Private tracks: export a cookies file (`yt-dlp --cookies-from-browser chrome --cookies tools/cookies.txt <url>`) and set `COOKIES_FILE=./cookies.txt`

## Troubleshooting

- `yt-dlp not found` -> fix PATH, try `YT_DLP_PATH=/usr/local/bin/yt-dlp` in .env
- `Supabase not ready: ...` -> run `../supabase-setup.sql` first
- `MP3 not found` -> check `tools/tmp/hedge3-*.mp3` exists, ffmpeg installed?
- `claim_queue_jobs RPC missing` -> run `../supabase-setup.sql` (old DBs: legacy serial claim is used as fallback)
- Storage upload error -> check `tracks` bucket exists and service_role key correct
