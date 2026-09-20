-- ===========================================================================
-- World Viewer — a deleted room must not survive in the scene graph.
--
-- `wv_relationship` is polymorphic: subject_type/subject_id and
-- object_type/object_id address a room, an entity, a surface or an opening, so
-- there is no single foreign key that could carry the delete. The
-- consequence was that deleting a phantom room left its edges behind --
-- "adjacent to", "contains", "near" -- pointing at a row that is gone.
--
-- That is not cosmetic, and waiting for the next build's `graph` stage to
-- rewrite them is not good enough. `buildWorldDocument` renders every
-- relationship row it finds, and the document it renders is what `wv-ask`
-- answers questions from. A buyer asking "what is next to the kitchen" could
-- be told about a room an operator deleted this morning precisely because it
-- never existed -- a mirror's reflection that the reconstruction believed in.
-- The whole product rests on not saying things the world does not support.
--
-- So the edges go at the moment we know they are meaningless: inside the same
-- statement that removes the row, before anything can read the two together.
--
-- The return value deliberately stays the number of CONTENT rows removed (0 or
-- 1), not a total. The caller uses it to tell "deleted" from "somebody else
-- got there first", and folding a variable number of edges into that answer
-- would make 3 mean the same as 1.
-- ===========================================================================

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

  -- Only when something was actually removed. A lost race must not quietly
  -- strip the scene graph of a row that is still there.
  --
  -- Scoped by world_id as well as by id: subject_id and object_id carry no
  -- foreign key, so without it a uuid collision across tenants -- vanishingly
  -- unlikely, but nothing here should depend on that -- would reach another
  -- customer's graph.
  --
  -- wv_region is in the CASE above but never matches below, which is correct:
  -- a coverage note is not a subject or an object in the scene graph.
  if v_rows > 0 then
    delete from wv_relationship
     where world_id = p_world
       and (subject_id = p_id or object_id = p_id);
  end if;

  return v_rows;
end $$;

revoke execute on function wv_delete_world_row(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function wv_delete_world_row(uuid, text, uuid) to service_role;
