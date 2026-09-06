-- =============================================================================
-- Dawaee — 0030: the definer privilege model, as a requirement of the schema
--
-- This migration adds no table and no column. It turns a property the system
-- has always depended on into one the database refuses to be without.
--
-- THE DEFECT THIS CLOSES (measured, P18)
--
-- Under FORCE ROW LEVEL SECURITY the table owner is not exempt from its own
-- policies. Every `app.*` SECURITY DEFINER function runs as that owner. On a
-- managed PostgreSQL — where the migration role is neither a superuser nor
-- BYPASSRLS, which 0008's own comment names as the deployment target — a
-- definer function therefore cannot touch a FORCE-RLS table that has no policy
-- naming the owner.
--
-- 0008 granted that exemption for seven tables, listed by hand. Twenty tables
-- created afterwards were never added to the list. Two consequences were
-- reproduced on a database whose owner had `rolsuper = false` and
-- `rolbypassrls = false`, and only differed from the test database by those two
-- attributes:
--
--   1. `POST /v1/auth/register` -> 404. `app.register_with_password` cannot
--      INSERT `user_credentials`: SQLSTATE 42501. The product is unusable from
--      its first request. All 1013 tests passed anyway, because the test
--      database was owned by a superuser.
--
--   2. Upgrading a populated 0019 database aborted at 0025. Its dedup DELETE on
--      `dose_events` matched zero rows — no error, because RLS filtering a
--      DELETE to nothing is not an error — and `CREATE UNIQUE INDEX` then
--      failed on duplicate keys, leaving 0020-0024 committed and the deploy
--      half-applied.
--
-- WHY THE SWEEP LIVES IN `db/maintenance/definer_policies.sql`
--
-- Consequence 2 is a migration that sorts BEFORE this one. Nothing numbered
-- 0030 can rescue 0025, and the same is true of the backfills in 0016 and 0017
-- for a database restored from an older dump. So the sweep runs as a deploy
-- preflight, before any pending migration, and again after the run. This
-- migration is where it stops being a convenience of the deploy script and
-- becomes a condition the schema asserts.
--
-- WHAT IS DELIBERATELY *NOT* DONE HERE
--
--   * FORCE ROW LEVEL SECURITY is not relaxed anywhere. Asserted below.
--   * No policy is granted TO PUBLIC. Asserted below.
--   * No runtime role gains anything. `dawaee_app` and `dawaee_worker` keep
--     exactly the policies and grants they had, and the assertions below fail
--     the migration if either could reach the definer path.
-- =============================================================================

-- --------------------------------------------------- 1. the sweep has run
--
-- Deliberately an assertion rather than a definition. If the deploy did not run
-- the preflight, the database may already have been damaged by an earlier
-- migration's DML silently matching nothing, and the right outcome is a loud
-- stop rather than a late repair.
DO $$
BEGIN
  IF to_regprocedure('app.ensure_definer_policies()') IS NULL THEN
    RAISE EXCEPTION 'app.ensure_definer_policies() is missing'
      USING HINT = 'Apply db/maintenance/definer_policies.sql before migrating. '
                   'scripts/migrate.sh and scripts/db-reset.sh both do this; a '
                   'hand-run psql loop does not.';
  END IF;
END $$;

-- Idempotent, and covers anything created by 0020-0029 in this same run.
SELECT count(*) FROM app.ensure_definer_policies();

-- ------------------------------------- 2. every forced table is covered
DO $$
DECLARE
  uncovered text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO uncovered
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relforcerowsecurity
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = c.relname
          AND p.policyname = c.relname || '_definer');

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'FORCE ROW LEVEL SECURITY table(s) with no definer policy: %', uncovered
      USING HINT = 'Every SECURITY DEFINER function would be denied on these.';
  END IF;
END $$;

-- ----------------------------------------- 3. the exemption is contained
--
-- The whole security argument for `USING (true)` is that it reaches one role
-- that already owns the tables, and that no runtime role can become it. Both
-- halves are checked; either failing aborts the migration.
DO $$
DECLARE
  leak text;
  runtime_role text;
