-- ===========================================================================
-- World Viewer — tenant isolation.
--
-- Shape: anon reads NOTHING through PostgREST. Public viewing goes through the
-- wv-view edge function, which runs as the service role and returns an
-- allowlisted set of columns. The previous system learned this the hard way —
-- its published worlds' edit keys were readable by the anon role — so here it
-- is the default rather than a later correction.
--
-- Members read their own org's worlds. The only browser-side writes are the
-- operator corrections: rename a room, fix an object, adjust a dimension,
-- approve a redaction. Everything else is written by the pipeline.
-- ===========================================================================

create or replace function wv_is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from wv_member m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create or replace function wv_org_of_world(p_world uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.org_id from wv_world w join wv_property p on p.id = w.property_id where w.id = p_world;
$$;

create or replace function wv_can_write_world(p_world uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select wv_is_member(wv_org_of_world(p_world));
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'wv_org','wv_member','wv_property','wv_world','wv_capture','wv_camera','wv_asset',
    'wv_floor','wv_room','wv_surface','wv_opening','wv_entity','wv_relationship',
    'wv_nav_node','wv_nav_edge','wv_region','wv_measurement','wv_redaction',
    'wv_worker','wv_job','wv_quality','wv_session','wv_event','wv_lead',
    'wv_ai_turn','wv_export'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon', t);
    execute format('revoke all on table %I from authenticated', t);
    execute format('grant select on table %I to authenticated', t);
  end loop;
end $$;

create policy wv_org_read on wv_org for select to authenticated using (wv_is_member(id));
create policy wv_member_read on wv_member for select to authenticated using (wv_is_member(org_id));

grant insert, update, delete on wv_property to authenticated;
create policy wv_property_rw on wv_property for all to authenticated
  using (wv_is_member(org_id)) with check (wv_is_member(org_id));

grant insert, update on wv_world to authenticated;
create policy wv_world_rw on wv_world for all to authenticated
  using (wv_is_member((select org_id from wv_property p where p.id = property_id)))
  with check (wv_is_member((select org_id from wv_property p where p.id = property_id)));

do $$
declare t text;
begin
  foreach t in array array[
    'wv_capture','wv_camera','wv_asset','wv_floor','wv_room','wv_surface','wv_opening',
    'wv_entity','wv_relationship','wv_nav_node','wv_nav_edge','wv_region',
    'wv_measurement','wv_redaction','wv_job','wv_quality','wv_session','wv_event',
    'wv_lead','wv_ai_turn','wv_export'
  ] loop
    execute format(
      'create policy %I on %I for select to authenticated using (wv_can_write_world(world_id))',
      t || '_read', t);
  end loop;
end $$;

grant update on wv_room, wv_entity, wv_opening, wv_surface, wv_redaction to authenticated;
create policy wv_room_fix      on wv_room      for update to authenticated using (wv_can_write_world(world_id)) with check (wv_can_write_world(world_id));
create policy wv_entity_fix    on wv_entity    for update to authenticated using (wv_can_write_world(world_id)) with check (wv_can_write_world(world_id));
create policy wv_opening_fix   on wv_opening   for update to authenticated using (wv_can_write_world(world_id)) with check (wv_can_write_world(world_id));
create policy wv_surface_fix   on wv_surface   for update to authenticated using (wv_can_write_world(world_id)) with check (wv_can_write_world(world_id));
create policy wv_redaction_fix on wv_redaction for update to authenticated using (wv_can_write_world(world_id)) with check (wv_can_write_world(world_id));

-- Called before an AI turn or a build starts, never after. A tenant cannot
-- exceed what they have agreed to spend; viewer chat is the one line item
-- that scales with viewers rather than customers, so it is capped at source.
create or replace function wv_spend_allowed(p_world uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o wv_org; spent numeric; builds integer;
begin
  select * into o from wv_org where id = wv_org_of_world(p_world);
  if o is null then return jsonb_build_object('allowed', false, 'reason', 'no_org'); end if;
  if p_kind = 'ai' then
    select coalesce(sum(t.cost_usd), 0) into spent
      from wv_ai_turn t join wv_world w on w.id = t.world_id
      join wv_property p on p.id = w.property_id
     where p.org_id = o.id and t.at >= date_trunc('month', now());
    if spent * 0.79 >= o.ai_month_cap_gbp then
      return jsonb_build_object('allowed', false, 'reason', 'ai_month_cap', 'spent_usd', spent);
    end if;
  elsif p_kind = 'build' then
    select count(*) into builds
      from wv_job j join wv_world w on w.id = j.world_id
      join wv_property p on p.id = w.property_id
     where p.org_id = o.id and j.stage = 'reconstruct' and j.queued_at >= date_trunc('month', now());
    if builds >= o.build_month_cap then
      return jsonb_build_object('allowed', false, 'reason', 'build_month_cap', 'used', builds);
    end if;
  end if;
  return jsonb_build_object('allowed', true);
end $$;

-- Postgres grants EXECUTE to PUBLIC by default, so revoking from anon and
-- authenticated alone leaves a function callable as an RPC.
revoke execute on function wv_is_member(uuid)       from public;
revoke execute on function wv_org_of_world(uuid)    from public;
revoke execute on function wv_can_write_world(uuid) from public;
revoke execute on function wv_spend_allowed(uuid, text) from public;

-- RLS predicates are evaluated as the querying role, so a signed-in user must
-- be able to execute the functions their own policies call.
grant execute on function wv_is_member(uuid)       to authenticated;
grant execute on function wv_org_of_world(uuid)    to authenticated;
grant execute on function wv_can_write_world(uuid) to authenticated;
grant execute on function wv_spend_allowed(uuid, text) to service_role;

comment on table wv_worker is
  'Pipeline workers. RLS enabled with no policy by design: service_role only.';
