-- ============================================================
-- Hedge Music — CANONICAL Supabase setup (single source of truth)
-- Run ONCE in Supabase Dashboard → SQL Editor. Safe to re-run (idempotent).
--
-- REPLACES the old chain (kept for history, DO NOT run after this):
--   supabase-music.sql → supabase-music-fix.sql → supabase-music-hybrid.sql
--   → supabase-admin-analytics.sql → supabase-admin-delete.sql
--   → supabase-private.sql → supabase-global-shared.sql → supabase-approval.sql
--   → supabase-popular.sql + supabase-ingest-parallel.sql + supabase-admin-emails.sql
--
-- Final model:
--   tracks:            GLOBAL library, visible to APPROVED users + admins (anon sees 0)
--   ingest_queue:      PRIVATE per owner (+ admin manage). Canonical-URL dedup.
--   playlists (+tracks): PRIVATE per owner (+ admin read for dashboard)
--   track_events:      authenticated insert own rows, admin read
--   approved_users / admin_users / deleted_tracks: admin-gated
--   storage `tracks`:  PRIVATE bucket, approved read via signed URLs, admin delete
--   realtime:          tracks, ingest_queue, playlists published
-- ============================================================

-- 0. Trigram index support for title/artist search
create extension if not exists pg_trgm with schema extensions;

-- ============================================================
-- 1. TABLES
-- ============================================================
create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  original_url text unique not null,
  canonical_url text,
  extractor text,
  extractor_id text,
  title text not null,
  artist text,
  thumbnail_url text,
  storage_path text not null,
  duration_sec int,
  file_size bigint,
  owner_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.ingest_queue (
  id uuid primary key default gen_random_uuid(),
  original_url text not null,
  canonical_url text,
  extractor text,
  extractor_id text,
  owner_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','processing','done','error')),
  error text,
  attempts int not null default 0,
  claimed_at timestamptz,
  claimed_by text,
  next_retry_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.playlist_tracks (
  playlist_id uuid references public.playlists(id) on delete cascade,
  track_id uuid references public.tracks(id) on delete cascade,
  position int not null default 0,
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id)
);

