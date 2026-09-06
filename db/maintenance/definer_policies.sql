-- =============================================================================
-- Dawaee — the definer privilege path
--
-- WHAT THIS SOLVES
--
-- A SECURITY DEFINER function runs as the role that owns it. Here that is the
-- role that runs migrations, which also owns every table. Under FORCE ROW LEVEL
-- SECURITY the owner is NOT exempt from its own tables' policies, so on a
-- cluster where that role is neither a superuser nor BYPASSRLS — which is every
-- managed PostgreSQL, including the deployment target — a definer function can
-- neither read nor write a table that has no policy naming that role.
--
-- Migration 0008 recognised this and granted the exemption for seven tables,
-- named in a hand-written array. Twenty tables added after 0008 were never
-- added to it. The consequences were measured, not theorised:
--
--   * `app.register_with_password` cannot INSERT `user_credentials`, so
--     registration fails with SQLSTATE 42501 and the product is unusable.
--   * Migration 0025's dedup DELETE on `dose_events` matches ZERO rows —
--     silently, because a DELETE that RLS filters to nothing is not an error —
--     and the CREATE UNIQUE INDEX that follows then fails on duplicate keys,
--     aborting the deploy with migrations 0020-0024 already committed.
--
-- WHY THIS FILE IS NOT A NUMBERED MIGRATION
--
-- The hazard predates the migration that formalises it. `0025` runs before
-- `0030` and needs the policy on `dose_events` to already exist; the same is
-- true of the backfills in `0016` and `0017` for any database restored from a
-- dump taken before them. A numbered migration cannot fix a migration that
-- sorts earlier. So this runs as a deploy-time preflight, before any pending
-- migration is applied, and again afterwards to cover tables the run just
-- created. `0030_definer_privilege_model.sql` is where the invariant becomes a
-- hard, reviewable requirement of the schema.
--
-- WHY THE POLICY IS `USING (true)` AND WHY THAT IS NOT A WEAKENING
--
-- The grantee is the role that already owns the tables. It can `ALTER TABLE
-- ... DISABLE ROW LEVEL SECURITY` at will; no policy can constrain it, and
-- pretending otherwise would be theatre. What matters is that the exemption
-- reaches exactly that role and nothing else:
--
--   * the policy names one role — never PUBLIC, never a runtime role;
--   * `dawaee_app` and `dawaee_worker` are not that role, and are not members
--     of it, so neither can `SET ROLE` to it;
--   * every policy that constrains `dawaee_app` and `dawaee_worker` is
--     untouched, and FORCE ROW LEVEL SECURITY stays on for every table.
--
-- The assertions below refuse to run at all if any of that is false.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS app;

-- --------------------------------------------------------------- containment
--
-- Refuse before creating anything if the caller is a role the exemption must
-- never reach. Without this, running migrations as `dawaee_app` would hand the
-- application role a blanket policy on every patient table — the exact
-- catastrophe the model exists to prevent — and it would look like a success.
DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['dawaee_app', 'dawaee_worker'] LOOP
    IF current_user = runtime_role THEN
      RAISE EXCEPTION
        'migrations are being run as %, which is a runtime role', runtime_role
        USING HINT = 'Run migrations as the schema owner. The application and '
                     'worker roles must never own tables or definer functions.';
    END IF;

    -- Membership is what `SET ROLE` follows. If a runtime role were a member of
    -- the owner, the policy below would be reachable from a request.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role)
       AND pg_has_role(runtime_role, current_user, 'MEMBER') THEN
      RAISE EXCEPTION
        '% is a member of %, so it could SET ROLE into the definer path',
        runtime_role, current_user
        USING HINT = 'REVOKE the membership. The owner may be a member of the '
                     'runtime roles (PostgreSQL 16 needs that to set their '
                     'passwords); the reverse must never be true.';
    END IF;
  END LOOP;
END $$;

-- FORCE ROW LEVEL SECURITY does not enable RLS by itself. A table can therefore
-- look hardened (`relforcerowsecurity = true`) while every policy is actually
-- inert (`relrowsecurity = false`). Supabase's production advisor found exactly
-- that state on auth_otp_challenges after the 0030 rollout. Refuse it here,
-- before the sweep can make the state look even more convincing by adding an
-- owner policy to a table on which RLS is disabled.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relforcerowsecurity
     AND NOT c.relrowsecurity;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORCE RLS is set while RLS is disabled on: %', bad
      USING HINT = 'ENABLE ROW LEVEL SECURITY on the named table(s) before creating definer policies.';
  END IF;
END $$;

-- ------------------------------------------------------------- the sweep
--
-- Derived from `pg_class` rather than a list, because a list is what went
-- stale. NOT SECURITY DEFINER: it must run as its caller, which is the owner.
CREATE OR REPLACE FUNCTION app.ensure_definer_policies()
RETURNS TABLE (table_name text, action text)
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS t, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relforcerowsecurity
     ORDER BY c.relname
  LOOP
    -- A table owned by somebody else cannot be given a policy from here, and
    -- silently skipping it would leave the same hole this file exists to close.
    IF r.owner <> current_user THEN
      RAISE EXCEPTION
        'table %.% is owned by % but migrations run as %',
        'public', r.t, r.owner, current_user
        USING HINT = 'One role must own every table and every SECURITY DEFINER '
                     'function, or the definer path cannot be reasoned about.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename = r.t
         AND p.policyname = r.t || '_definer'
    ) THEN
      table_name := r.t; action := 'present'; RETURN NEXT;
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON public.%I TO %I USING (true) WITH CHECK (true)',
        r.t || '_definer', r.t, current_user);
      table_name := r.t; action := 'created'; RETURN NEXT;
    END IF;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION app.ensure_definer_policies() FROM PUBLIC;

COMMENT ON FUNCTION app.ensure_definer_policies() IS
  'Gives the schema owner the row-level exemption its own SECURITY DEFINER '
  'functions need, on every FORCE ROW LEVEL SECURITY table in public. '
  'Enumerated from pg_class so a table added later cannot be forgotten. '
  'Runs as its caller, never SECURITY DEFINER.';

-- Silent when there is nothing to do, which is every deploy after the first.
-- WARNING rather than NOTICE so it survives the `client_min_messages=warning`
-- that migrate.sh sets to keep several hundred idempotency notices out of the
-- deploy log: a policy being created is a schema change and should be visible.
DO $$
DECLARE
  created int;
  total   int;
BEGIN
  SELECT count(*) FILTER (WHERE action = 'created'), count(*)
    INTO created, total
    FROM app.ensure_definer_policies();
  IF created > 0 THEN
    RAISE WARNING 'definer policies: created % of % forced tables', created, total;
  END IF;
END $$;
