-- Catalogue-only inspection. Never call app.ensure_definer_policies() here:
-- that maintenance function creates policies. A read-only transaction also
-- protects callers whose managed pooler ignores startup connection options.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  runtime_role text;
  bad text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['dawaee_app', 'dawaee_worker'] LOOP
    IF current_user = runtime_role THEN
      RAISE EXCEPTION 'migrations are being run as %, which is a runtime role', runtime_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role)
       AND pg_has_role(runtime_role, current_user, 'MEMBER') THEN
      RAISE EXCEPTION '% is a member of the migration role %', runtime_role, current_user;
    END IF;
  END LOOP;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relforcerowsecurity AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORCE RLS is set while RLS is disabled on: %', bad;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) <> current_user;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'forced tables are not owned by migration role %: %', current_user, bad;
  END IF;
END $$;

SELECT format('preflight: %s missing definer policies; created only during migration mode', count(*))
  AS planned_maintenance
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
   AND NOT EXISTS (
     SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = c.relname
        AND p.policyname = c.relname || '_definer'
   );
COMMIT;
