-- ============================================================================
-- M3XI — the video Library.
--
-- Worlds already have a public Library. Video did not: a clip came back from
-- the Studio, and the only place it lived was a fal.media URL in someone's
-- browser tab. This adds the same shop window for video.
--
-- Publishing is NOT immediate. Anything published here appears on m3xi.com
-- under M3XI's name, so a human approves it first. Rows land as 'pending' and
-- only an approved row is readable by the public.
-- ============================================================================

create table if not exists public.m3ix_videos (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid references auth.users(id) on delete set null,
  title         text not null default 'Untitled',
  prompt        text,
  video_url     text not null,
  poster_url    text,
  duration_secs numeric,
  width         int,
  height        int,
  aspect        text,
  -- 'studio' = a single generated clip, 'editor' = an edited timeline export.
  source        text not null default 'studio',
  -- pending → approved | rejected. 'hidden' is an approved video pulled later.
  status        text not null default 'pending',
  maker_name    text,
  maker_link    text,
  views         int not null default 0,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid,
  review_note   text,
  constraint m3ix_videos_status_ck
    check (status in ('pending','approved','rejected','hidden')),
  constraint m3ix_videos_source_ck
    check (source in ('studio','editor'))
);

create index if not exists m3ix_videos_public_idx
  on public.m3ix_videos (created_at desc)
  where status = 'approved';
create index if not exists m3ix_videos_owner_idx
  on public.m3ix_videos (owner, created_at desc);
create index if not exists m3ix_videos_queue_idx
  on public.m3ix_videos (created_at)
  where status = 'pending';

alter table public.m3ix_videos enable row level security;

-- Read: the world can see approved videos. You can always see your own,
-- whatever state they are in, so "submitted, waiting" is visible to you.
drop policy if exists m3ix_videos_read_approved on public.m3ix_videos;
create policy m3ix_videos_read_approved on public.m3ix_videos
  for select using (status = 'approved');

drop policy if exists m3ix_videos_read_own on public.m3ix_videos;
create policy m3ix_videos_read_own on public.m3ix_videos
  for select using (auth.uid() is not null and owner = auth.uid());

-- Write: nobody, from the client. Every insert and every moderation decision
-- goes through the m3ix-generate edge function using the service role, which
-- is where the admin check lives. Without this, a signed-in user could POST
-- status='approved' straight to PostgREST and skip the queue entirely.
revoke insert, update, delete on public.m3ix_videos from anon, authenticated;

-- A view counter anyone may call, so a play can be recorded without handing
-- out UPDATE on the table.
create or replace function public.m3ix_video_viewed(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.m3ix_videos
     set views = views + 1
   where id = p_id and status = 'approved';
$$;

grant execute on function public.m3ix_video_viewed(uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Where published video actually lives.
--
-- A finished video cannot be published straight from the provider's CDN: those
-- URLs belong to fal, not to us, and the site already learned this the hard way
-- with world covers. The editor uploads the export here first, and the Library
-- only ever links to our own bucket.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos','videos', true, 314572800, array['video/mp4','video/webm','image/jpeg','image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone may read (the bucket is the public Library's file store).
drop policy if exists m3ix_videos_obj_read on storage.objects;
create policy m3ix_videos_obj_read on storage.objects
  for select using (bucket_id = 'videos');

-- You may only write inside a folder named after your own user id, so one
-- account can never overwrite another's export.
drop policy if exists m3ix_videos_obj_write on storage.objects;
create policy m3ix_videos_obj_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists m3ix_videos_obj_own on storage.objects;
create policy m3ix_videos_obj_own on storage.objects
  for update to authenticated
  using (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