BEGIN
  -- 3a. No definer policy may name anything but a single non-runtime role.
  SELECT string_agg(format('%s.%s -> %s', tablename, policyname, roles::text), '; ')
    INTO leak
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname LIKE '%\_definer'
     AND (roles::text[] && ARRAY['public', 'dawaee_app', 'dawaee_worker']
          OR array_length(roles::text[], 1) <> 1);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'definer policy reaches PUBLIC or a runtime role: %', leak;
  END IF;

  -- 3b. NO policy anywhere in `public` may be granted to PUBLIC. A permissive
  -- PUBLIC policy would union with every role's own policies and silently undo
  -- the whole tenancy model.
  SELECT string_agg(format('%s.%s', tablename, policyname), ', ')
    INTO leak
    FROM pg_policies
   WHERE schemaname = 'public' AND roles::text[] @> ARRAY['public'];
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'policy granted TO PUBLIC: %', leak;
  END IF;

  -- 3c. Neither runtime role may become the owner, by membership or by SET ROLE.
  --
  -- The reverse direction is allowed and is needed: PostgreSQL 16 requires the
  -- migration role to hold ADMIN on the runtime roles to set their passwords.
  -- It is granted WITH INHERIT FALSE, SET FALSE, so the owner administers those
  -- roles without inheriting their privileges or their policies — measured,
  -- because plain membership made the owner read `dose_events` through
  -- dawaee_worker's policy and silently disarmed a negative control.
  FOREACH runtime_role IN ARRAY ARRAY['dawaee_app', 'dawaee_worker'] LOOP
    IF pg_has_role(runtime_role, current_user, 'MEMBER')
       OR pg_has_role(runtime_role, current_user, 'SET') THEN
      RAISE EXCEPTION '% can become %', runtime_role, current_user;
    END IF;
    IF pg_has_role(current_user, runtime_role, 'USAGE') THEN
      RAISE EXCEPTION
        '% inherits the privileges of %', current_user, runtime_role
        USING HINT = 'GRANT ... WITH ADMIN TRUE, INHERIT FALSE, SET FALSE.';
    END IF;
  END LOOP;

  -- 3d. And neither may hold the attributes that would make policies moot.
  SELECT string_agg(rolname, ', ') INTO leak
    FROM pg_roles
   WHERE rolname IN ('dawaee_app', 'dawaee_worker')
     AND (rolsuper OR rolbypassrls);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'runtime role(s) can bypass row-level security: %', leak;
  END IF;
END $$;

-- --------------------------------- 4. nothing quietly stopped forcing RLS
--
-- `ENABLE` without `FORCE` exempts the owner, which is precisely the state this
-- model reasons about. A table that has one but not the other is either a
-- mistake or a decision nobody wrote down.
DO $$
DECLARE
  unforced text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unforced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF unforced IS NOT NULL THEN
    RAISE EXCEPTION
      'table(s) enable row-level security without forcing it: %', unforced
      USING HINT = 'The owner is exempt on those, which defeats the model.';
  END IF;
END $$;

-- ------------------------------------- 5. the definer functions still run
--
-- The assertions above are about the catalogue. This one is about behaviour:
-- call the read-side predicates as the current role and require that they
-- answer rather than raise. A denial here means the exemption did not take.
DO $$
DECLARE
  probe uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  PERFORM app.owns_profile(probe);
  PERFORM app.caregives_profile(probe);
  PERFORM app.can_read_profile(probe);
  PERFORM app.password_hash_for_user(probe);
  PERFORM app.session_is_live(probe);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION
    'a SECURITY DEFINER predicate was denied by row-level security'
    USING HINT = 'The definer policies exist but do not reach the function owner.';
END $$;

COMMENT ON SCHEMA app IS
  'SECURITY DEFINER auth and access plane. Every function here runs as the '
  'schema owner, which is exempt from FORCE ROW LEVEL SECURITY only through '
  'the per-table `<table>_definer` policies maintained by '
  'app.ensure_definer_policies(). No runtime role is a member of that owner, '
  'so the exemption is unreachable from a request.';
