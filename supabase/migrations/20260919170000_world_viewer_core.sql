-- ===========================================================================
-- World Viewer — core spatial schema.
--
-- A world is not a file. It is a versioned, tenant-scoped spatial database in
-- which every fact carries where it came from and how much we trust it. The
-- asset files (splats, meshes, point clouds) are the *payload*; this schema is
-- the world itself.
--
-- Deliberately no PostGIS. Geometry solving happens in the spatial engine,
-- which runs identically in the browser, in the worker and on the server;
-- SQL is the index, not the solver. That also keeps a self-hosted export
-- runnable on stock Postgres, which the permanence promise requires.
--
-- Units: metres, radians, SI throughout. Positions are [x, y, z] with +Y up
-- in a right-handed world frame whose origin is the property's ground datum.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Vocabularies
-- --------------------------------------------------------------------------

-- The distinction the whole product rests on. A camera saw it; geometry
-- derived it; a model guessed it; a model invented it. Never collapse these.
create type wv_provenance as enum ('observed', 'reconstructed', 'inferred', 'generated');

create type wv_world_status as enum ('draft', 'capturing', 'processing', 'review', 'published', 'failed', 'archived');
create type wv_job_status   as enum ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled');
create type wv_room_kind    as enum ('living', 'kitchen', 'bedroom', 'bathroom', 'wc', 'hall', 'landing', 'stairwell', 'utility', 'storage', 'office', 'dining', 'conservatory', 'garage', 'balcony', 'garden', 'exterior', 'unknown');
create type wv_surface_kind as enum ('wall', 'floor', 'ceiling', 'soffit', 'column', 'unknown');
create type wv_opening_kind as enum ('door', 'doorway', 'window', 'rooflight', 'stair', 'hatch', 'arch');
create type wv_asset_role   as enum ('splat', 'splat_chunk', 'proxy_mesh', 'visual_mesh', 'pointcloud', 'floorplan', 'cover', 'depth_archive', 'source_media', 'export_bundle');
create type wv_member_role  as enum ('owner', 'admin', 'operator', 'viewer');
create type wv_ai_tier      as enum ('deterministic', 'small', 'large');

-- --------------------------------------------------------------------------
-- Tenancy
-- --------------------------------------------------------------------------