create table if not exists public.track_events (
  id uuid primary key default gen_random_uuid(),
  track_id uuid references public.tracks(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  event text not null check (event in ('view','play','queue','search','playlist_add','queue_error')),
  meta jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.approved_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now()
);

create table if not exists public.deleted_tracks (
  id uuid,
  title text,
  artist text,
  storage_path text,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now()
);

-- Back-compat columns for DBs created by old migrations
alter table public.tracks add column if not exists canonical_url text;
alter table public.tracks add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.ingest_queue add column if not exists canonical_url text;
alter table public.ingest_queue add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.ingest_queue add column if not exists attempts int not null default 0;
alter table public.ingest_queue add column if not exists claimed_at timestamptz;
alter table public.ingest_queue add column if not exists claimed_by text;
alter table public.ingest_queue add column if not exists next_retry_at timestamptz;
alter table public.playlists add column if not exists owner_id uuid references auth.users(id) on delete cascade;

-- file_size int → bigint (old DBs)
do $$ begin
  alter table public.tracks alter column file_size type bigint;
exception when others then null; end $$;

-- URL sanity check (NOT VALID first so legacy rows never abort setup; validate below)
alter table public.ingest_queue drop constraint if exists ingest_queue_url_check;
alter table public.ingest_queue add constraint ingest_queue_url_check
  check (length(original_url) < 2048 and original_url ~ '^https?://') not valid;

-- ============================================================
-- 2. INDEXES
-- ============================================================
create unique index if not exists idx_tracks_extractor_id on public.tracks(extractor, extractor_id);
create unique index if not exists idx_tracks_storage_path on public.tracks(storage_path);
create unique index if not exists idx_tracks_canonical on public.tracks(canonical_url) where canonical_url is not null;
create index if not exists idx_tracks_created on public.tracks(created_at desc);
create index if not exists idx_tracks_owner_created on public.tracks(owner_id, created_at desc);
create index if not exists idx_tracks_title_artist_trgm
  on public.tracks using gin ((coalesce(title,'') || ' ' || coalesce(artist,'')) extensions.gin_trgm_ops);
create unique index if not exists uq_queue_canonical_pending
  on public.ingest_queue(canonical_url) where status in ('pending','processing');
create index if not exists idx_queue_status on public.ingest_queue(status, created_at);
create index if not exists idx_queue_owner_status on public.ingest_queue(owner_id, status, created_at desc);
create index if not exists idx_queue_retry on public.ingest_queue(status, next_retry_at, created_at);
create index if not exists idx_queue_claimed on public.ingest_queue(status, claimed_at);
create index if not exists idx_queue_owner on public.ingest_queue(owner_id);
create index if not exists idx_tracks_owner on public.tracks(owner_id);
create index if not exists idx_playlists_owner on public.playlists(owner_id);
create index if not exists idx_playlist_tracks_playlist on public.playlist_tracks(playlist_id, position);
create index if not exists idx_events_track_time on public.track_events(track_id, created_at desc);
create index if not exists idx_events_event_time on public.track_events(event, created_at desc);
create index if not exists idx_events_user_time on public.track_events(user_id, created_at desc);
create index if not exists idx_events_created on public.track_events(created_at desc);

-- ============================================================
-- 3. RLS ON
-- ============================================================
alter table public.tracks enable row level security;
alter table public.ingest_queue enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.track_events enable row level security;
alter table public.admin_users enable row level security;
alter table public.approved_users enable row level security;
alter table public.deleted_tracks enable row level security;

-- ============================================================
-- 4. DROP every legacy policy (any era) so final state is deterministic
-- ============================================================
drop policy if exists "public read tracks" on public.tracks;
drop policy if exists "owner read tracks" on public.tracks;
drop policy if exists "auth read all tracks" on public.tracks;
drop policy if exists "approved read all tracks" on public.tracks;
drop policy if exists "admin read all tracks" on public.tracks;
drop policy if exists "anon insert tracks" on public.tracks;
drop policy if exists "owner insert tracks" on public.tracks;
drop policy if exists "owner delete tracks" on public.tracks;
drop policy if exists "admin delete tracks" on public.tracks;
drop policy if exists "anon insert queue" on public.ingest_queue;
drop policy if exists "anon read queue" on public.ingest_queue;
drop policy if exists "anon delete own pending" on public.ingest_queue;
drop policy if exists "owner insert queue" on public.ingest_queue;
drop policy if exists "owner read queue" on public.ingest_queue;
drop policy if exists "admin read all queue" on public.ingest_queue;
drop policy if exists "admin update queue" on public.ingest_queue;
drop policy if exists "admin delete queue" on public.ingest_queue;
drop policy if exists "public read playlists" on public.playlists;
drop policy if exists "anon manage playlists" on public.playlists;
drop policy if exists "owner manage playlists" on public.playlists;
drop policy if exists "admin read all playlists" on public.playlists;
drop policy if exists "public read playlist_tracks" on public.playlist_tracks;
drop policy if exists "anon manage playlist_tracks" on public.playlist_tracks;
drop policy if exists "owner manage playlist_tracks" on public.playlist_tracks;
drop policy if exists "admin read all playlist_tracks" on public.playlist_tracks;
drop policy if exists "anyone can log events" on public.track_events;
drop policy if exists "auth can log events" on public.track_events;
drop policy if exists "admin read events" on public.track_events;
drop policy if exists "admin read allowlist" on public.admin_users;
drop policy if exists "admin read own" on public.admin_users;
drop policy if exists "admin read all for admin" on public.admin_users;
drop policy if exists "admin read approved" on public.approved_users;
drop policy if exists "own read approved" on public.approved_users;
drop policy if exists "admin manage approved" on public.approved_users;
drop policy if exists "admin read deleted" on public.deleted_tracks;
drop policy if exists "admin insert deleted" on public.deleted_tracks;
-- NOTE: no anon policies remain anywhere → anon sees 0 rows on every table.

-- ============================================================
-- 5. FINAL POLICIES
-- ============================================================
-- tracks: approved-global read (+admin), owner insert/delete (+admin delete)
create policy "approved read all tracks" on public.tracks
  for select to authenticated using (public.is_approved());
create policy "admin read all tracks" on public.tracks
  for select to authenticated using (public.is_admin());
create policy "owner insert tracks" on public.tracks
  for insert to authenticated with check (auth.uid() = owner_id);
create policy "owner delete tracks" on public.tracks
  for delete to authenticated using (auth.uid() = owner_id);
create policy "admin delete tracks" on public.tracks
  for delete to authenticated using (public.is_admin());

-- ingest_queue: owner-only (+admin manage). service_role bypasses for the worker.
create policy "owner insert queue" on public.ingest_queue
  for insert to authenticated
  with check (auth.uid() = owner_id and length(original_url) < 2048 and original_url ~ '^https?://');
create policy "owner read queue" on public.ingest_queue
  for select to authenticated using (auth.uid() = owner_id);
create policy "admin read all queue" on public.ingest_queue
  for select to authenticated using (public.is_admin());
create policy "admin update queue" on public.ingest_queue
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin delete queue" on public.ingest_queue
  for delete to authenticated using (public.is_admin());

-- playlists: owner-only (+admin read for dashboard)
create policy "owner manage playlists" on public.playlists
  for all to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id and length(name) > 0 and length(name) < 100);
