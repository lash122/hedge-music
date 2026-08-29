-- ============================================================
-- Admin hard delete any song + file — ADDITIVE
-- Run AFTER supabase-admin-analytics.sql in SQL Editor
-- No effect on anon read or owner delete (OR policies)
-- ============================================================

-- 1. Admin can delete any track (hard delete, cascades playlist_tracks)
drop policy if exists "admin delete tracks" on public.tracks;
create policy "admin delete tracks" on public.tracks for delete to authenticated using (public.is_admin());

-- 2. Admin can delete files from tracks bucket (MP3)
-- storage.objects RLS: bucket_id='tracks'
drop policy if exists "admin delete track files" on storage.objects;
create policy "admin delete track files" on storage.objects for delete to authenticated using (bucket_id='tracks' and public.is_admin());

-- Optional: also allow admin to delete via update if needed (not required for hard delete)
-- Already: playlist_tracks cascades ON DELETE CASCADE from tracks(id)

-- 3. Optional audit log (keeps title for undo/history, not RLS-blocking)
create table if not exists public.deleted_tracks (
  id uuid,
  title text,
  artist text,
  storage_path text,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now()
);
alter table public.deleted_tracks enable row level security;
drop policy if exists "admin read deleted" on public.deleted_tracks;
create policy "admin read deleted" on public.deleted_tracks for select to authenticated using (public.is_admin());
drop policy if exists "admin insert deleted" on public.deleted_tracks;
create policy "admin insert deleted" on public.deleted_tracks for insert to authenticated with check (public.is_admin());

-- Verify as admin@gmail.com (in admin.html console):
-- await sb.from('tracks').delete().eq('id','<test-id>')  // should succeed as admin, fail as normal user
-- await sb.storage.from('tracks').remove(['youtube-xxx.mp3']) // same
