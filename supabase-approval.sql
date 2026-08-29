-- ============================================================
-- Manual approval: global tracks only for approved users
-- Keep Confirm email OFF — approval via admin.html
-- Run AFTER supabase-global-shared.sql
-- ============================================================

create table if not exists public.approved_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now()
);
alter table public.approved_users enable row level security;
drop policy if exists "admin read approved" on public.approved_users;
create policy "admin read approved" on public.approved_users for select to authenticated using (public.is_admin());
drop policy if exists "own read approved" on public.approved_users;
create policy "own read approved" on public.approved_users for select to authenticated using (user_id = auth.uid());
drop policy if exists "admin manage approved" on public.approved_users;
create policy "admin manage approved" on public.approved_users for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path=public as $$
  select public.is_admin() or exists(select 1 from public.approved_users where user_id = auth.uid());
$$;
revoke all on function public.is_approved() from public;
grant execute on function public.is_approved() to authenticated;

-- Lock tracks global to approved+admin (anon and unapproved see 0)
drop policy if exists "auth read all tracks" on public.tracks;
drop policy if exists "approved read all tracks" on public.tracks;
create policy "approved read all tracks" on public.tracks for select to authenticated using (public.is_approved());

-- Lock storage files similarly
drop policy if exists "auth read all track files" on storage.objects;
drop policy if exists "approved read all track files" on storage.objects;
create policy "approved read all track files" on storage.objects for select to authenticated using (bucket_id='tracks' and public.is_approved());

-- Backfill current users as approved so they stay unaffected
insert into public.approved_users(user_id) select id from auth.users on conflict do nothing;

-- Helper view for admin: pending users (not approved, not admin)
create or replace view public.v_pending_users as
  select u.id, u.email, u.created_at
  from auth.users u
  left join public.approved_users a on a.user_id = u.id
  left join public.admin_users ad on ad.user_id = u.id
  where a.user_id is null and ad.user_id is null;

-- grant view read to admin via RLS on underlying tables (view is invoker, so need function)
create or replace function public.get_pending_users()
returns table (id uuid, email text, created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select u.id, u.email, u.created_at from auth.users u
  left join public.approved_users a on a.user_id = u.id
  left join public.admin_users ad on ad.user_id = u.id
  where a.user_id is null and ad.user_id is null
  order by u.created_at desc;
$$;
revoke all on function public.get_pending_users() from public;
grant execute on function public.get_pending_users() to authenticated;
-- only admin can actually get rows (check inside function via is_admin)
-- add guard: if not admin, return 0 rows
create or replace function public.get_pending_users()
returns table (id uuid, email text, created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select u.id, u.email, u.created_at from auth.users u
  left join public.approved_users a on a.user_id = u.id
  left join public.admin_users ad on ad.user_id = u.id
  where public.is_admin() and a.user_id is null and ad.user_id is null
  order by u.created_at desc;
$$;

-- Verify:
-- as new user (not approved): select * from public.tracks -> 0
-- as approved/admin: select * from public.tracks -> all
-- select public.is_approved(); -- true for approved/admin
