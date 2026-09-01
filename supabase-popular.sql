-- ============================================================
-- Popular ordering for the app library (plays from track_events)
-- ADDITIVE: run once in SQL Editor AFTER supabase-approval.sql
-- App reads via rpc get_popular_tracks() — gated by is_approved()
-- ============================================================

create or replace function public.get_popular_tracks(p_limit int, p_offset int)
returns table (
  id uuid,
  original_url text,
  extractor text,
  extractor_id text,
  title text,
  artist text,
  thumbnail_url text,
  storage_path text,
  duration_sec int,
  file_size bigint,
  created_at timestamptz,
  plays bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id, t.original_url, t.extractor, t.extractor_id, t.title, t.artist,
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

-- Verify as an approved user in the app console:
-- await sb.rpc('get_popular_tracks', { p_limit: 10, p_offset: 0 })
