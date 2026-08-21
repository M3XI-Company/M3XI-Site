-- The Library must be able to say which worlds were generated. Same function,
-- one more column; callers that ignore it are unaffected. Applied 2026-08-21.
drop function if exists public.m3ix_library(integer);
create or replace function public.m3ix_library(p_limit integer default 48)
returns table(slug text, title text, cover text, likes bigint, liked boolean, username text, avatar text, socials jsonb, created_at timestamptz, source text)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select s.embed_slug,
         s.title,
         s.world->>'cover',
         coalesce(l.n, 0),
         case when auth.uid() is null then false
              else exists(select 1 from public.m3ix_likes k
                           where k.slug = s.embed_slug and k.user_id = auth.uid()) end,
         a.username, a.avatar, coalesce(a.socials, '{}'::jsonb),
         s.created_at,
         s.source
    from public.m3ix_spaces s
    left join (select slug, count(*) n from public.m3ix_likes group by slug) l
           on l.slug = s.embed_slug
    left join public.m3ix_accounts a on a.user_id = s.owner_id
   where s.status = 'published'
   order by s.created_at desc
   limit greatest(1, least(coalesce(p_limit,48), 200));
$$;
grant execute on function public.m3ix_library(integer) to anon, authenticated;
