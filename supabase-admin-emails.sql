-- Add emails to tracking — run once after supabase-admin-analytics.sql
-- Stores email in track_events.meta.email (no schema change, back-compat)
-- Plus secure view that joins auth.users for old rows

-- 1. Backfill existing rows where meta.email missing: copy from auth.users
update public.track_events e
set meta = coalesce(e.meta,'{}'::jsonb) || jsonb_build_object('email', u.email)
from auth.users u
where e.user_id = u.id
  and (e.meta->>'email' is null);

-- 2. Admin-only view with emails (security definer, bypasses auth.users RLS)
create or replace view public.v_admin_events as
  select e.id, e.track_id, e.user_id, coalesce(e.meta->>'email', u.email) as email,
         e.event, e.meta, e.created_at,
         t.title, t.artist
  from public.track_events e
  left join auth.users u on u.id = e.user_id
  left join public.tracks t on t.id = e.track_id;

-- grant only via admin policy already on track_events; view inherits via definer
-- query as admin: select * from public.v_admin_events order by created_at desc limit 50;
