-- ============================================================
-- Music PWA Supabase Setup - Laptop as On-Demand Ingest Server
-- Run this ONCE in Supabase Dashboard -> SQL Editor
-- Works alongside hedge3's supabase-setup.sql, does not overwrite it
-- Supports yt-dlp for ANY site (YouTube, SoundCloud, Bandcamp, etc)
-- ============================================================

-- 1. tracks: final library (what PWA plays)
create table if not exists public.tracks (
    id uuid primary key default gen_random_uuid(),
    original_url text unique not null,
    extractor text,              -- e.g. youtube, soundcloud, bandcamp
    extractor_id text,           -- youtube video ID, soundcloud track ID etc
    title text not null,
    artist text,
    thumbnail_url text,
    storage_path text not null,  -- tracks/<extractor_id>.mp3 or <uuid>.mp3
    duration_sec int,
    file_size int,
    created_at timestamptz not null default now()
);
alter table public.tracks enable row level security;
drop policy if exists "public read tracks" on public.tracks;
create policy "public read tracks" on public.tracks for select to anon, authenticated using (true);
-- inserts only via service_role (laptop ingest.js bypasses RLS). No anon insert policy = safe.

-- 2. ingest_queue: PWA writes pending, laptop polls and processes collectively
create table if not exists public.ingest_queue (
    id uuid primary key default gen_random_uuid(),
    original_url text not null,
    extractor text,
    extractor_id text,
    status text not null default 'pending' check (status in ('pending','processing','done','error')),
    error text,
    created_at timestamptz not null default now()
);
alter table public.ingest_queue enable row level security;
drop policy if exists "anon insert queue" on public.ingest_queue;
create policy "anon insert queue" on public.ingest_queue for insert to anon, authenticated with check (true);
drop policy if exists "anon read queue" on public.ingest_queue;
create policy "anon read queue" on public.ingest_queue for select to anon, authenticated using (true);
drop policy if exists "anon delete own pending" on public.ingest_queue;
create policy "anon delete own pending" on public.ingest_queue for delete to anon, authenticated using (status='pending');
-- updates/deletes for processing done via service_role laptop

-- 3. playlists + join table (PWA manages, anon allowed for personal app - add auth later if needed)
create table if not exists public.playlists (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_at timestamptz not null default now()
);
alter table public.playlists enable row level security;
drop policy if exists "public read playlists" on public.playlists;
create policy "public read playlists" on public.playlists for select to anon, authenticated using (true);
drop policy if exists "anon manage playlists" on public.playlists;
create policy "anon manage playlists" on public.playlists for all to anon, authenticated using (true) with check (true);

create table if not exists public.playlist_tracks (
    playlist_id uuid references public.playlists(id) on delete cascade,
    track_id uuid references public.tracks(id) on delete cascade,
    position int not null default 0,
    added_at timestamptz not null default now(),
    primary key (playlist_id, track_id)
);
alter table public.playlist_tracks enable row level security;
drop policy if exists "public read playlist_tracks" on public.playlist_tracks;
create policy "public read playlist_tracks" on public.playlist_tracks for select to anon, authenticated using (true);
drop policy if exists "anon manage playlist_tracks" on public.playlist_tracks;
create policy "anon manage playlist_tracks" on public.playlist_tracks for all to anon, authenticated using (true) with check (true);

-- 4. Storage bucket `tracks` - PUBLIC read so PWA <audio src=publicUrl> works without signed URLs
-- (like rewards bucket in supabase-setup.sql, unlike private voices bucket)
insert into storage.buckets (id, name, public)
values ('tracks', 'tracks', true)
on conflict (id) do update set public = true;

drop policy if exists "public reads tracks" on storage.objects;
create policy "public reads tracks" on storage.objects for select to anon, authenticated using (bucket_id = 'tracks');

drop policy if exists "anon uploads tracks blocked" on storage.objects;
-- No anon insert - only service_role laptop uploads. Keep blocked for anon:
-- (we don't create anon insert policy, so only service_role can insert)

-- Optional: allow service_role/authenticated to manage (for laptop with service_role, bypasses RLS anyway)
drop policy if exists "authenticated manages tracks" on storage.objects;
create policy "authenticated manages tracks" on storage.objects for all to authenticated using (bucket_id='tracks') with check (bucket_id='tracks');

-- 5. Helpful indexes
create index if not exists idx_tracks_extractor on public.tracks(extractor, extractor_id);
create index if not exists idx_tracks_created on public.tracks(created_at desc);
create index if not exists idx_queue_status on public.ingest_queue(status, created_at);
create index if not exists idx_playlist_tracks_playlist on public.playlist_tracks(playlist_id, position);
