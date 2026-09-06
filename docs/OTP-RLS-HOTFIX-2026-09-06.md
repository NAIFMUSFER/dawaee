# OTP RLS production-advisor finding — 2026-09-06

After the `0020`–`0030` production rollout, Supabase Security Advisor reported `policy_exists_rls_disabled` for `public.auth_otp_challenges`.

The table had an owner-only definer policy and `FORCE ROW LEVEL SECURITY`, but migration `0008_security_rls.sql` omitted it from the `ENABLE ROW LEVEL SECURITY` block. PostgreSQL allows FORCE to be set while RLS itself is disabled, so the policy was inert. Direct grants to the table were already revoked; this is a defence-in-depth defect, not evidence that the runtime roles could read OTP verifier rows.

Migration `0031_enable_otp_rls.sql` enables and forces RLS and asserts that no public table remains in FORCE-without-ENABLE state. The deploy-time definer-policy preflight now refuses that contradictory state before creating owner policies. `apps/api/test/otp-rls-regression.test.ts` pins the activation and direct-grant boundary.

Production remains on migration `0030` until PR #4 passes the protected CI and security gates.