create table wv_org (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  -- Spend ceilings are per-org and enforced before work starts, never after.
  -- An unmetered viewer chat on a popular listing is the one thing that can
  -- outrun this product's unit economics.
  ai_month_cap_gbp     numeric(10,2) not null default 25.00,
  build_month_cap      integer       not null default 50,
  ai_turns_per_session integer       not null default 25,
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table wv_member (
  org_id     uuid not null references wv_org(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       wv_member_role not null default 'operator',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index wv_member_user on wv_member (user_id);

-- --------------------------------------------------------------------------
-- Property and world versions
-- --------------------------------------------------------------------------

create table wv_property (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references wv_org(id) on delete cascade,
  ref         text,                        -- the agency's own listing reference
  label       text not null,
  address     jsonb not null default '{}'::jsonb,
  postcode    text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index wv_property_org on wv_property (org_id) where archived_at is null;
create unique index wv_property_org_ref on wv_property (org_id, ref) where ref is not null;

-- A rescan makes a new version. The old one is never destroyed: an agent must
-- be able to show what a listing looked like on the day someone acted on it.
create table wv_world (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references wv_property(id) on delete cascade,
  version       integer not null,
  status        wv_world_status not null default 'draft',
  -- Set once the quality gate passes. Publishing is a decision, not a default.
  published_at  timestamptz,
  quality_score numeric(4,3),
  -- Carried forward from the previous version so entity ids survive a rescan
  -- where matching succeeds.
  supersedes_id uuid references wv_world(id) on delete set null,
  scale_source  text,                      -- which estimator fixed metric scale
  scale_agreement numeric(5,4),            -- cross-estimator agreement, 0..1
  slug          text unique,
  created_at    timestamptz not null default now(),
  unique (property_id, version)
);
create index wv_world_property on wv_world (property_id);
create index wv_world_published on wv_world (status) where status = 'published';

-- --------------------------------------------------------------------------
-- Capture and observation
-- --------------------------------------------------------------------------

create table wv_capture (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  kind        text not null,               -- video | photos | lidar | pano
  storage_path text not null,
  bytes       bigint,
  duration_s  numeric(8,2),
  frame_count integer,
  device      jsonb not null default '{}'::jsonb,
  -- Filled by the capture-intelligence stage: coverage, blur, overlap,
  -- lighting, reflective surfaces, unobserved regions.
  coverage    jsonb not null default '{}'::jsonb,
  captured_at timestamptz,
  created_at  timestamptz not null default now()
);
create index wv_capture_world on wv_capture (world_id);

-- Every frame is a posed observation. This is the spatial context: an image is
-- never a standalone image, it is a measurement taken from a known place.
create table wv_camera (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  capture_id  uuid references wv_capture(id) on delete cascade,
  frame_index integer,
  t_ms        integer,
  px numeric(10,5) not null, py numeric(10,5) not null, pz numeric(10,5) not null,
  qx numeric(10,7) not null, qy numeric(10,7) not null, qz numeric(10,7) not null, qw numeric(10,7) not null,
  intrinsics  jsonb not null,              -- {fx, fy, cx, cy, w, h, model, dist[]}
  pose_confidence numeric(4,3),
  sharpness   numeric(6,3),                -- blur rejection keeps this honest
  room_id     uuid,                        -- resolved after room segmentation
  created_at  timestamptz not null default now()
);
create index wv_camera_world on wv_camera (world_id);
create index wv_camera_capture on wv_camera (capture_id, frame_index);

create table wv_asset (
  id           uuid primary key default gen_random_uuid(),
  world_id     uuid not null references wv_world(id) on delete cascade,
  role         wv_asset_role not null,
  format       text not null,              -- spz | sog | ply | glb | laz | svg | webp
  storage_path text not null,
  bytes        bigint,
  checksum     text,
  lod          integer,
  chunk_key    text,                       -- room-or-tile key for progressive load
  splat_count  bigint,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index wv_asset_world_role on wv_asset (world_id, role);
create unique index wv_asset_chunk on wv_asset (world_id, role, chunk_key, lod)
  where chunk_key is not null;

-- --------------------------------------------------------------------------
-- Structure: floors, rooms, surfaces, openings
-- --------------------------------------------------------------------------

create table wv_floor (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  level       integer not null,            -- 0 = ground, -1 = basement
  name        text,
  elevation_m numeric(8,4) not null,
  provenance  wv_provenance not null default 'reconstructed',
  confidence  numeric(4,3),
  unique (world_id, level)
);

create table wv_room (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  floor_id    uuid references wv_floor(id) on delete set null,
  stable_key  text not null,               -- survives a rescan where matching holds
  name        text,
  kind        wv_room_kind not null default 'unknown',
  -- Footprint as an ordered ring of [x, z] metres. The floorplan, the area and
  -- the containment test all read from this one polygon.
  polygon     jsonb not null,
  floor_z     numeric(8,4),
  ceiling_z   numeric(8,4),
  area_m2     numeric(10,4),
  -- A dimension without a declared standard and tolerance is a liability, not
  -- a feature. Nothing leaves this table without all three.
  area_standard  text,                     -- e.g. 'RICS-COMP-GIA' | 'IPMS-3C'
  area_tol_pct   numeric(5,3),
  wall_tol_mm    numeric(7,2),
  provenance  wv_provenance not null default 'reconstructed',
  confidence  numeric(4,3),
  created_at  timestamptz not null default now(),
  unique (world_id, stable_key)
);
create index wv_room_world on wv_room (world_id);

alter table wv_camera
  add constraint wv_camera_room_fk foreign key (room_id) references wv_room(id) on delete set null;

create table wv_surface (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  room_id     uuid references wv_room(id) on delete cascade,
  kind        wv_surface_kind not null,
  -- Plane as {n: [x,y,z], d}. Polygon as an ordered ring of world points.
  plane       jsonb not null,
  polygon     jsonb not null,
  area_m2     numeric(10,4),
  -- Windows blow out and mirrors invent rooms. Flagging them is how the
  -- reconstruction stops trusting its own reflections.
  is_reflective boolean not null default false,
  is_glazed     boolean not null default false,
  provenance  wv_provenance not null default 'reconstructed',
  confidence  numeric(4,3)
);
create index wv_surface_world on wv_surface (world_id);
create index wv_surface_room on wv_surface (room_id);

create table wv_opening (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  kind        wv_opening_kind not null,
  surface_id  uuid references wv_surface(id) on delete set null,
  room_a      uuid references wv_room(id) on delete cascade,
  room_b      uuid references wv_room(id) on delete cascade,
  centre      jsonb not null,              -- [x, y, z]
  normal      jsonb,
  width_m     numeric(7,4),
  height_m    numeric(7,4),
  sill_m      numeric(7,4),
  provenance  wv_provenance not null default 'reconstructed',
  confidence  numeric(4,3)
);
create index wv_opening_world on wv_opening (world_id);
create index wv_opening_rooms on wv_opening (room_a, room_b);

-- --------------------------------------------------------------------------
-- Entities: one sofa is one sofa, across 15 frames and across a rescan
-- --------------------------------------------------------------------------

create table wv_entity (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  stable_key  text not null,
  label       text not null,
  category    text not null,               -- furniture | appliance | fixture | fitting | structure
  room_id     uuid references wv_room(id) on delete set null,
  centroid    jsonb not null,              -- [x, y, z]
  aabb        jsonb not null,              -- {min:[x,y,z], max:[x,y,z]}
  obb         jsonb,                       -- {centre, half:[..], quat:[..]}
  -- Which frames established it. Provenance is not a label, it is a receipt.
  observed_in uuid[] not null default '{}',
  provenance  wv_provenance not null default 'inferred',
  confidence  numeric(4,3),
  attributes  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (world_id, stable_key)
);
create index wv_entity_world on wv_entity (world_id);
create index wv_entity_room on wv_entity (room_id);
create index wv_entity_label on wv_entity (world_id, label);

-- --------------------------------------------------------------------------
-- Scene graph: computed from geometry, never asked of a language model
-- --------------------------------------------------------------------------

create table wv_relationship (
  id           bigserial primary key,
  world_id     uuid not null references wv_world(id) on delete cascade,
  subject_type text not null,              -- room | entity | surface | opening
  subject_id   uuid not null,
  predicate    text not null,              -- inside | contains | adjacent_to | ...
  object_type  text not null,
  object_id    uuid not null,
  value        numeric(10,4),              -- distance for near/far, angle, overlap
  provenance   wv_provenance not null default 'reconstructed',
  confidence   numeric(4,3)
);
create index wv_rel_world on wv_relationship (world_id);
create index wv_rel_subject on wv_relationship (world_id, subject_id, predicate);
create index wv_rel_object on wv_relationship (world_id, object_id, predicate);

-- --------------------------------------------------------------------------
-- Navigation
-- --------------------------------------------------------------------------

create table wv_nav_node (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  room_id     uuid references wv_room(id) on delete set null,
  position    jsonb not null,
  clearance_m numeric(6,3),                -- radius of free space; gates the camera
  is_entrance boolean not null default false,
  is_viewpoint boolean not null default false
);
create index wv_nav_node_world on wv_nav_node (world_id);

create table wv_nav_edge (
  id       bigserial primary key,
  world_id uuid not null references wv_world(id) on delete cascade,
  a        uuid not null references wv_nav_node(id) on delete cascade,
  b        uuid not null references wv_nav_node(id) on delete cascade,
  cost     numeric(8,4) not null,
  width_m  numeric(6,3),
  kind     text not null default 'walk',   -- walk | door | stair
  opening_id uuid references wv_opening(id) on delete set null
);
create index wv_nav_edge_world on wv_nav_edge (world_id);
create index wv_nav_edge_a on wv_nav_edge (a);

-- --------------------------------------------------------------------------
-- What was never seen
--
-- If a camera never looked behind a wall, the system must not quietly behave
-- as though it did. Unobserved and generated volumes are recorded explicitly
-- so the viewer can mark them and the agent can refuse to answer about them.
-- --------------------------------------------------------------------------

create table wv_region (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  provenance  wv_provenance not null,      -- 'observed' | 'inferred' | 'generated'
  volume      jsonb not null,              -- {min:[x,y,z], max:[x,y,z]} or {hull:[...]}
  room_id     uuid references wv_room(id) on delete set null,
  reason      text,
  confidence  numeric(4,3)
);
create index wv_region_world on wv_region (world_id, provenance);

-- --------------------------------------------------------------------------
-- Measurement — always with a standard and a tolerance
-- --------------------------------------------------------------------------

create table wv_measurement (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  kind        text not null,               -- distance | area | height | clearance | fit
  a           jsonb not null,
  b           jsonb,
  value       numeric(12,5) not null,
  unit        text not null default 'm',
  standard    text not null,
  tolerance   numeric(9,4) not null,
  tolerance_unit text not null default 'mm',
  confidence  numeric(4,3) not null,
  -- Every returned dimension must be traceable to the geometry that produced
  -- it, so a measurement certificate can be reissued and defended.
  basis       jsonb not null default '{}'::jsonb,
  session_id  uuid,
  created_at  timestamptz not null default now()
);
create index wv_measurement_world on wv_measurement (world_id);

-- --------------------------------------------------------------------------
-- Privacy: redaction is a pipeline stage, not a plugin
-- --------------------------------------------------------------------------

create table wv_redaction (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  camera_id   uuid references wv_camera(id) on delete cascade,
  kind        text not null,               -- face | document | screen | photo | medication | plate | person_through_window | correspondence
  bbox        jsonb not null,              -- [x, y, w, h] in image pixels
  detector    text not null,
  score       numeric(4,3),
  applied     boolean not null default false,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index wv_redaction_world on wv_redaction (world_id, applied);

-- --------------------------------------------------------------------------
-- Pipeline
-- --------------------------------------------------------------------------

create table wv_worker (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  gpu          text,
  capabilities text[] not null default '{}',
  last_seen    timestamptz,
  created_at   timestamptz not null default now()
);

create table wv_job (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  stage       text not null,
  status      wv_job_status not null default 'queued',
  depends_on  uuid[] not null default '{}',
  worker_id   uuid references wv_worker(id) on delete set null,
  lease_until timestamptz,
  attempt     integer not null default 0,
  params      jsonb not null default '{}'::jsonb,
  result      jsonb not null default '{}'::jsonb,
  gpu_seconds numeric(10,2),
  cost_usd    numeric(10,5),
  error       text,
  queued_at   timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index wv_job_queue on wv_job (status, queued_at) where status in ('queued','leased');
create index wv_job_world on wv_job (world_id, stage);

-- The gate. A world does not become publicly viewable because the pipeline
-- finished; it becomes viewable because it passed.
create table wv_quality (
  id         uuid primary key default gen_random_uuid(),
  world_id   uuid not null references wv_world(id) on delete cascade,
  checks     jsonb not null,               -- {check: {value, threshold, pass}}
  score      numeric(4,3) not null,
  verdict    text not null,                -- pass | review | fail
  created_at timestamptz not null default now()
);
create index wv_quality_world on wv_quality (world_id, created_at desc);

-- --------------------------------------------------------------------------
-- Viewing, leads, AI accounting
-- --------------------------------------------------------------------------

create table wv_session (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references wv_world(id) on delete cascade,
  viewer_key  text not null,
  device      jsonb not null default '{}'::jsonb,
  referrer    text,
  ai_turns    integer not null default 0,
  ai_cost_usd numeric(10,5) not null default 0,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index wv_session_world on wv_session (world_id, started_at desc);

create table wv_event (
  id         bigserial primary key,
  world_id   uuid not null references wv_world(id) on delete cascade,
  session_id uuid references wv_session(id) on delete cascade,
  kind       text not null,                -- enter | room | dwell | measure | ask | lead | exit
  room_id    uuid references wv_room(id) on delete set null,
  payload    jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index wv_event_world on wv_event (world_id, at desc);
create index wv_event_session on wv_event (session_id);

create table wv_lead (
  id         uuid primary key default gen_random_uuid(),
  world_id   uuid not null references wv_world(id) on delete cascade,
  session_id uuid references wv_session(id) on delete set null,
  name       text,
  email      text,
  phone      text,
  message    text,
  created_at timestamptz not null default now()
);
create index wv_lead_world on wv_lead (world_id, created_at desc);

create table wv_ai_turn (
  id           bigserial primary key,
  world_id     uuid not null references wv_world(id) on delete cascade,
  session_id   uuid references wv_session(id) on delete cascade,
  tier         wv_ai_tier not null,
  model        text,
  question     text,
  tools        jsonb not null default '[]'::jsonb,
  grounded     boolean not null default true,
  refused      boolean not null default false,
  in_tokens    integer not null default 0,
  out_tokens   integer not null default 0,
  cached_tokens integer not null default 0,
  cost_usd     numeric(10,6) not null default 0,
  latency_ms   integer,
  at           timestamptz not null default now()
);
create index wv_ai_turn_world on wv_ai_turn (world_id, at desc);
create index wv_ai_turn_tier on wv_ai_turn (tier, at desc);

-- Permanence: the customer's copy, in open formats, that outlives us.
create table wv_export (
  id           uuid primary key default gen_random_uuid(),
  world_id     uuid not null references wv_world(id) on delete cascade,
  storage_path text not null,
  formats      text[] not null,
  bytes        bigint,
  checksum     text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  downloaded_at timestamptz
);
create index wv_export_world on wv_export (world_id, created_at desc);
