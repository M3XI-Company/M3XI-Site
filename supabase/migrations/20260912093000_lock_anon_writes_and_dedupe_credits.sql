-- =============================================================================
-- Lock the anon role out of writing, close the updatable public view, and stop
-- a payment being credited twice.
--
-- WHY THIS EXISTS
--
-- The anon key ships inside every page on m3xi.com, so "the anon role" means
-- "anybody on the internet". A privilege audit of the live project found that
-- role holding INSERT, UPDATE, DELETE and TRUNCATE on around twenty-two tables
-- in `public`, including the credit ledger, the purchase record and the
-- provider-spend record. Row-level security stops a SELECT it has no policy
-- for; it does not stop TRUNCATE, which is a table privilege and ignores RLS
-- entirely. One request could have emptied the ledger.
--
-- These grants were never written down anywhere. They come from
-- ALTER DEFAULT PRIVILEGES having been applied to the schema at some point, so
-- every table created since inherited them. This migration removes them, fixes
-- the default so new tables do not inherit them again, and hands back the one
-- write an anonymous visitor genuinely makes.
--
-- WHAT STAYS WORKING
--   * Every SELECT privilege is left exactly as it was, so nothing that reads
--     can break. RLS continues to decide which rows are visible.
--   * The waitlist form on the public site is the one place a signed-out
--     visitor writes a row, so anon keeps INSERT on m3ix_waitlist.
--   * Everything else the browser writes (likes, profile, post settings) is
--     done by a signed-in user, which is the `authenticated` role, untouched
--     here.
--   * Every edge function uses the service role, which is untouched here.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- 1. Take away every write privilege the anon role holds in `public`. ---------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM anon;

-- 2. Stop new tables inheriting the same thing. -------------------------------
--    Both the table owner and postgres may have set the default, so clear both.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon;

-- 3. Give back the single write an anonymous visitor really makes. ------------
--    public/waitlist.js posts a row from the marketing pages with no account.
DO $$
BEGIN
  IF to_regclass('public.m3ix_waitlist') IS NOT NULL THEN
    EXECUTE 'GRANT INSERT ON public.m3ix_waitlist TO anon';
  END IF;
END $$;

-- 4. The public tour view was writable. ---------------------------------------
--    m3ix_tour_public is a plain projection of m3ix_tour, which makes it an
--    auto-updatable view: PostgreSQL will happily push an UPDATE or DELETE
--    through it to the table underneath, and the view runs as its definer, so
--    the revoke on m3ix_tour did not apply. Reading is the whole point of it;
--    writing through it never was.
DO $$
BEGIN
  IF to_regclass('public.m3ix_tour_public') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.m3ix_tour_public SET (security_barrier = true)';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.m3ix_tour_public FROM anon, authenticated';
  END IF;
END $$;

-- 5. One payment, one credit. --------------------------------------------------
--    m3ix-thanks reads the ledger to see whether a Stripe session has already
--    been credited and inserts if it has not. With no constraint behind it,
--    two loads of the success URL — a prefetch, a double click, or Stripe
--    redirecting twice — can both read "not yet" and both insert. A unique
--    index makes the second one fail instead of paying out again.
--
--    Scoped to the reasons that must happen once per reference, so refunds and
--    ordinary spends (which reuse refs freely) are unaffected. If duplicates
--    already exist the index cannot be built; this reports them rather than
--    failing the migration, so they can be looked at by hand.
DO $$
DECLARE dupes int;
BEGIN
  IF to_regclass('public.m3ix_credit_ledger') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO dupes FROM (
    SELECT ref FROM public.m3ix_credit_ledger
    WHERE ref IS NOT NULL AND reason IN ('purchase','topup','grant','redeem')
    GROUP BY ref HAVING count(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE WARNING 'm3ix_credit_ledger: % reference(s) are already credited more than once; unique index NOT created. Review them, then re-run this migration.', dupes;
  ELSE
    EXECUTE $ix$
      CREATE UNIQUE INDEX IF NOT EXISTS m3ix_credit_ledger_once_per_ref
        ON public.m3ix_credit_ledger (ref)
        WHERE ref IS NOT NULL AND reason IN ('purchase','topup','grant','redeem')
    $ix$;
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- AFTERWARDS, CHECK IT TOOK. Both of these should come back empty:
--
--   SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'anon' AND table_schema = 'public'
--      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
--      AND table_name <> 'm3ix_waitlist';
--
--   SELECT ref, count(*) FROM public.m3ix_credit_ledger
--    WHERE ref IS NOT NULL AND reason IN ('purchase','topup','grant','redeem')
--    GROUP BY ref HAVING count(*) > 1;
--
-- And the waitlist form on m3xi.com should still accept an email.
-- =============================================================================
