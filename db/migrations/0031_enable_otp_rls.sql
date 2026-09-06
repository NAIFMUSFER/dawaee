-- =============================================================================
-- Dawaee — 0031: make the OTP challenge RLS state internally consistent
--
-- Supabase's production security advisor found a real schema contradiction:
-- auth_otp_challenges had FORCE ROW LEVEL SECURITY and an owner-only definer
-- policy, but ENABLE ROW LEVEL SECURITY had never been executed for the table.
-- PostgreSQL permits that state; FORCE alone does not turn RLS on, so the
-- policy was decorative. Direct table grants are already revoked and OTP access
-- is constrained to SECURITY DEFINER functions, but a security control that is
-- present and disabled is not acceptable defence in depth.
--
-- 0008 created the auth_otp_challenges_definer policy but omitted this table
-- from the subsequent ENABLE/FORCE block. Make the intended state explicit and
-- assert the generic invariant so this migration fails if any existing public
-- table is forced without also being enabled.
-- =============================================================================

ALTER TABLE public.auth_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_otp_challenges FORCE ROW LEVEL SECURITY;

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
    RAISE EXCEPTION 'FORCE RLS is set while RLS is disabled on: %', bad;
  END IF;
END $$;
