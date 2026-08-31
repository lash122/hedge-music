-- ============================================================
-- Ingest queue hardening for parallel laptops + speed + resilience
-- ADDITIVE: keeps owner RLS, only adds columns/index/RPCs for service_role workers
-- Run once in Supabase SQL Editor AFTER supabase-approval.sql
-- ============================================================

-- 1. Retry/lease/dedup columns
alter table public.ingest_queue add column if not exists attempts int not null default 0;
alter table public.ingest_queue add column if not exists claimed_at timestamptz;
alter table public.ingest_queue add column if not exists claimed_by text;
alter table public.ingest_queue add column if not exists next_retry_at timestamptz;
alter table public.ingest_queue add column if not exists canonical_url text;

-- dedup: avoid double queue/download of same canonical URL while pending or processing
create unique index if not exists uq_queue_canonical_pending
  on public.ingest_queue(canonical_url) where status in ('pending','processing');

-- retry scan index
create index if not exists idx_queue_retry on public.ingest_queue(status, next_retry_at, created_at);
-- stale-claim reaper index
create index if not exists idx_queue_claimed on public.ingest_queue(status, claimed_at);

-- 2. Atomic multi-job claim with FOR UPDATE SKIP LOCKED (true work-stealing across workers)
create or replace function public.claim_queue_jobs(p_limit int, p_worker text)
returns setof public.ingest_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.ingest_queue q
  set status='processing', claimed_at=now(), claimed_by=p_worker, attempts=attempts+1, error=null
  where q.id in (
    select id from public.ingest_queue
    where status='pending'
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

-- 3. Reap stale 'processing' after crash (called on worker start + each tick)
create or replace function public.reap_stale_claims(p_timeout interval default '15 minutes')
returns int
language sql
security definer
as $$
  with u as (
    update public.ingest_queue
    set status='pending', claimed_at=null, claimed_by=null, next_retry_at=now()
    where status='processing' and claimed_at < now() - p_timeout
    returning 1
  ) select count(*)::int from u;
$$;
revoke all on function public.reap_stale_claims(interval) from public;
grant execute on function public.reap_stale_claims(interval) to service_role;

-- Verify:
-- select claim_queue_jobs(3, 'test-worker'); -- should return up to 3 pending rows now marked processing
-- update public.ingest_queue set status='pending', claimed_at=null where claimed_by='test-worker';
-- select public.reap_stale_claims();
