-- ===========================================================================
-- Property tour: Phase 0 (security, leads, lifecycle) + Phase 1 data model.
--
-- Before this migration the tour pipeline was reachable with no identity at
-- all (the edge function checked nothing and used the service role), every
-- published world's edit_key was readable by the anon role, and a lead from a
-- tour could not be recorded at all. This puts the fences where the RLS design
-- already said they should be, and adds the node table that a full-sphere tour
-- needs. Applied 2026-08-21.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. m3ix_spaces: the anon role must not read the table at all. Public reads
--    go through the edge function (service role, column-filtered) and the
--    SECURITY DEFINER RPCs (m3ix_library, m3ix_featured_world). Owners still
--    read their own rows (policy "spaces own read" stays).
-- ---------------------------------------------------------------------------
drop policy if exists "public read published spaces" on public.m3ix_spaces;
revoke all on public.m3ix_spaces from anon;
revoke insert, update, delete, truncate, references, trigger on public.m3ix_spaces from authenticated;
grant select on public.m3ix_spaces to authenticated;

-- ---------------------------------------------------------------------------
-- 2. m3ix_tour: property is mandatory, only org members write, nobody reads
--    view_key through PostgREST. The viewer gets its manifest from the edge
--    function, which decides what a caller may see.
-- ---------------------------------------------------------------------------
delete from public.m3ix_tour where property_id is null;
alter table public.m3ix_tour alter column property_id set not null;
alter table public.m3ix_tour
  add column if not exists archived_at timestamptz,
  add column if not exists spawn jsonb,            -- {node_id, yaw}
  add column if not exists title text;
drop policy if exists tour_owner on public.m3ix_tour;
drop policy if exists tour_public_read on public.m3ix_tour;
create policy tour_org_rw on public.m3ix_tour for all to authenticated
  using (exists (select 1 from public.m3ix_property p where p.id = property_id and public.m3ix_is_org_member(p.org_id)))
  with check (exists (select 1 from public.m3ix_property p where p.id = property_id and public.m3ix_is_org_member(p.org_id)));
revoke all on public.m3ix_tour from anon;

-- A public projection without the private key, for anything that must read
-- tours through PostgREST (nothing does today; the viewer uses the function).
create or replace view public.m3ix_tour_public as
  select id, property_id, slug, provenance, status, branding, title, published_at, created_at
    from public.m3ix_tour
   where status = 'published';
grant select on public.m3ix_tour_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Rooms: one record per (property, stable_key). The upsert in the build
--    action relied on this without declaring it.
-- ---------------------------------------------------------------------------
create unique index if not exists m3ix_room_property_stable_key
  on public.m3ix_room (property_id, stable_key);

-- ---------------------------------------------------------------------------
-- 4. Leads: a lead belongs to a property/tour (captured tours) or a space
--    (AI worlds). Org members read their own; inserts happen only through the
--    edge functions (service role), never straight from a page.
-- ---------------------------------------------------------------------------
alter table public.m3ix_leads
  add column if not exists property_id uuid references public.m3ix_property(id) on delete set null,
  add column if not exists tour_id     uuid references public.m3ix_tour(id)     on delete set null,
  add column if not exists node_label  text,
  add column if not exists notified_at timestamptz,
  add column if not exists notify_error text;
create index if not exists m3ix_leads_property_id on public.m3ix_leads (property_id);
create index if not exists m3ix_leads_space_id    on public.m3ix_leads (space_id);
drop policy if exists "public insert leads" on public.m3ix_leads;
revoke all on public.m3ix_leads from anon;
revoke insert, update, delete, truncate, references, trigger on public.m3ix_leads from authenticated;
grant select on public.m3ix_leads to authenticated;
drop policy if exists leads_org_read on public.m3ix_leads;
create policy leads_org_read on public.m3ix_leads for select to authenticated
  using (
    (property_id is not null and exists (select 1 from public.m3ix_property p where p.id = property_id and public.m3ix_is_org_member(p.org_id)))
    or
    (space_id is not null and exists (select 1 from public.m3ix_spaces s where s.id = space_id and s.owner_id = auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 5. Lead notification: every insert calls the notify function through
--    pg_net. The function emails the org owner (or records why it could not).
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create table if not exists public.m3ix_config (
  key text primary key,
  value text not null
);
alter table public.m3ix_config enable row level security;   -- no policies: service role only
revoke all on public.m3ix_config from anon, authenticated;

create or replace function public.m3ix_on_lead_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_url text;
  v_key text;
begin
  select value into v_url from public.m3ix_config where key = 'lead_notify_url';
  select value into v_key from public.m3ix_config where key = 'lead_notify_secret';
  if v_url is null or v_key is null then
    update public.m3ix_leads set notify_error = 'lead_notify_url/lead_notify_secret not configured' where id = new.id;
    return new;
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-m3ix-secret', v_key),
    body    := jsonb_build_object('lead_id', new.id)
  );
  return new;
end $$;

drop trigger if exists m3ix_lead_notify on public.m3ix_leads;
create trigger m3ix_lead_notify
  after insert on public.m3ix_leads
  for each row execute function public.m3ix_on_lead_insert();

-- ---------------------------------------------------------------------------
-- 6. Nodes: one full-sphere photograph per standpoint. This is the unit of a
--    Phase 1 tour. Rooms group nodes; pins place them on the agent's plan;
--    north_deg says which way plan-north is in the image; links say where you
--    can walk to.
-- ---------------------------------------------------------------------------
create table if not exists public.m3ix_node (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.m3ix_property(id) on delete cascade,
  room_id      uuid references public.m3ix_room(id) on delete set null,
  capture_id   uuid references public.m3ix_capture(id) on delete set null,
  stable_key   text not null,
  ordinal      integer not null default 0,
  label        text,
  pano_path    text not null,                 -- object path in the private 'tours' bucket
  preview_path text,                          -- downscaled copy for first paint
  width        integer,
  height       integer,
  bytes        bigint,
  sha256       text,
  source       text not null default '360-camera'
               check (source in ('360-camera', 'phone-photosphere', 'other')),
  pin          jsonb,                         -- {x, y} as fractions of the floorplan image
  north_deg    double precision,              -- yaw (deg) in the image that points to plan-north; null = uncalibrated
  links        uuid[] not null default '{}',
  captured_at  timestamptz,
  edited_at    timestamptz,
  status       text not null default 'active' check (status in ('active', 'superseded', 'deleted')),
  created_at   timestamptz not null default now(),
  unique (property_id, stable_key)
);
create index if not exists m3ix_node_property on public.m3ix_node (property_id, status, ordinal);
alter table public.m3ix_node enable row level security;
drop policy if exists node_org_rw on public.m3ix_node;
create policy node_org_rw on public.m3ix_node for all to authenticated
  using (exists (select 1 from public.m3ix_property p where p.id = property_id and public.m3ix_is_org_member(p.org_id)))
  with check (exists (select 1 from public.m3ix_property p where p.id = property_id and public.m3ix_is_org_member(p.org_id)));
revoke all on public.m3ix_node from anon;

-- A room may carry one real scan (Phase 2). Facts are computed once, offline.
alter table public.m3ix_room
  add column if not exists scan jsonb;        -- {path, format, bytes, sha256, facts:{up, floor_y, spawn, scale, navmesh_path}, scanned_at}

-- ---------------------------------------------------------------------------
-- 7. Private bucket for everything a tour is made of. Objects are served by
--    short-lived signed URLs minted in the manifest action; nothing is public.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tours', 'tours', false, 262144000, null)
on conflict (id) do update set public = false, file_size_limit = 262144000;
