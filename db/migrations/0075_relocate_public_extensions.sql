-- 0075 — Keep extension-owned objects out of the exposed public schema.
--
-- Supabase's extension_in_public advisor currently reports pg_trgm and
-- btree_gist. Both installed versions are relocatable, and Dawaee's only
-- application dependency is the already-created medications_name_trgm_idx.
-- PostgreSQL binds that index to the opclass by OID, so relocating the
-- extension does not rebuild or invalidate it.
--
-- Supabase-managed projects can assign extension ownership to a platform role.
-- In that topology an operator must first relocate the two extensions through
-- the Supabase administrative surface. This migration then records the
-- invariant as a no-op. Failing explicitly is safer than claiming the advisor
-- is closed while silently leaving either extension exposed in public.

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE
  extension_name text;
  installed_schema text;
  installed_owner text;
  is_relocatable boolean;
BEGIN
  FOREACH extension_name IN ARRAY ARRAY['pg_trgm', 'btree_gist'] LOOP
    SELECT n.nspname, pg_get_userbyid(e.extowner), e.extrelocatable
      INTO installed_schema, installed_owner, is_relocatable
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = extension_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'required extension % is not installed', extension_name;
    END IF;

    IF installed_schema = 'extensions' THEN
      CONTINUE;
    END IF;

    IF installed_schema <> 'public' THEN
      RAISE EXCEPTION 'extension % is installed in unexpected schema %',
        extension_name, installed_schema
        USING HINT = 'Review the existing placement instead of moving it implicitly.';
    END IF;

    IF NOT is_relocatable THEN
      RAISE EXCEPTION 'extension % is not relocatable', extension_name
        USING HINT = 'Do not drop or recreate a production extension without a dependency and recovery review.';
    END IF;

    IF NOT pg_has_role(current_user, installed_owner, 'USAGE') THEN
      RAISE EXCEPTION 'migration role % does not own extension % (owner: %)',
        current_user, extension_name, installed_owner
        USING ERRCODE = '42501',
              HINT = 'Relocate this extension to schema extensions through the Supabase administrative surface, then rerun migrations.';
    END IF;

    IF NOT has_schema_privilege(current_user, 'extensions', 'CREATE') THEN
      RAISE EXCEPTION 'migration role % cannot create objects in schema extensions', current_user
        USING ERRCODE = '42501',
              HINT = 'Relocate this extension through the Supabase administrative surface, then rerun migrations.';
    END IF;

    EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', extension_name);
  END LOOP;
END $$;
