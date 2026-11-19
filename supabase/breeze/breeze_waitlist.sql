-- Breeze waitlist (the m3xi.com homepage).
--
-- NOT part of supabase/migrations: those belong to the M3XI-Studio project.
-- This runs on the BREEZE Supabase project (ref eteqjblzumzgsvwhkxep), the one
-- src/breeze.js posts to. Run it once in that project's SQL editor.
--
-- The site posts with the publishable key, so the public may INSERT an email
-- and a source and nothing else: no reading, changing or removing rows.
-- Reading is for the dashboard (service role) only.

create table if not exists public.breeze_waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  source     text,
  created_at timestamptz not null default now(),
  constraint breeze_waitlist_email_chk  check (email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(email) <= 320),
  constraint breeze_waitlist_source_chk check (source is null or length(source) <= 120),
  constraint breeze_waitlist_email_uq   unique (email)
);

comment on table public.breeze_waitlist is 'Breeze waitlist signups from m3xi.com. email is unique (a repeat signup is a clean 409); source is the utm_source of the visit, e.g. which TikTok video.';

-- Normalise before the unique check so "Me@X.com " and "me@x.com" are one person.
create or replace function public.breeze_waitlist_normalise()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.email  := lower(trim(new.email));
  new.source := nullif(lower(trim(new.source)), '');
  return new;
end $$;

drop trigger if exists breeze_waitlist_normalise on public.breeze_waitlist;
create trigger breeze_waitlist_normalise
  before insert on public.breeze_waitlist
  for each row execute function public.breeze_waitlist_normalise();

create index if not exists breeze_waitlist_source_created_idx on public.breeze_waitlist (source, created_at desc);

alter table public.breeze_waitlist enable row level security;

-- Insert only, and only the two columns a visitor supplies.
revoke all on public.breeze_waitlist from anon, authenticated;
grant insert (email, source) on public.breeze_waitlist to anon, authenticated;

drop policy if exists "anyone can join the breeze waitlist" on public.breeze_waitlist;
create policy "anyone can join the breeze waitlist"
  on public.breeze_waitlist for insert
  to anon, authenticated
  with check (true);

revoke execute on function public.breeze_waitlist_normalise() from public, anon, authenticated;

-- Signups per source (which TikTok video), for the dashboard:
--   select coalesce(source, '(none)') as source, count(*) from public.breeze_waitlist group by 1 order by 2 desc;
