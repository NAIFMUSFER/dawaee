# CI PostgreSQL source-scope audit

Branch: `audit/e2e-red-white-black-2026-09-09`. PR #14 remains Draft. No application/runtime, auth, SQL/RLS, migration, deployment or production mutation is part of this finding.

## Proven CI defect and retained remediation

CI run `34383842297` on head `3af44db439b02350b6306d8f296ff9804d5582b7` proved both PostgreSQL verification jobs could fail before tests because the workflow ran an unscoped `apt-get update`. The hosted runner's unrelated Chrome repository returned `Hash Sum mismatch` while the required PGDG repository had downloaded correctly. This was a CI reliability defect, not an application failure.

Concurrent commit `34b0e198cab70fbbe988eddd58ea6318a728b585` scoped the PostgreSQL index refresh to PGDG and added seven regression cases. Follow-up `a823ff3977928c604f166437ae439c4a2d59b5b1` corrected lint-only regex syntax. CI #276 then completed successfully for both PostgreSQL 16 and 17, including the matching client install, lint/typecheck, realistic non-BYPASSRLS database ownership, RLS probes, migrations, managed-Postgres smoke, complete unit/integration tests and mobile typecheck. Mobile exports, dependencies and Docker gates also succeeded.

## Independent helper was removed rather than weakening security gates

Commit `c21193a6333af9bf8238fc1485d19f1b982929db` added an additional APT `--print-uris` helper. Advanced Security's PR CodeQL check increased from 3 High alerts on parent `a823ff3977928c604f166437ae439c4a2d59b5b1` to 5 High alerts on `c21193a...`. Red-team follow-up `2bda371e3a91c67a4a0b78eefb84574a15d24c8e` proved the first helper version could execute shell substitution from parsed workflow text and replaced that parsing with fixed recognized options; its four local cases passed. Nevertheless the separate PR CodeQL check remained at 5 High alerts on `2bda371e...`.

The connector cannot retrieve the five annotations, so no exact CodeQL rule/source is asserted. The two extra alerts correlate exactly with the new executable helper/wrapper, while the APT fix itself already has seven permanent regressions plus a fully successful PG16/PG17 CI run. The additional helper and wrapper are therefore removed instead of suppressing CodeQL, weakening scanning, or carrying unnecessary executable audit machinery. The original red evidence and concurrent remediation remain documented here.

## Separate test-run observation

On `c21193a...`, PostgreSQL 16 reached the complete test suite after all APT/RLS/migration/smoke gates and exposed two failures in `shared-rate-limit.test.ts`; PostgreSQL 17 passed the same head. One failure is definitely a test defect: the retention case updates every `auth_rate_buckets.window_start` to one timestamp even though the table primary key is `(scope,key_hash,window_start)`, so two legitimate historical windows for one bucket can collide. This must be fixed as a targeted fixture, not by changing rate-limit runtime. The second multi-instance HTTP observation is not yet evidence of a runtime defect because the same test passed PostgreSQL 17 and earlier complete PG16/17 runs; it remains under reproduction before any runtime change.

The earlier auth-session callback-order failure is likewise not evidence of two issued sessions: its forced overlap test established TX2 blocked before commit and exactly one rotation occurred, and the same auth suite later passed on both PostgreSQL versions. Auth runtime remains unchanged.

## Open release boundaries

The separate PR Advanced Security CodeQL gate still has unresolved High alerts that predate the removed helper and must be located before release. Supabase's read-only security advisor reported `pg_trgm` and `btree_gist` installed in `public`; no production change followed. Fresh Render log inspection is not claimed in this pass because connector workspace selection was unavailable non-interactively.

Physical iOS/Android app-lock/background/reboot and notification actions, real push/caregiver escalation receipts and revocation, live OCR/object-provider operations, and remaining multi-device/offline/replay surfaces remain open. Green automated CI alone does not grant release approval.
