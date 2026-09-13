-- =============================================================================
-- Dawaee — 0081: relocate relocatable extensions out of public
--
-- Supabase Security Advisor flags extensions installed in public because their
-- objects share a schema with application objects. Both pg_trgm and btree_gist
-- are relocatable. Keep this as an application migration so fresh databases
-- converge to the same hardened layout after the existing indexes/constraints
-- have been created.
--
-- Managed Supabase production may require an administrative maintenance step
-- when an extension is owned by supabase_admin. This migration is idempotent:
-- once that maintenance step has moved an extension to `extensions`, the
-- normal application migration runner performs no ALTER for that extension.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  pg_trgm_schema text;
  btree_gist_schema text;
BEGIN
  SELECT n.nspname
    INTO pg_trgm_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';

  IF pg_trgm_schema IS NULL THEN
    RAISE EXCEPTION 'required extension pg_trgm is not installed';
  ELSIF pg_trgm_schema = 'public' THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
  ELSIF pg_trgm_schema <> 'extensions' THEN
    RAISE EXCEPTION 'pg_trgm is installed in unexpected schema %', pg_trgm_schema;
  END IF;

  SELECT n.nspname
    INTO btree_gist_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'btree_gist';

  IF btree_gist_schema IS NULL THEN
    RAISE EXCEPTION 'required extension btree_gist is not installed';
  ELSIF btree_gist_schema = 'public' THEN
    EXECUTE 'ALTER EXTENSION btree_gist SET SCHEMA extensions';
  ELSIF btree_gist_schema <> 'extensions' THEN
    RAISE EXCEPTION 'btree_gist is installed in unexpected schema %', btree_gist_schema;
  END IF;
END
$$;
