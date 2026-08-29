-- ============================================================
-- Admin + Analytics — ADDITIVE, run AFTER supabase-music.sql + hybrid
-- Does NOT drop/modify existing policies — behavior unchanged
-- Run once in Supabase Dashboard -> SQL Editor
-- ============================================================

-- 0. Admin allowlist (edit to add yourself)
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
-- allow each user to see own row (so checkAdmin can succeed), admin sees all
drop policy if exists "admin read allowlist" on public.admin_users;
drop policy if exists "admin read own" on public.admin_users;
drop policy if exists "admin read all for admin" on public.admin_users;
create policy "admin read own" on public.admin_users for select to authenticated using (user_id = auth.uid());
create policy "admin read all for admin" on public.admin_users for select to authenticated using (public.is_admin());
-- no anon insert — seed via Dashboard SQL as service_role:
-- insert into public.admin_users(user_id) select id from auth.users where email='YOUR_EMAIL' on conflict do nothing;

-- helper: is_admin() — stable, definer, no side effects
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- 1. Additive admin READ policies — OR semantics, never revoke existing public/owner reads
-- tracks
drop policy if exists "admin read all tracks" on public.tracks;
create policy "admin read all tracks" on public.tracks for select to authenticated using (public.is_admin());
-- ingest_queue
drop policy if exists "admin read all queue" on public.ingest_queue;
create policy "admin read all queue" on public.ingest_queue for select to authenticated using (public.is_admin());
-- allow admin to manage queue errors (retry/delete) without service_role
drop policy if exists "admin update queue" on public.ingest_queue;
create policy "admin update queue" on public.ingest_queue for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin delete queue" on public.ingest_queue;
create policy "admin delete queue" on public.ingest_queue for delete to authenticated using (public.is_admin());
-- playlists
drop policy if exists "admin read all playlists" on public.playlists;
create policy "admin read all playlists" on public.playlists for select to authenticated using (public.is_admin());
-- playlist_tracks
drop policy if exists "admin read all playlist_tracks" on public.playlist_tracks;
create policy "admin read all playlist_tracks" on public.playlist_tracks for select to authenticated using (public.is_admin());

-- 2. Analytics — new table only, no alters to tracks/playlists/queue
create table if not exists public.track_events (
  id uuid primary key default gen_random_uuid(),
  track_id uuid references public.tracks(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  event text not null check (event in ('view','play','queue','search','playlist_add','queue_error')),
  meta jsonb,
  created_at timestamptz not null default now()
);
alter table public.track_events enable row level security;
-- anyone (anon+auth) can log — never blocks PWA if fails we ignore
drop policy if exists "anyone can log events" on public.track_events;
create policy "anyone can log events" on public.track_events for insert to anon, authenticated with check (true);
-- only admin can read events (service_role bypasses)
drop policy if exists "admin read events" on public.track_events;
create policy "admin read events" on public.track_events for select to authenticated using (public.is_admin());
-- no update/delete for clients

create index if not exists idx_events_track_time on public.track_events(track_id, created_at desc);
create index if not exists idx_events_event_time on public.track_events(event, created_at desc);
create index if not exists idx_events_user_time on public.track_events(user_id, created_at desc);
create index if not exists idx_events_created on public.track_events(created_at desc);

-- 3. Views for dashboard — read via policies above, no extra grants
create or replace view public.v_admin_stats as
  select
    (select count(*) from public.tracks) as tracks_total,
    (select count(*) from public.ingest_queue where status='pending') as queue_pending,
    (select count(*) from public.ingest_queue where status='error') as queue_errors,
    (select count(*) from public.ingest_queue where status='done') as queue_done,
    (select count(*) from public.playlists) as playlists_total,
    (select count(*) from public.track_events where event='play') as plays_total,
    (select count(*) from public.track_events where event='view') as views_total,
    (select count(*) from public.track_events where event='queue') as queues_total;

-- per-track aggregates for leaderboard (admin query)
create or replace view public.v_track_leaderboard as
  select
    t.id, t.title, t.artist, t.extractor, t.storage_path, t.created_at,
    count(*) filter (where e.event='play') as plays,
    count(*) filter (where e.event='view') as views,
    count(*) filter (where e.event='queue') as queues
  from public.tracks t
  left join public.track_events e on e.track_id = t.id
  group by t.id;

-- 4. Helper: make current user admin by email (run as service_role)
-- select public.is_admin(); -- false until seeded
-- insert into public.admin_users(user_id) select id from auth.users where email='you@example.com' on conflict do nothing;

-- Verify — should not error, should show 0 rows until events flow
-- select * from public.v_admin_stats;
-- select * from public.track_events limit 1;
