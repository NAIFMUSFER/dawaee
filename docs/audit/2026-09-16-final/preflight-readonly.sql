-- Operator-only metadata inspection. No migrations, updates or provider calls.
BEGIN READ ONLY;
SELECT current_database(), current_setting('server_version');
SELECT filename, checksum, applied_at FROM public.schema_migrations ORDER BY filename;
SELECT table_name,column_name,data_type,is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('medications','medication_schedules','medication_stock','dose_events','dose_occurrences','stock_transactions')
ORDER BY table_name,ordinal_position;
SELECT t.relname AS table_name,i.relname AS index_name,x.indisunique,x.indisvalid,x.indisready,
  pg_get_indexdef(x.indexrelid) AS definition,pg_get_expr(x.indpred,x.indrelid) AS predicate
FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public' AND t.relname IN ('medications','medication_schedules','medication_stock','dose_events','dose_occurrences','stock_transactions')
ORDER BY t.relname,i.relname;
SELECT conrelid::regclass AS table_name,conname,contype,convalidated,pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('public.medications'::regclass,'public.medication_schedules'::regclass,'public.medication_stock'::regclass,'public.dose_events'::regclass,'public.dose_occurrences'::regclass,'public.stock_transactions'::regclass)
ORDER BY conrelid::regclass::text,conname;
SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('dawaee_app','dawaee_worker','dawaee_migrator');
SELECT has_table_privilege('dawaee_worker','public.stored_objects','SELECT') AS worker_direct_object_read;
SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='app' AND p.proname IN ('list_abandoned_object_keys','remove_abandoned_object_metadata','record_push_receipt','has_verified_phone');
COMMIT;
