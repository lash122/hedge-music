-- ============================================================
-- Global shared library + private playlists/queue
-- Run AFTER supabase-private.sql in SQL Editor
-- Tracks: all authenticated users see all tracks (global)
-- Playlists/queue/track_events: remain private owner-only
-- ============================================================

-- 1. Tracks: global for authenticated (anon sees 0, gated in music.js:98)
drop policy if exists "owner read tracks" on public.tracks;
drop policy if exists "public read tracks" on public.tracks;
drop policy if exists "auth read all tracks" on public.tracks;
create policy "auth read all tracks" on public.tracks for select to authenticated using (true);
-- keep existing "admin read all tracks" (OR) + "owner insert/delete tracks" from hybrid

-- 2. Storage bucket tracks: keep private bucket, but global read for authenticated
-- (private bucket + signed URLs via createSignedUrl in music.js:118)
update storage.buckets set public=false where id='tracks';
drop policy if exists "owner read track files" on storage.objects;
drop policy if exists "auth read all track files" on storage.objects;
create policy "auth read all track files" on storage.objects for select to authenticated using (bucket_id='tracks');
-- keep admin delete: "admin delete track files" already exists

-- 3. Tracks legacy null owner_id — assign to admin for ownership audit (visibility not needed for global read)
update public.tracks set owner_id = (select user_id from public.admin_users limit 1) where owner_id is null and exists (select 1 from public.admin_users limit 1);

-- 4. Ingest queue / playlists stay private owner-only (no change, ensure policies exist)
-- playlists, queue already owner-only via hybrid/private — do not recreate public

-- Verify:
-- as anon: select * from public.tracks -> 0 rows
-- as authenticated: select * from public.tracks -> all rows
-- as admin: also all via admin read
