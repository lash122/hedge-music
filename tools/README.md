# Laptop Ingest Server

`yt-dlp -x --audio-format mp3` → Supabase `tracks` bucket. **Collective/batch, on-demand**: PWA queues URLs when laptop is off, you run this script later and all pending are processed at once.

## Prereqs

```bash
# yt-dlp + ffmpeg must be in PATH
pip install yt-dlp        # or brew install yt-dlp
brew install ffmpeg       # or apt install ffmpeg / choco install ffmpeg
node -v  # >=18

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
# Or reuse SUPABASE_URL from hedge3/app.js, get service_role from dashboard.

# run SQL first: in Supabase SQL Editor, paste ../supabase-music.sql
```

## Usage

```bash
# check deps + Supabase connectivity
node ingest.js --check

# process all pending queue once (collectively)
node ingest.js --once
# or
node ingest.js

# watch mode: poll every 10s, leave running while you queue from phone
node ingest.js --watch

# Windows double-click:
# use ingest.bat
```

## Flow

1. Phone PWA: paste any `yt-dlp` URL (YouTube, SoundCloud, Bandcamp, etc) -> `ingest_queue` status='pending'
2. Laptop: `node ingest.js --watch` -> finds `pending` rows -> for each:
   - `yt-dlp --print-json --no-download <url>` -> metadata (supports any site)
   - `yt-dlp -x --audio-format mp3 --audio-quality 0 -o /tmp/<id>.%(ext)s <url>`
   - `supabase.storage.from('tracks').upload('<id>.mp3', buffer, {upsert:true})`
   - `insert into tracks (...)` + `update ingest_queue status='done'`
3. Phone PWA auto-refreshes via `supabase.channel('tracks-changes')` (like hedge3/app.js realtime).

## Tuning

- `AUDIO_QUALITY=0` best 320k (~120 songs/GB free), `9` smallest 128k (~285 songs/GB)
- `POLL_INTERVAL_MS=10000`
- Private tracks: put cookies via `yt-dlp --cookies-from-browser chrome` export to `tools/cookies.txt` and set `COOKIES_FILE=./cookies.txt` in .env

## Troubleshooting

- `yt-dlp not found` -> fix PATH, try `YT_DLP_PATH=/usr/local/bin/yt-dlp` in .env
- `Supabase ping failed: relation does not exist` -> run `supabase-music.sql` first
- MP3 not found -> check `/tmp/hedge3-*.mp3` exists, ffmpeg installed?
- Storage upload error -> check `tracks` bucket is public and service_role key correct
