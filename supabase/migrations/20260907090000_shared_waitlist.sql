-- Shared waitlist for every M3XI product, one row per (email, product).
-- Each product is its own list: the same address can join Cornelia, CallMe and
-- AutoUV separately, and counts/exports are per product. The site posts here
-- with the publishable key, so anon may INSERT and nothing else; reading is
-- for the dashboard (service role) only.

create table if not exists public.m3ix_waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  product     text not null,
  name        text,
  source      text not null default 'website',
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint m3ix_waitlist_email_chk   check (email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(email) <= 320),
  constraint m3ix_waitlist_name_chk    check (name is null or length(name) <= 120),
  constraint m3ix_waitlist_product_chk check (product in ('cornelia','callme','autouv','ai-stories','ugc','studio','spatial')),
  constraint m3ix_waitlist_email_product_uq unique (email, product)
);

comment on table public.m3ix_waitlist is 'Product waitlists. One list per product; (email, product) is unique so a duplicate signup is a clean 409, never a second row.';

-- Normalise before the unique check so "Me@X.com " and "me@x.com" are one person.
create or replace function public.m3ix_waitlist_normalise()
returns trigger language plpgsql as $$
begin
  new.email   := lower(trim(new.email));
  new.product := lower(trim(new.product));
  if new.name is not null then new.name := nullif(trim(new.name), ''); end if;
  return new;
end $$;

drop trigger if exists m3ix_waitlist_normalise on public.m3ix_waitlist;
create trigger m3ix_waitlist_normalise
  before insert or update on public.m3ix_waitlist
  for each row execute function public.m3ix_waitlist_normalise();

create index if not exists m3ix_waitlist_product_created_idx on public.m3ix_waitlist (product, created_at desc);

alter table public.m3ix_waitlist enable row level security;

-- The publishable key may add a row. It may not read, change or remove one.
revoke all on public.m3ix_waitlist from anon, authenticated;
grant insert on public.m3ix_waitlist to anon, authenticated;

drop policy if exists "anyone can join a waitlist" on public.m3ix_waitlist;
create policy "anyone can join a waitlist"
  on public.m3ix_waitlist for insert
  to anon, authenticated
  with check (true);

-- Per-product headcounts for the owner. Not exposed to the API roles.
create or replace view public.m3ix_waitlist_summary
  with (security_invoker = true) as
  select product,
         count(*)                                   as signups,
         min(created_at)                            as first_signup,
         max(created_at)                            as latest_signup,
         count(*) filter (where created_at > now() - interval '7 days') as last_7_days
  from public.m3ix_waitlist
  group by product
  order by signups desc;

revoke all on public.m3ix_waitlist_summary from anon, authenticated;
