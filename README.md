# Hedge Music — yt-dlp → Supabase PWA (Laptop as Server)

Separate untracked app next to `hedge3` Wonderland. **Out of git history** as requested.

## What it does

- **Phone PWA** (`music.html`): paste *any* `yt-dlp` URL (YouTube, SoundCloud, Bandcamp, Vimeo, TikTok... ~1800 sites). Queues as `pending` in `ingest_queue`. Play/search/playlist/shuffle/repeat/offline-cache from Supabase `tracks` bucket. All features work without laptop.
- **Laptop** (`tools/ingest.js`): when you run `node tools/ingest.js --watch`, it batch-processes all pending collectively: `yt-dlp -x --audio-format mp3 --audio-quality 0` + `ffmpeg` → uploads MP3 to `tracks` bucket → inserts `tracks` row. Then PWA auto-refreshes via Realtime.

Free Supabase holds **~200 songs @192k (1GB)** or **~285 @128k**. See `supabase-setup.sql` header.

## Folder (untracked, outside git repo `/home/saof/Desktop/Hedge3/hedge3`)

```
/home/saof/Desktop/Hedge3/hedge3-music/
  music.html (app), index.html (redirect stub), admin.html, music.js, music.css, manifest.json, sw.js, icons/
  supabase-setup.sql   ← canonical backend setup (old supabase-*.sql files kept for history)
  tools/ ingest.js, package.json, .env.example, README.md, ingest.bat/sh
```

Repo `hedge3` untouched. This folder is sibling to `hedge3`, so `git -C hedge3 status` stays clean.

## Quick Start

### 1. Supabase (once, 1 min)

Supabase Dashboard → SQL Editor → paste `supabase-setup.sql` → Run. Creates `tracks`, `ingest_queue`, `playlists`, `playlist_tracks`, `track_events`, approval tables, bucket `tracks` (private, approved-read).

### 2. Laptop ingest

```bash
cd /home/saof/Desktop/Hedge3/hedge3-music/tools
npm install
cp .env.example .env   # fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from Dashboard -> Project Settings -> API)
node ingest.js --check # should show yt-dlp ✓ ffmpeg ✓ Supabase ✓
# then leave running when you want to ingest:
node ingest.js --watch
# or one-shot:
node ingest.js --once
```

Prereqs: `yt-dlp` + `ffmpeg` in PATH (`pip install yt-dlp`, `brew install ffmpeg`).

### 3. PWA

Serve `hedge3-music` as static:

```bash
# any static server
npx serve /home/saof/Desktop/Hedge3/hedge3-music
# or python
python -m http.server 8000 --directory /home/saof/Desktop/Hedge3/hedge3-music
# open http://localhost:8000/music.html
```

Add to home screen for standalone PWA.

## How Laptop-Server Collective Mode Works

1. Laptop OFF → you paste 1..20 URLs in PWA → they sit `pending` → PWA shows `⏳ 3 queued`
2. Laptop ON → `node tools/ingest.js --watch` → poll `pending` → loop `yt-dlp -x ...` + upload collectively
3. PWA subscribes `supabase.channel('music-changes')` → list updates live, no reload

## Playlists & Player

- Create playlist, add track via dropdown, click playlist to filter, play-all/shuffle.
- Player has seek, volume, repeat, next/prev, MediaSession (lock screen), offline cache button (uses `tracks-v1` Cache API via `sw.js`).

## Verify Out-of-Git

```bash
git -C /home/saof/Desktop/Hedge3/hedge3 status --short  # should be clean
ls /home/saof/Desktop/Hedge3/hedge3-music  # exists outside repo
```