create policy "admin read all playlists" on public.playlists
  for select to authenticated using (public.is_admin());

-- playlist_tracks: via owned playlists (+admin read)
create policy "owner manage playlist_tracks" on public.playlist_tracks
  for all to authenticated
  using (exists (select 1 from public.playlists p
                 where p.id = playlist_tracks.playlist_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.playlists p
                      where p.id = playlist_tracks.playlist_id and p.owner_id = auth.uid()));
create policy "admin read all playlist_tracks" on public.playlist_tracks
  for select to authenticated using (public.is_admin());

-- track_events: auth inserts own rows, admin reads
create policy "auth can log events" on public.track_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy "admin read events" on public.track_events
  for select to authenticated using (public.is_admin());

-- admin_users: own row + admin sees all
create policy "admin read own" on public.admin_users
  for select to authenticated using (user_id = auth.uid());
create policy "admin read all for admin" on public.admin_users
  for select to authenticated using (public.is_admin());

-- approved_users: own row + admin manage
create policy "own read approved" on public.approved_users
  for select to authenticated using (user_id = auth.uid());
create policy "admin read approved" on public.approved_users
  for select to authenticated using (public.is_admin());
create policy "admin manage approved" on public.approved_users
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- deleted_tracks: admin only
create policy "admin read deleted" on public.deleted_tracks
  for select to authenticated using (public.is_admin());
create policy "admin insert deleted" on public.deleted_tracks
  for insert to authenticated with check (public.is_admin());

-- ============================================================
-- 6. STORAGE bucket `tracks` (PRIVATE, signed URLs)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('tracks', 'tracks', false)
on conflict (id) do update set public = false;

drop policy if exists "public reads tracks" on storage.objects;
drop policy if exists "anon uploads tracks blocked" on storage.objects;
drop policy if exists "authenticated manages tracks" on storage.objects;
drop policy if exists "owner read track files" on storage.objects;
drop policy if exists "auth read all track files" on storage.objects;
drop policy if exists "approved read all track files" on storage.objects;
drop policy if exists "admin delete track files" on storage.objects;
-- approved users (+admins) read; laptop uploads via service_role (bypasses RLS)
create policy "approved read all track files" on storage.objects
  for select to authenticated using (bucket_id = 'tracks' and public.is_approved());
create policy "admin delete track files" on storage.objects
  for delete to authenticated using (bucket_id = 'tracks' and public.is_admin());

-- ============================================================
-- 7. FUNCTIONS (definer, pinned search_path, least-privilege grants)
-- ============================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
     or exists(select 1 from public.approved_users where user_id = auth.uid());
$$;
revoke all on function public.is_approved() from public;
grant execute on function public.is_approved() to authenticated;

