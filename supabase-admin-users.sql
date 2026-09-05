-- ============================================================
-- Admin: per-user management + moderation + trash/restore
-- ADDITIVE, idempotent. Run AFTER supabase-setup.sql in SQL Editor.
-- Everything is admin-gated (public.is_admin()), least-privilege grants.
-- Admin UI (admin.html) degrades gracefully until this is applied.
-- ============================================================

-- ------------------------------------------------------------
-- 1. USER ROSTER + STATS (single round trip for the Users card)
-- ------------------------------------------------------------
create or replace function public.get_all_users()
returns table (
  id uuid, email text, created_at timestamptz,
  approved boolean, is_admin boolean,
  tracks bigint, q_pending bigint, q_errors bigint,
  playlists bigint, plays bigint, bytes bigint
)
language sql stable security definer set search_path = public as $$
  select u.id, u.email, u.created_at,
         (a.user_id is not null) as approved,
         (ad.user_id is not null) as is_admin,
         coalesce(t.tracks, 0) as tracks,
         coalesce(q.q_pending, 0) as q_pending,
         coalesce(q.q_errors, 0) as q_errors,
         coalesce(p.playlists, 0) as playlists,
         coalesce(e.plays, 0) as plays,
         coalesce(t.bytes, 0) as bytes
  from auth.users u
  left join public.approved_users a on a.user_id = u.id
  left join public.admin_users ad on ad.user_id = u.id
  left join (select owner_id, count(*) as tracks, coalesce(sum(file_size),0)::bigint as bytes
             from public.tracks group by owner_id) t on t.owner_id = u.id
  left join (select owner_id,
                    count(*) filter (where status in ('pending','processing')) as q_pending,
                    count(*) filter (where status = 'error') as q_errors
             from public.ingest_queue group by owner_id) q on q.owner_id = u.id
  left join (select owner_id, count(*) as playlists
             from public.playlists group by owner_id) p on p.owner_id = u.id
  left join (select user_id, count(*) filter (where event = 'play') as plays
             from public.track_events group by user_id) e on e.user_id = u.id
  where public.is_admin()
  order by u.created_at desc;
$$;
revoke all on function public.get_all_users() from public;
grant execute on function public.get_all_users() to authenticated;

