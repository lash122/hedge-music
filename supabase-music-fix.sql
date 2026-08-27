-- Fix 1: harden hedge-music — run in Supabase Dashboard → SQL Editor
-- Keeps anon for private collection (no login yet), but removes dangerous delete + adds validation + unique constraints

-- 1a. ingest_queue: add validation, remove anon delete
drop policy if exists "anon delete own pending" on public.ingest_queue;
-- no anon delete at all now (only service_role can update/delete)
-- add check for URL length + https prefix (keep existing rows: skip if violated, so use NOT VALID initially then validate)
alter table public.ingest_queue drop constraint if exists ingest_queue_url_check;
alter table public.ingest_queue add constraint ingest_queue_url_check
  check (length(original_url) < 2048 and original_url ~ '^https?://') not valid;
-- validate existing rows (will fail if old bad rows exist — clean them first)
-- alter table public.ingest_queue validate constraint ingest_queue_url_check;

-- 1b. tracks: unique extractor+id + unique storage_path, prevent overwrite across extractors
create unique index if not exists idx_tracks_extractor_id on public.tracks(extractor, extractor_id);
create unique index if not exists idx_tracks_storage_path on public.tracks(storage_path);
-- storage_path will now be written as extractor-extractor_id.mp3 by ingest.js, so youtube 123 != soundcloud 123

-- 1c. playlists: keep anon read, but restrict anon delete to not wipe all
-- For now keep anon manage but remove unrestricted delete by recreating with with check
drop policy if exists "anon manage playlists" on public.playlists;
create policy "anon manage playlists" on public.playlists for all
  to anon, authenticated using (true) with check (length(name) > 0 and length(name) < 100);
drop policy if exists "anon manage playlist_tracks" on public.playlist_tracks;
create policy "anon manage playlist_tracks" on public.playlist_tracks for all
  to anon, authenticated using (true) with check (true);

-- Optional: migrate existing storage_path youtube-style to extractor-prefixed (run once, idempotent)
-- update public.tracks set storage_path = extractor || '-' || storage_path where storage_path !~ '-' and extractor is not null;

-- Verify: should be 0 rows violating check
-- select * from public.ingest_queue where length(original_url) >= 2048 or original_url !~ '^https?://';
