-- ============================================================
-- Private library: owner-read + lock track_events + private bucket
-- Run AFTER supabase-admin-analytics.sql / hybrid in SQL Editor
-- ============================================================

-- 0. Backfill legacy null owner_id so private read does not hide them
-- Assign to first admin, or first user. Run as service_role:
update public.tracks set owner_id = (select user_id from public.admin_users limit 1) where owner_id is null and exists (select 1 from public.admin_users limit 1);
-- fallback if no admin yet: assign to oldest user
update public.tracks set owner_id = (select id from auth.users order by created_at limit 1) where owner_id is null;

update public.playlists set owner_id = (select user_id from public.admin_users limit 1) where owner_id is null and exists (select 1 from public.admin_users limit 1);
update public.playlists set owner_id = (select id from auth.users order by created_at limit 1) where owner_id is null;

-- 1. Tracks: owner-read + admin-read (drop public read)
drop policy if exists "public read tracks" on public.tracks;
drop policy if exists "owner read tracks" on public.tracks;
create policy "owner read tracks" on public.tracks for select to authenticated using (auth.uid() = owner_id);
-- keep existing "admin read all tracks" from admin-analytics (OR)
-- also keep "owner insert tracks" and "owner delete tracks" from hybrid

-- 2. Lock track_events to authenticated only (remove anon flood)
drop policy if exists "anyone can log events" on public.track_events;
drop policy if exists "auth can log events" on public.track_events;
create policy "auth can log events" on public.track_events for insert to authenticated with check (auth.uid() = user_id);

-- tighten is_admin grant: authenticated only
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 3. Playlists / queue already owner-only via hybrid — revoke anon permissive if still present
drop policy if exists "public read playlists" on public.playlists;
drop policy if exists "anon manage playlists" on public.playlists;
drop policy if exists "public read playlist_tracks" on public.playlist_tracks;
drop policy if exists "anon manage playlist_tracks" on public.playlist_tracks;
drop policy if exists "anon insert queue" on public.ingest_queue;
drop policy if exists "anon read queue" on public.ingest_queue;
-- ensure owner policies exist (hybrid already creates them) — recreate idempotently
drop policy if exists "owner manage playlists" on public.playlists;
create policy "owner manage playlists" on public.playlists for all to authenticated using (auth.uid()=owner_id) with check (auth.uid()=owner_id and length(name)>0 and length(name)<100);
drop policy if exists "owner manage playlist_tracks" on public.playlist_tracks;
create policy "owner manage playlist_tracks" on public.playlist_tracks for all to authenticated using (exists (select 1 from public.playlists p where p.id=playlist_tracks.playlist_id and p.owner_id=auth.uid())) with check (exists (select 1 from public.playlists p where p.id=playlist_tracks.playlist_id and p.owner_id=auth.uid()));
drop policy if exists "owner insert queue" on public.ingest_queue;
create policy "owner insert queue" on public.ingest_queue for insert to authenticated with check (auth.uid()=owner_id and length(original_url)<2048 and original_url ~ '^https?://');
drop policy if exists "owner read queue" on public.ingest_queue;
create policy "owner read queue" on public.ingest_queue for select to authenticated using (auth.uid()=owner_id);

-- 4. Storage bucket tracks -> private
update storage.buckets set public=false where id='tracks';
drop policy if exists "public reads tracks" on storage.objects;
drop policy if exists "anon uploads tracks blocked" on storage.objects;
drop policy if exists "authenticated manages tracks" on storage.objects;
drop policy if exists "admin delete track files" on storage.objects;
-- owner can read own files: storage path will be <owner_id>/<extractor>-<id>.mp3 (ingest now writes that)
-- For migration, allow reading both old flat paths (if owner matches track) via track_events? Simpler: allow read if exists track owned by user with that storage_path
create policy "owner read track files" on storage.objects for select to authenticated using (
  bucket_id='tracks' and (
    public.is_admin()
    or exists (select 1 from public.tracks t where t.storage_path = name and t.owner_id = auth.uid())
    or (auth.uid()::text = (string_to_array(name,'/'))[1])
  )
);
create policy "admin delete track files" on storage.objects for delete to authenticated using (bucket_id='tracks' and public.is_admin());
-- inserts still via service_role (bypasses RLS), no anon/auth insert policy = locked

-- 5. Realtime publication (idempotent)
do $$ begin
  alter publication supabase_realtime add table public.tracks;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ingest_queue;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.playlists;
exception when duplicate_object then null; end $$;

-- 6. Harden constraints + indexes
alter table public.tracks alter column file_size type bigint;
create index if not exists idx_tracks_owner_created on public.tracks(owner_id, created_at desc);
create index if not exists idx_queue_owner_status on public.ingest_queue(owner_id, status, created_at desc);
-- validate URL check (was NOT VALID)
do $$ begin
  alter table public.ingest_queue validate constraint ingest_queue_url_check;
exception when others then null; end $$;

-- Verify:
-- as anon: select * from public.tracks should be 0
-- as owner: select * from public.tracks where owner_id=auth.uid() should show own
-- as admin: select * from public.tracks should show all via admin read
