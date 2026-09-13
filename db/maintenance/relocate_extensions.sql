-- =============================================================================
-- Dawaee — privileged extension-schema maintenance
--
-- pg_trgm and btree_gist are trusted/relocatable extensions, but PostgreSQL can
-- still create their member objects under bootstrap-superuser ownership even
-- when CREATE EXTENSION is issued by the non-superuser database owner. Moving
-- those extensions therefore belongs to the privileged maintenance plane, not
-- the normal application migration plane.
--
-- This script is intentionally idempotent. It is run by CI after application
-- migrations so the test topology matches managed production, and by a managed
-- database administrator when Supabase Security Advisor reports either
-- extension in public.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  ext_name text;
  ext_schema text;
BEGIN
  FOREACH ext_name IN ARRAY ARRAY['pg_trgm', 'btree_gist']::text[] LOOP
    SELECT n.nspname
      INTO ext_schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = ext_name;

    IF ext_schema IS NULL THEN
      RAISE EXCEPTION 'required extension % is not installed', ext_name;
    ELSIF ext_schema = 'public' THEN
      EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', ext_name);
    ELSIF ext_schema <> 'extensions' THEN
      RAISE EXCEPTION 'extension % is installed in unexpected schema %', ext_name, ext_schema;
    END IF;
  END LOOP;
END
$$;
