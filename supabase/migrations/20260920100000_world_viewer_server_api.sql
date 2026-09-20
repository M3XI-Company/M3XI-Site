-- ===========================================================================
-- World Viewer — the database half of the server API.
--
-- `wv-worlds/handler.ts` already calls every function and reads every column
-- below. None of them existed, so member management 500'd on a missing RPC,
-- the console displayed raw user ids because `wv_member` had no email, and the
-- publish gate's `lastCorrectionAt` was structurally dead: the correctable
-- tables had no `updated_at`, so the state that says "this world was changed
-- after it was last assessed" could never fire.
--
-- Also here, because each is the same class of fault — a live system pointing
-- at something that is not there:
--   * the build cap counted a stage that no longer exists, so it never fired;
--   * the three storage buckets every asset path names were never created;
--   * `storage.objects` had no policy for them, so the console — which signs
--     as the signed-in member, not as the service role — could not read a
--     single asset it is entitled to.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Member identity
--
-- The console shows people, not uuids. `auth.users` is not readable by
-- `authenticated` and must stay that way, so the address is denormalised onto
-- the membership row, filled by a trigger rather than by whoever happens to be
-- inserting, and kept in step when somebody changes it.
-- ---------------------------------------------------------------------------

alter table wv_member add column if not exists email text;

comment on column wv_member.email is
  'Denormalised from auth.users so a member list needs no access to it. Maintained by trigger; never the authority for identity, which is user_id.';

create or replace function wv_member_fill_email()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  -- The caller may pass the address it just looked up; when it does not, or
  -- passes a blank, the row still arrives complete.
  if new.email is null or btrim(new.email) = '' then
    select u.email into new.email from auth.users u where u.id = new.user_id;
  else
    new.email := lower(btrim(new.email));
  end if;
  return new;
end $$;

drop trigger if exists wv_member_email_fill on wv_member;
create trigger wv_member_email_fill
  before insert or update of user_id, email on wv_member
  for each row execute function wv_member_fill_email();

-- An address that changes in auth must not leave a stale copy behind in every
-- org the person belongs to. This is why the column is a cache and not a fact.
create or replace function wv_member_sync_email()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  update wv_member m
     set email = new.email
   where m.user_id = new.id
     and m.email is distinct from new.email;
  return null;
end $$;

drop trigger if exists wv_member_email_sync on auth.users;
create trigger wv_member_email_sync
  after update of email on auth.users
  for each row execute function wv_member_sync_email();

update wv_member m
   set email = u.email
  from auth.users u
 where u.id = m.user_id and m.email is distinct from u.email;

-- ---------------------------------------------------------------------------
-- 2. The two writes membership needs, as functions rather than as grants
--
-- `wv_member` is select-only to `authenticated` and stays that way: a member
-- who could write the table could promote themselves. Both functions are
-- service-role only and decide nothing — the rules (an org keeps an owner,
-- nobody promotes themselves, nobody acts on someone senior) live in
-- wv-worlds/handler.ts, where they are tested.
-- ---------------------------------------------------------------------------

-- The ONLY thing in this system that reads auth.users on behalf of a caller.
-- It returns an id or nothing, so adding a colleague cannot become a way to
-- ask the platform which addresses have accounts.
create or replace function wv_user_id_by_email(p_email text)
returns uuid language sql stable security definer set search_path = public, auth as $$
  select u.id from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
$$;