-- ------------------------------------------------------------
-- 2. APPROVE / REVOKE (revoke = remove row; keeps content + auth user)
-- ------------------------------------------------------------
create or replace function public.set_approved(p_user uuid, p_approve boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not admin'; end if;
  if p_approve then
    insert into public.approved_users(user_id, approved_by)
    values (p_user, auth.uid())
    on conflict (user_id) do nothing;
  else
    delete from public.approved_users where user_id = p_user;
  end if;
  return true;
end $$;
revoke all on function public.set_approved(uuid, boolean) from public;
grant execute on function public.set_approved(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 3. GRANT / REVOKE ADMIN (can never remove the last admin)
-- ------------------------------------------------------------
create or replace function public.set_admin(p_user uuid, p_make boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n_admins int;
begin
  if not public.is_admin() then raise exception 'not admin'; end if;
  if p_make then
    insert into public.admin_users(user_id) values (p_user)
    on conflict (user_id) do nothing;
  else
    select count(*) into n_admins from public.admin_users;
    if n_admins <= 1 then raise exception 'cannot remove the last admin'; end if;
    if p_user = auth.uid() and n_admins <= 2 then
      raise exception 'cannot remove yourself while only 2 admins remain — ask the other admin';
    end if;
    delete from public.admin_users where user_id = p_user;
  end if;
  return true;
end $$;
revoke all on function public.set_admin(uuid, boolean) from public;
grant execute on function public.set_admin(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 4. QUEUE RETRY (error -> pending; worker picks it up again)
-- ------------------------------------------------------------
create or replace function public.retry_queue(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not admin'; end if;
  update public.ingest_queue
  set status = 'pending', error = null, next_retry_at = null,
      claimed_at = null, claimed_by = null, attempts = attempts + 1
  where id = p_id and status = 'error';
  return found;
end $$;
revoke all on function public.retry_queue(uuid) from public;
grant execute on function public.retry_queue(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. WORKER HEARTBEAT (is the laptop ingest actually running?)
-- ------------------------------------------------------------
create or replace function public.get_worker_status()
returns table (last_done_at timestamptz, pending bigint, stale_processing bigint,
               oldest_pending_at timestamptz, total_errors bigint)
language sql stable security definer set search_path = public as $$
  select (select max(created_at) from public.ingest_queue where status = 'done'),
         (select count(*) from public.ingest_queue where status in ('pending','processing')),
         (select count(*) from public.ingest_queue
           where status = 'processing' and claimed_at < now() - interval '15 minutes'),
         (select min(created_at) from public.ingest_queue where status = 'pending'),
         (select count(*) from public.ingest_queue where status = 'error')
  where public.is_admin();
$$;
revoke all on function public.get_worker_status() from public;
grant execute on function public.get_worker_status() to authenticated;

-- ------------------------------------------------------------
-- 6. MODERATION POLICIES (admin edit tracks, delete playlists, restore)
-- ------------------------------------------------------------
-- edit title/artist/thumbnail (spam/typo fixes)
drop policy if exists "admin update tracks" on public.tracks;
create policy "admin update tracks" on public.tracks
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- delete abusive/duplicate playlists (cascades playlist_tracks)
drop policy if exists "admin delete playlists" on public.playlists;
create policy "admin delete playlists" on public.playlists
  for delete to authenticated using (public.is_admin());

-- re-insert for trash restore
drop policy if exists "admin insert tracks" on public.tracks;
create policy "admin insert tracks" on public.tracks
  for insert to authenticated with check (public.is_admin());

-- richer trash snapshot so restore works (nullable = back-compat with old rows)
alter table public.deleted_tracks add column if not exists owner_id uuid;
alter table public.deleted_tracks add column if not exists original_url text;
alter table public.deleted_tracks add column if not exists canonical_url text;
alter table public.deleted_tracks add column if not exists extractor text;
alter table public.deleted_tracks add column if not exists thumbnail_url text;
alter table public.deleted_tracks add column if not exists duration_sec int;
alter table public.deleted_tracks add column if not exists file_size bigint;
alter table public.deleted_tracks add column if not exists file_deleted boolean not null default false;
drop policy if exists "admin update deleted" on public.deleted_tracks;
create policy "admin update deleted" on public.deleted_tracks
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 7. ORPHAN MP3 REPORT (files in bucket with no track row)
-- ------------------------------------------------------------
create or replace function public.get_orphan_files()
returns table (name text, bytes bigint, created timestamptz)
language sql stable security definer set search_path = public, storage as $$
  select o.name, (o.metadata->>'size')::bigint, o.created_at
  from storage.objects o
  where o.bucket_id = 'tracks'
    and public.is_admin()
    and not exists (select 1 from public.tracks t where t.storage_path = o.name)
  order by o.created_at desc
  limit 200;
$$;
revoke all on function public.get_orphan_files() from public;
grant execute on function public.get_orphan_files() to authenticated;

-- ------------------------------------------------------------
-- 8. MEASURED STORAGE + USER COUNTS on the stats view
-- ------------------------------------------------------------
create or replace view public.v_admin_stats as
  select
    (select count(*) from public.tracks) as tracks_total,
    (select count(*) from public.ingest_queue where status='pending') as queue_pending,
    (select count(*) from public.ingest_queue where status='error') as queue_errors,
    (select count(*) from public.ingest_queue where status='done') as queue_done,
    (select count(*) from public.playlists) as playlists_total,
    (select count(*) from public.track_events where event='play') as plays_total,
    (select count(*) from public.track_events where event='view') as views_total,
    (select count(*) from public.track_events where event='queue') as queues_total,
    (select count(*) from auth.users) as users_total,
    (select count(*) from public.approved_users) as approved_total,
    (select coalesce(sum(file_size),0) from public.tracks) as storage_bytes;

-- ------------------------------------------------------------
-- 9. EVENTS PER USER (signature change → drop first, then recreate)
-- p_user null = global feed (old callers unaffected)
-- ------------------------------------------------------------
drop function if exists public.get_admin_events(int);
create or replace function public.get_admin_events(p_limit int default 30, p_user uuid default null)
returns table (id uuid, track_id uuid, user_id uuid, email text, event text,
               meta jsonb, created_at timestamptz, title text, artist text)
language sql stable security definer set search_path = public as $$
  select e.id, e.track_id, e.user_id, coalesce(e.meta->>'email', u.email),
         e.event, e.meta, e.created_at, t.title, t.artist
  from public.track_events e
  left join auth.users u on u.id = e.user_id
  left join public.tracks t on t.id = e.track_id
  where public.is_admin()
    and (p_user is null or e.user_id = p_user)
  order by e.created_at desc
  limit p_limit;
$$;
revoke all on function public.get_admin_events(int, uuid) from public;
grant execute on function public.get_admin_events(int, uuid) to authenticated;

-- leaderboard with owner (emails resolved client-side from get_all_users roster)
-- NOTE: plain CREATE (not OR REPLACE): owner_id is inserted mid-column-list,
-- which Postgres rejects on replace (42P16). No DB objects depend on this view.
drop view if exists public.v_track_leaderboard;
create view public.v_track_leaderboard as
  select
    t.id, t.title, t.artist, t.extractor, t.storage_path, t.created_at, t.owner_id,
    count(*) filter (where e.event='play') as plays,
    count(*) filter (where e.event='view') as views,
    count(*) filter (where e.event='queue') as queues
  from public.tracks t
  left join public.track_events e on e.track_id = t.id
  group by t.id;
