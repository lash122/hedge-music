-- Hybrid: global searchable tracks (public read) + private per-user playlists & queue
-- Run AFTER supabase-music.sql + supabase-music-fix.sql in Supabase Dashboard → SQL Editor
-- Assumes email auth enabled (Auth → Providers → Email ON)

-- 0. Ensure owner_id columns exist (nullable first for migration)
alter table public.tracks add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.ingest_queue add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.playlists add column if not exists owner_id uuid references auth.users(id) on delete cascade;
-- playlist_tracks stays linked via playlists, no owner column needed

create index if not exists idx_tracks_owner on public.tracks(owner_id);
create index if not exists idx_queue_owner on public.ingest_queue(owner_id);
create index if not exists idx_playlists_owner on public.playlists(owner_id);

-- 1. Tracks: keep global public read, but writes require auth + owner = auth.uid()
-- (keeps see/search all songs, but upload needs login)
drop policy if exists "public read tracks" on public.tracks;
drop policy if exists "owner read tracks" on public.tracks;
create policy "public read tracks" on public.tracks for select
  to anon, authenticated using (true);
-- allow authenticated inserts with owner check (anon insert blocked to prevent spam)
drop policy if exists "anon insert tracks" on public.tracks;
drop policy if exists "owner insert tracks" on public.tracks;
create policy "owner insert tracks" on public.tracks for insert
  to authenticated with check (auth.uid() = owner_id);
-- prevent anon/auth from deleting others' tracks; only owner or service_role (bypasses RLS) can delete
drop policy if exists "owner delete tracks" on public.tracks;
create policy "owner delete tracks" on public.tracks for delete
  to authenticated using (auth.uid() = owner_id);

-- keep dedup globally (one row per extractor+id across all users, storage_path unique globally)
-- already: idx_tracks_extractor_id, idx_tracks_storage_path from fix. Keep them.

-- 2. Ingest queue: private per user (each sees own pending), global ingest via service_role sees all
drop policy if exists "anon insert queue" on public.ingest_queue;
drop policy if exists "anon read queue" on public.ingest_queue;
drop policy if exists "owner insert queue" on public.ingest_queue;
drop policy if exists "owner read queue" on public.ingest_queue;
create policy "owner insert queue" on public.ingest_queue for insert
  to authenticated with check (auth.uid() = owner_id and length(original_url) < 2048 and original_url ~ '^https?://');
create policy "owner read queue" on public.ingest_queue for select
  to authenticated using (auth.uid() = owner_id);
-- no anon policies → must log in to queue

-- 3. Playlists: strictly private per user
drop policy if exists "public read playlists" on public.playlists;
drop policy if exists "anon manage playlists" on public.playlists;
drop policy if exists "owner manage playlists" on public.playlists;
create policy "owner manage playlists" on public.playlists for all
  to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id and length(name) > 0 and length(name) < 100);

-- 4. Playlist_tracks: private via owner playlists
drop policy if exists "public read playlist_tracks" on public.playlist_tracks;
drop policy if exists "anon manage playlist_tracks" on public.playlist_tracks;
drop policy if exists "owner manage playlist_tracks" on public.playlist_tracks;
create policy "owner manage playlist_tracks" on public.playlist_tracks for all
  to authenticated using (
    exists (select 1 from public.playlists p where p.id = playlist_tracks.playlist_id and p.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.playlists p where p.id = playlist_tracks.playlist_id and p.owner_id = auth.uid())
  );

-- 5. Backfill existing rows (optional): set owner to first user or leave null (null = legacy global, still readable)
-- After you create your account, run:
-- update public.tracks set owner_id = (select id from auth.users order by created_at limit 1) where owner_id is null;
-- update public.playlists set owner_id = (select id from auth.users order by created_at limit 1) where owner_id is null;

-- Verify
-- select 'tracks public read?' as check, (select count(*) from public.tracks) as n;