-- Removal is a hard delete. Every membership predicate in ..._rls.sql asks
-- only whether a row exists, so a soft flag would fail open on the first
-- policy that forgot to test it.
create or replace function wv_remove_member(p_org uuid, p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_rows integer;
begin
  delete from wv_member where org_id = p_org and user_id = p_user;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

revoke execute on function wv_user_id_by_email(text) from public, anon, authenticated;
revoke execute on function wv_remove_member(uuid, uuid) from public, anon, authenticated;
revoke execute on function wv_member_fill_email() from public, anon, authenticated;
revoke execute on function wv_member_sync_email() from public, anon, authenticated;
grant execute on function wv_user_id_by_email(text) to service_role;
grant execute on function wv_remove_member(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. When was this world last corrected?
--
-- The publish gate has a `stale` state — a quality report written BEFORE a
-- correction describes a world that no longer exists — and no column could
-- answer it. It is a trigger rather than application code because
-- ..._rls.sql grants UPDATE on these four tables directly to `authenticated`:
-- a correction can arrive over PostgREST without an edge function ever seeing
-- it, and an invalidation that only fires in a handler would be silently wrong
-- for exactly the writes this design exists to support.
--
-- Row-level, not statement-level: it sets NEW on the row being written.
-- ---------------------------------------------------------------------------

alter table wv_room    add column if not exists updated_at timestamptz not null default now();
alter table wv_entity  add column if not exists updated_at timestamptz not null default now();
alter table wv_opening add column if not exists updated_at timestamptz not null default now();
alter table wv_surface add column if not exists updated_at timestamptz not null default now();

create or replace function wv_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['wv_room','wv_entity','wv_opening','wv_surface'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before update on %I for each row execute function wv_touch_updated_at()',
      t || '_touch', t);
    -- One index-only lookup per table answers "most recent correction".
    execute format(
      'create index if not exists %I on %I (world_id, updated_at desc)',
      t || '_corrected', t);
  end loop;
end $$;

revoke execute on function wv_touch_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The build cap, counting a stage that exists
--
-- It counted `reconstruct`, which was retired with the old pipeline: the count
-- was always zero, so an org could queue builds without limit and the ceiling
-- an operator agreed to meant nothing.
--
-- `splat` replaces it because it is the stage the money is actually spent on:
-- it is queued exactly once per build, it is the longest GPU hold in the DAG
-- (~15 of the ~35 GPU-minutes), and it is the earliest point at which the GPU
-- hour is committed. Counting `ingest` would count captures that never reached
-- a GPU; counting `quality` would count only builds that already finished, so
-- the cap would never stop the build that breaks it.
-- ---------------------------------------------------------------------------

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
     where p.org_id = o.id and j.stage = 'splat' and j.queued_at >= date_trunc('month', now());
    if builds >= o.build_month_cap then
      return jsonb_build_object('allowed', false, 'reason', 'build_month_cap', 'used', builds);
    end if;
  end if;
  return jsonb_build_object('allowed', true);
end $$;

revoke execute on function wv_spend_allowed(uuid, text) from public, anon, authenticated;
grant execute on function wv_spend_allowed(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Portfolio search
--
-- `listProperties` searches label, ref and postcode with ILIKE. Without a
-- trigram index that is a sequential scan of every property in the table on
-- every keystroke, and it degrades with the customer's own success.
-- ---------------------------------------------------------------------------

create extension if not exists pg_trgm;

create index if not exists wv_property_label_trgm    on wv_property using gin (label gin_trgm_ops);
create index if not exists wv_property_ref_trgm      on wv_property using gin (ref gin_trgm_ops);
create index if not exists wv_property_postcode_trgm on wv_property using gin (postcode gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 6. Storage
--
-- Three buckets the code has always named and none of which existed:
--
--   wv-assets    splats, meshes, floorplans, covers, the rendered world.json.
--   wv-exports   the customer's permanence bundle.
--   wv-captures  the raw walkthrough video the capture app uploads.
--
-- All private. A splat is a photographic record of the inside of somebody's
-- home; an unguessable path is not an access control. Readers get short-lived
-- signed URLs, and the object prefix is always the world id, which is what
-- makes the policies below expressible at all.
--
-- The size limits are the real ones: a 5-minute 4K walkthrough is 1.7-3.8 GB,
-- and a packaged world with chunked splats runs to a few hundred megabytes.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('wv-assets',   'wv-assets',   false,  2147483648),   -- 2 GiB per object
  ('wv-exports',  'wv-exports',  false,  5368709120),   -- 5 GiB bundle
  ('wv-captures', 'wv-captures', false,  5368709120)    -- 5 GiB source video
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- The console and the capture app act as the signed-in member, not as the
-- service role, so these buckets need policies or every read they are entitled
-- to returns 400 and the console silently falls back to reassembling worlds
-- from thirteen selects.
--
-- `(storage.foldername(name))[1]` is the world id, which every writer in this
-- system prepends and none of them lets a caller choose. `safe_uuid` returns
-- null rather than raising on a malformed prefix, and `wv_can_write_world`
-- returns null for a null world, so a junk path denies rather than errors.

drop policy if exists wv_objects_read   on storage.objects;
drop policy if exists wv_capture_upload on storage.objects;
drop policy if exists wv_capture_resume on storage.objects;

create policy wv_objects_read on storage.objects for select to authenticated
  using (
    bucket_id in ('wv-assets', 'wv-exports', 'wv-captures')
    and wv_can_write_world(safe_uuid((storage.foldername(name))[1]))
  );

-- The capture app uploads the walkthrough itself: a 2 GB video through an edge
-- function is not a thing that works. It may write into a world it belongs to
-- and nowhere else.
create policy wv_capture_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'wv-captures'
    and wv_can_write_world(safe_uuid((storage.foldername(name))[1]))
  );

-- Resumable (TUS) uploads PATCH the same object as they progress, so the
-- upload that survives a lift journey needs UPDATE as well as INSERT.
create policy wv_capture_resume on storage.objects for update to authenticated
  using (
    bucket_id = 'wv-captures'
    and wv_can_write_world(safe_uuid((storage.foldername(name))[1]))
  )
  with check (
    bucket_id = 'wv-captures'
    and wv_can_write_world(safe_uuid((storage.foldername(name))[1]))
  );
