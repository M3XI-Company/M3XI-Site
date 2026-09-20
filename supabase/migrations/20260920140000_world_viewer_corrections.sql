-- ===========================================================================
-- World Viewer — what an operator correction needs that the schema lacked.
--
-- `approve_corrections` implements fifteen of the eighteen correction kinds
-- the editor emits. The other three -- room.delete, entity.delete and
-- region.clear -- are refused at run time, because there is no delete
-- anywhere on that path: `Db` in _wv_shared/deps.ts exposes select, insert,
-- upsert, update and rpc, `authenticated` holds no DELETE grant on any content
-- table, and the only delete in the system is scoped to membership.
--
-- Soft-deleting instead was considered and rejected. `buildWorldDocument`
-- renders every row it finds, so a row flagged "removed" would still be in the
-- viewer, still in the written tour, and still measured against, while the
-- console reported the correction applied. A delete that does not delete is
-- worse than a refusal.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Deleting one row of world content
--
-- The table name is a parameter, which is a thing to be careful with, so it is
-- resolved through a CASE over an allowlist and never interpolated. Three
-- tables can be deleted from and no others: a surface or an opening is
-- geometry the reconstruction derived and is not an operator's to remove, and
-- a nav node is computed from the walkable grid.
--
-- Every branch filters on world_id as well as id. The handler has already
-- checked membership, but a function that trusts its caller to have done so is
-- one refactor away from being the hole.
--
-- The cascades that make this coherent are already in the schema:
--   wv_surface.room_id        ON DELETE CASCADE  (a room's walls go with it)
--   wv_opening.room_a/room_b  ON DELETE CASCADE  (a door to nowhere is not a door)
--   wv_entity.room_id         ON DELETE SET NULL (the sofa is still in the flat)
--   wv_nav_node.room_id       ON DELETE SET NULL
--   wv_camera.room_id         ON DELETE SET NULL (the photograph was still taken)
--   wv_region.room_id         ON DELETE SET NULL
-- So deleting a room removes the room's own surfaces and the openings into it,
-- and detaches everything that merely referred to it. That is the right
-- shape: an operator deleting a phantom room created by a mirror should not
-- also delete the real sofa the reconstruction put inside it.
-- ---------------------------------------------------------------------------

create or replace function wv_delete_world_row(p_world uuid, p_table text, p_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_rows integer;
begin
  case p_table
    when 'wv_room'   then delete from wv_room   where id = p_id and world_id = p_world;
    when 'wv_entity' then delete from wv_entity where id = p_id and world_id = p_world;
    when 'wv_region' then delete from wv_region where id = p_id and world_id = p_world;
    else
      raise exception 'wv_delete_world_row: % is not a table an operator may delete from', p_table
        using errcode = 'invalid_parameter_value';
  end case;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

revoke execute on function wv_delete_world_row(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function wv_delete_world_row(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Who put this region here
--
-- `region.clear` is documented as "remove the operator-added coverage note",
-- and that rule needs the server to be able to tell an operator's note from a
-- survey gap the pipeline recorded. It could not: wv_region.id is a uuid and
-- carries no origin. Without this column the handler either refuses every
-- clear or lets an operator delete the record that a camera never looked
-- behind the wardrobe -- and that record is exactly the kind the product
-- exists to preserve. A gap the pipeline found needs a rescan, not a delete.
-- ---------------------------------------------------------------------------

alter table wv_region
  add column if not exists source text not null default 'pipeline'
    check (source in ('pipeline', 'operator'));

comment on column wv_region.source is
  'Who recorded this volume. Only an ''operator'' region may be withdrawn through approve_corrections; a ''pipeline'' region is a survey fact and needs a rescan.';

-- ---------------------------------------------------------------------------
-- 3. The correction receipt
--
-- provenance.ts rule 4: every correction leaves a receipt in
-- `Grounding.sources`, as `correction:<record id>` and `operator:<who>`. That
-- is how `isHumanCorrected` answers "did a person touch this fact", how a
-- measurement certificate prints "declared by an operator" rather than
-- "measured by the system", and how a rescan can tell which facts were
-- hand-held.
--
-- There was nowhere to put it. wv_room, wv_surface and wv_opening have no
-- sources column, and wv_entity.observed_in is uuid[] -- a correction token is
-- not a camera id and forcing one in there would corrupt the one field that
-- genuinely lists cameras. So the receipt survived only for dimensions, in
-- wv_measurement.basis, and a corrected room NAME looked exactly like a
-- pipeline-written one.
--
-- text[] rather than jsonb because it is a set of opaque tokens that is only
-- ever appended to and scanned by prefix, and because worldDocument.ts renders
-- it straight into Grounding.sources, which is string[].
-- ---------------------------------------------------------------------------

alter table wv_room    add column if not exists correction_sources text[] not null default '{}';
alter table wv_entity  add column if not exists correction_sources text[] not null default '{}';
alter table wv_surface add column if not exists correction_sources text[] not null default '{}';
alter table wv_opening add column if not exists correction_sources text[] not null default '{}';

comment on column wv_room.correction_sources is
  'Receipts for human corrections, as correction:<id> and operator:<who>. Rendered into Grounding.sources. Append-only; never a camera id.';

-- ---------------------------------------------------------------------------
-- 4. Registering the same capture twice
--
-- `register_capture` is called by a phone on a doorstep, over whatever
-- connection the property has. A retry after a timeout must not produce a
-- second wv_capture row for the same uploaded object -- two rows means the
-- pipeline can be handed the same walkthrough twice and the operator sees a
-- capture they did not make.
--
-- Partial, because storage_path is NOT NULL in practice but the index should
-- not be the thing that enforces it.
-- ---------------------------------------------------------------------------

create unique index if not exists wv_capture_object
  on wv_capture (world_id, storage_path)
  where storage_path is not null;
