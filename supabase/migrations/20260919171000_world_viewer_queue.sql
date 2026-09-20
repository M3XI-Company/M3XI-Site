-- ===========================================================================
-- Queue functions for the World Viewer pipeline worker.
--
-- The core migration (supabase/migrations/20260919170000_world_viewer_core.sql)
-- defines wv_job, wv_worker and the rest of the schema. These two functions
-- are the worker's contract with that queue and are versioned alongside
-- spatial/pipeline/worldengine/worker.py, because changing either one without
-- the other silently changes leasing behaviour.
--
-- Apply as a migration:
--   supabase migration new wv_claim_job && cat this file into it
-- ===========================================================================

-- Lease exactly one job to one worker.
--
-- SKIP LOCKED is what makes this safe with many pods: two workers claiming at
-- the same instant take different rows rather than blocking on each other or,
-- worse, both getting the same world and both spending 35 GPU-minutes on it.
--
-- A 'leased' or 'running' row whose lease_until has passed is reclaimable:
-- that is how a preempted RunPod pod's work returns to the queue. The run
-- directory is keyed by world id, so the next pod resumes from the checkpoints
-- rather than starting again.
create or replace function wv_claim_job(
  p_worker_id     uuid,
  p_lease_seconds integer default 900,
  p_stages        text[]  default null,
  p_max_attempts  integer default 3
) returns setof wv_job
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job wv_job;
begin
  select j.* into v_job
  from wv_job j
  where (p_stages is null or j.stage = any(p_stages))
    and j.attempt < p_max_attempts
    and (
      j.status = 'queued'
      -- Reclaim an expired lease. 'running' is included deliberately: a pod
      -- that died mid-stage leaves the row in 'running' forever otherwise.
      or (j.status in ('leased', 'running') and j.lease_until < now())
    )
    -- Every dependency must have succeeded. Enforced here rather than in the
    -- worker so a job cannot be handed out early by a buggy client.
    and not exists (
      select 1 from wv_job d
      where d.id = any(j.depends_on) and d.status <> 'succeeded'
    )
  order by j.queued_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update wv_job
     set status      = 'leased',
         worker_id   = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempt     = attempt + 1,
         started_at  = coalesce(started_at, now()),
         error       = null
   where id = v_job.id
  returning * into v_job;

  update wv_worker set last_seen = now() where id = p_worker_id;

  return next v_job;
end;
$$;

-- Extend a lease. Returns true when the lease was extended, false when the
-- job has been taken by someone else — which tells the worker it has been
-- fenced and should stop rather than keep writing.
create or replace function wv_heartbeat_job(
  p_job_id        uuid,
  p_worker_id     uuid,
  p_lease_seconds integer default 900
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update wv_job
     set lease_until = now() + make_interval(secs => p_lease_seconds),
         status      = case when status = 'leased' then 'running' else status end
   where id = p_job_id
     and worker_id = p_worker_id
     and status in ('leased', 'running');
  get diagnostics v_rows = row_count;

  update wv_worker set last_seen = now() where id = p_worker_id;
  return v_rows > 0;
end;
$$;

-- Return abandoned jobs to the queue. Run from pg_cron every few minutes so a
-- pod that vanished without a SIGTERM does not hold a world hostage.
create or replace function wv_reap_expired_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update wv_job
     set status = case when attempt >= 3 then 'failed'::wv_job_status
                       else 'queued'::wv_job_status end,
         worker_id = null,
         lease_until = null,
         error = coalesce(error, 'lease expired; worker vanished')
   where status in ('leased', 'running')
     and lease_until < now() - interval '1 minute';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Only the service role leases work. A browser session must never be able to
-- claim a GPU job.
revoke all on function wv_claim_job(uuid, integer, text[], integer) from public, anon, authenticated;
revoke all on function wv_heartbeat_job(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function wv_reap_expired_jobs() from public, anon, authenticated;
grant execute on function wv_claim_job(uuid, integer, text[], integer) to service_role;
grant execute on function wv_heartbeat_job(uuid, uuid, integer) to service_role;
grant execute on function wv_reap_expired_jobs() to service_role;