-- single guarded version (replaces the old double definition): non-admins get 0 rows
create or replace function public.get_pending_users()
returns table (id uuid, email text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select u.id, u.email, u.created_at from auth.users u
  left join public.approved_users a on a.user_id = u.id
  left join public.admin_users ad on ad.user_id = u.id
  where public.is_admin() and a.user_id is null and ad.user_id is null
  order by u.created_at desc;
$$;
revoke all on function public.get_pending_users() from public;
grant execute on function public.get_pending_users() to authenticated;

-- admin-only recent events with emails (replaces the broken invoker view v_admin_events)
create or replace function public.get_admin_events(p_limit int default 30)
returns table (id uuid, track_id uuid, user_id uuid, email text, event text,
               meta jsonb, created_at timestamptz, title text, artist text)
language sql stable security definer set search_path = public as $$
  select e.id, e.track_id, e.user_id, coalesce(e.meta->>'email', u.email),
         e.event, e.meta, e.created_at, t.title, t.artist
  from public.track_events e
  left join auth.users u on u.id = e.user_id
  left join public.tracks t on t.id = e.track_id
  where public.is_admin()
  order by e.created_at desc
  limit p_limit;
$$;
revoke all on function public.get_admin_events(int) from public;
grant execute on function public.get_admin_events(int) to authenticated;

create or replace function public.get_popular_tracks(p_limit int, p_offset int)
returns table (id uuid, original_url text, extractor text, extractor_id text,
  title text, artist text, thumbnail_url text, storage_path text,
  duration_sec int, file_size bigint, created_at timestamptz, plays bigint)
language sql stable security definer set search_path = public as $$
  select t.id, t.original_url, t.extractor, t.extractor_id, t.title, t.artist,
         t.thumbnail_url, t.storage_path, t.duration_sec, t.file_size, t.created_at,
         count(e.id) filter (where e.event = 'play') as plays
  from public.tracks t
  left join public.track_events e on e.track_id = t.id
  where public.is_approved()
  group by t.id
  order by plays desc nulls last, t.created_at desc
  limit p_limit offset p_offset;
$$;
revoke all on function public.get_popular_tracks(int, int) from public;
grant execute on function public.get_popular_tracks(int, int) to authenticated;

-- atomic multi-job claim. NOTE semantics: the claim does NOT consume an attempt;
-- attempts increment only on failure in the worker (single counter, both paths).
create or replace function public.claim_queue_jobs(p_limit int, p_worker text)
returns setof public.ingest_queue
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.ingest_queue q
  set status = 'processing', claimed_at = now(), claimed_by = p_worker, error = null
  where q.id in (
    select id from public.ingest_queue
    where status = 'pending'
      and (next_retry_at is null or next_retry_at <= now())
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning q.*;
end;
$$;
revoke all on function public.claim_queue_jobs(int, text) from public;
grant execute on function public.claim_queue_jobs(int, text) to service_role;

create or replace function public.reap_stale_claims(p_timeout interval default '15 minutes')
returns int
language sql security definer set search_path = public as $$
  with u as (
    update public.ingest_queue
    set status = 'pending', claimed_at = null, claimed_by = null, next_retry_at = now()
    where status = 'processing' and claimed_at < now() - p_timeout
    returning 1
  ) select count(*)::int from u;
$$;
revoke all on function public.reap_stale_claims(interval) from public;
grant execute on function public.reap_stale_claims(interval) to service_role;

-- ============================================================
-- 8. VIEWS (admin dashboard; anon revoked, RLS governs the rest)
-- ============================================================
create or replace view public.v_admin_stats as
  select
    (select count(*) from public.tracks) as tracks_total,
    (select count(*) from public.ingest_queue where status = 'pending') as queue_pending,
    (select count(*) from public.ingest_queue where status = 'error') as queue_errors,
    (select count(*) from public.ingest_queue where status = 'done') as queue_done,
    (select count(*) from public.playlists) as playlists_total,
    (select count(*) from public.track_events where event = 'play') as plays_total,
    (select count(*) from public.track_events where event = 'view') as views_total,
    (select count(*) from public.track_events where event = 'queue') as queues_total;

create or replace view public.v_track_leaderboard as
  select t.id, t.title, t.artist, t.extractor, t.storage_path, t.created_at,
         count(*) filter (where e.event = 'play') as plays,
         count(*) filter (where e.event = 'view') as views,
         count(*) filter (where e.event = 'queue') as queues
  from public.tracks t
  left join public.track_events e on e.track_id = t.id
  group by t.id;

drop view if exists public.v_admin_events; -- replaced by get_admin_events() above
drop view if exists public.v_pending_users; -- replaced by get_pending_users() above
revoke all on public.v_admin_stats from anon;
revoke all on public.v_track_leaderboard from anon;

-- ============================================================
-- 9. REALTIME (idempotent)
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.tracks;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ingest_queue;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.playlists;
exception when duplicate_object then null; end $$;

-- ============================================================
-- 10. BACKFILL (idempotent; skipped automatically when no users exist)
-- ============================================================
-- legacy rows without owner → oldest user (visibility unaffected: tracks are approved-global)
update public.tracks set owner_id = (select id from auth.users order by created_at limit 1)
  where owner_id is null and exists (select 1 from auth.users);
update public.playlists set owner_id = (select id from auth.users order by created_at limit 1)
  where owner_id is null and exists (select 1 from auth.users);
-- existing users stay unaffected by the approval gate
insert into public.approved_users(user_id) select id from auth.users on conflict do nothing;
-- validate URL check (was NOT VALID on old DBs); never aborts setup
do $$ begin
  alter table public.ingest_queue validate constraint ingest_queue_url_check;
exception when others then
  raise notice 'ingest_queue_url_check NOT VALID: clean bad rows, then VALIDATE CONSTRAINT manually';
end $$;

-- ============================================================
-- VERIFY (run as needed)
--   as anon:                 select * from public.tracks;            -- 0 rows
--   as new user:             select public.is_approved();            -- false
--   as approved/admin:       select * from public.tracks;            -- all rows
--   seed admin (service_role SQL Editor):
--     insert into public.admin_users(user_id)
--     select id from auth.users where email='you@example.com' on conflict do nothing;
-- ============================================================
