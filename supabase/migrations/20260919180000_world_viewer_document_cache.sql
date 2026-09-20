-- ===========================================================================
-- World Viewer — the database becomes the world.
--
-- Until now the pipeline assembled a WorldDocument, uploaded it as a file, and
-- nothing ever wrote wv_room, wv_camera, wv_entity or the rest. Everything
-- that reads a world reads those tables, so a published world had no rooms.
--
-- `wv-jobs ingest-world` now writes them, and the document becomes a RENDERING
-- of the rows rather than the record itself. That ordering is deliberate:
-- operator corrections — rename a room, move a misplaced object, fix a
-- dimension, approve a redaction — have to land in something row-level
-- security can protect and a portfolio query can read. If the uploaded file
-- were authoritative, the policies in ..._rls.sql that make a correction safe
-- would stop meaning anything.
--
-- Three things that change needs:
--   1. somewhere to record how metric scale was grounded, because the renderer
--      was asserting `reconstructed` for a number no camera measured;
--   2. a natural key for the two tables that have none, so a resumed hand-off
--      updates its rows instead of doubling them;
--   3. a way for any write to say "the cached document is no longer what the
--      rows say", including a write that never went through an edge function.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. How metric scale was grounded
--
-- wv_world already records which estimator fixed scale and how well the
-- estimators agreed. It did not record the PROVENANCE of that number, so the
-- renderer had to assume one, and it assumed `reconstructed`. That is the one
-- assumption this contract forbids: no camera measures a metre, a model
-- estimates one, and every dimension in the world inherits the weaker of its
-- geometry's provenance and the scale's. Without this column a 4 m wall is
-- published as a reconstructed measurement when it is an inferred one.
--
-- Agreement is not confidence, either: two estimators can agree closely on a
-- capture that neither of them should be trusted on. The pipeline computes
-- both; now both survive.
-- --------------------------------------------------------------------------

alter table wv_world
  add column if not exists scale_provenance wv_provenance,
  add column if not exists scale_confidence numeric(4,3);

comment on column wv_world.scale_provenance is
  'How metric scale was established. Never ''observed'': a metre is estimated, not measured. Null means unrecorded, and the renderer degrades to ''inferred'' rather than to the stronger claim.';

-- --------------------------------------------------------------------------
-- 2. Natural keys for the two tables that had none
--
-- Every other table the pipeline writes has an id the ingest can derive from
-- the world and the document's own identifiers, so re-sending a section
-- updates in place. Relationships and nav edges have bigserial primary keys
-- and nothing unique about them, so a preempted pod that re-sent its work
-- would have given the world two of every edge — and nothing would have
-- errored, which is the worst version of that bug.
--
-- Deriving a bigint key from a hash was the alternative and was rejected: a
-- JavaScript number carries 53 bits, and 53 bits is a birthday collision
-- between two tenants' worlds at the scale this product is built for. These
-- indexes let the sequence keep its own value and put the identity where it
-- actually lives.
-- --------------------------------------------------------------------------

create unique index if not exists wv_rel_identity
  on wv_relationship (world_id, subject_type, subject_id, predicate, object_type, object_id);

create unique index if not exists wv_nav_edge_identity
  on wv_nav_edge (world_id, a, b);

-- --------------------------------------------------------------------------
-- 3. Cache invalidation
--
-- The rendered document lives in storage as a wv_asset with the reserved chunk
-- key 'world-document'. Readers fetch that object instead of reassembling a
-- world out of thirteen selects on every request.
--
-- Anything that changes what a render would produce must therefore say so.
-- The edge functions do it explicitly (markWorldDocumentStale in
-- _wv_shared/worldDocument.ts), but ..._rls.sql grants UPDATE on wv_room,
-- wv_entity, wv_opening and wv_surface directly to `authenticated`, so an
-- operator console can correct a room over PostgREST without an edge function
-- ever seeing it. An invalidation that only fires in application code would be
-- silently wrong for exactly the writes this whole design exists to support.
--
-- So it is a trigger, and a STATEMENT-level one with transition tables: a
-- correction touching five hundred rooms costs one UPDATE of one row, not five
-- hundred. Postgres will not attach a transition table to a trigger with more
-- than one event, hence the three per table.
--
-- wv_asset is deliberately not in the list. The cache entry is itself a
-- wv_asset row, so a trigger there would invalidate the document each time the
-- renderer finished writing it, and then again, and again.
-- --------------------------------------------------------------------------

create or replace function wv_stale_document_from_new()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update wv_asset a
     set meta = a.meta || jsonb_build_object(
           'stale', true,
           'staleAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'staleReason', 'rows changed in ' || tg_table_name)
   where a.chunk_key = 'world-document'
     and a.world_id in (select distinct world_id from wv_changed);
  return null;
end $$;

create or replace function wv_stale_document_from_old()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update wv_asset a
     set meta = a.meta || jsonb_build_object(
           'stale', true,
           'staleAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'staleReason', 'rows removed from ' || tg_table_name)
   where a.chunk_key = 'world-document'
     and a.world_id in (select distinct world_id from wv_changed);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'wv_floor','wv_room','wv_surface','wv_opening','wv_entity','wv_relationship',
    'wv_nav_node','wv_nav_edge','wv_region','wv_camera','wv_quality'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_stale_ins', t);
    execute format('drop trigger if exists %I on %I', t || '_stale_upd', t);
    execute format('drop trigger if exists %I on %I', t || '_stale_del', t);
    execute format(
      'create trigger %I after insert on %I referencing new table as wv_changed '
      'for each statement execute function wv_stale_document_from_new()', t || '_stale_ins', t);
    execute format(
      'create trigger %I after update on %I referencing new table as wv_changed '
      'for each statement execute function wv_stale_document_from_new()', t || '_stale_upd', t);
    execute format(
      'create trigger %I after delete on %I referencing old table as wv_changed '
      'for each statement execute function wv_stale_document_from_old()', t || '_stale_del', t);
  end loop;
end $$;

-- wv_world carries the world id in `id` rather than `world_id`, so it gets its
-- own trigger. Publication state, the slug and the scale block all appear in
-- the document, so an unpublish that left the old document cached would keep
-- serving a world that is no longer published.
create or replace function wv_stale_document_from_world()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update wv_asset a
     set meta = a.meta || jsonb_build_object(
           'stale', true,
           'staleAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'staleReason', 'the world row changed')
   where a.chunk_key = 'world-document'
     and a.world_id in (select distinct id from wv_changed);
  return null;
end $$;

drop trigger if exists wv_world_stale_upd on wv_world;
create trigger wv_world_stale_upd after update on wv_world
  referencing new table as wv_changed
  for each statement execute function wv_stale_document_from_world();

-- The trigger functions run as definer and are reached only by writing to the
-- tables above; nothing should be able to call them directly.
revoke execute on function wv_stale_document_from_new()   from public, anon, authenticated;
revoke execute on function wv_stale_document_from_old()   from public, anon, authenticated;
revoke execute on function wv_stale_document_from_world() from public, anon, authenticated;
