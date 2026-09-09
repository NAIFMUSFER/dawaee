# Independent verification of the CI PostgreSQL source-scope fix

Branch: `audit/e2e-red-white-black-2026-09-09`. PR #14 stays Draft.
No application/runtime, auth, SQL/RLS, migration, deployment or production change.

## Proven failure and concurrent remediation

CI #274 run `34383842297`, head `3af44db439b02350b6306d8f296ff9804d5582b7`, fails both PostgreSQL jobs in the installer before npm/build/RLS/tests. Job `102575008485` records Chrome's `Hash Sum mismatch` at 2026-09-09T17:36:00Z and apt exit 100 at 17:36:05Z, while PGDG indexes had downloaded. The workflow's unscoped apt refresh selected unrelated preinstalled runner sources.

The original workflow was locally reconstructed and verified against Git blob `667fc594cbeb43d21b3810d4fc078d35ae625b67` before reproduction. An independent candidate was prepared, but its non-forced branch update was correctly rejected after concurrent commit `34b0e198cab70fbbe988eddd58ea6318a728b585` fixed the same issue. That concurrent workflow and its seven tests are preserved, not overwritten or duplicated. Follow-up `a823ff3977928c604f166437ae439c4a2d59b5b1` corrected three lint-only regex-spacing failures. The retained workflow blob is `ecc94959f8b305a985966bd67afb080a513e74f6`.

CI #275 run `34384906448` proves actual PostgreSQL-client installation succeeded in both matrix jobs on the concurrent fix. PG17 job `102578612885` fetched only PGDG indexes and installed client 17.11, then failed later at ESLint in the new test. Do not label that run an application/test success: the suites were skipped after lint failed.

## New complementary regressions

The seven existing tests simulate external installer commands. These two additional permanent cases instead ask real Linux APT to enumerate its source targets with `--print-uris`, using isolated temporary source/list/cache fixtures. No root command, network request or package installation is performed.

1. Positive control: an unscoped update must select both PGDG and an unrelated `.invalid` source, proving the fixture is discoverable.
2. Regression: capture the actual checked-in workflow update arguments, replay them through APT with only the PGDG fixture path relocated, and require PGDG to be selected while the unrelated source is excluded.

The same two cases executed against exact source blobs:

| Workflow | Positive control | Source-isolation regression |
| --- | --- | --- |
| Original `667fc594...` | PASS | FAIL: unrelated source appears in actual APT targets |
| Concurrent fix `ecc94959...` | PASS | PASS |

The two-case harness is not a replacement for the existing seven command-double cases, real signed installation, or either full PostgreSQL suite. The earlier independent twelve-case candidate was not applied to this branch and its results must not be attributed to the retained workflow.

```sh
node scripts/test-ci-postgres-apt-selection.cjs
npx vitest run apps/api/test/ci-postgres-apt-selection.test.ts
# Same regression against the pre-fix workflow copy:
node scripts/test-ci-postgres-apt-selection.cjs /path/to/old-ci.yml
```

Local execution used Node 22.16.0 and the installed APT parser; complete dependency install, PostgreSQL tests and Expo exports were not available locally. CI/Security must be checked on the resulting head.

## Other verified evidence and open boundaries

Read CI #273 attempt 1, PG17 job `102570330052`: all 1,464 other tests pass and auth-session's sole failure is line 206's JavaScript callback-order expectation (`tx2-done` before the `tx1-commit` continuation). The preceding blocked-query and exactly-one-rotation assertions completed. This is not evidence of two issued sessions; auth runtime is unchanged and the test-observation issue remains open.

Render list-services refused because no workspace was selected and its connector requires user confirmation before choosing a workspace. No fresh Render log/deploy inspection is claimed in this pass. Supabase security-advisor read at 2026-09-09T17:52:07.814Z returned two `extension_in_public` warnings for `pg_trgm` and `btree_gist`; no migration or production mutation followed. Advisor output is not full RLS certification.

Still open: actual iOS/Android app-lock/background/reboot and notification actions, real push/caregiver-escalation receipts and revocation, live OCR/object-provider operations, remaining multi-device/offline/replay surfaces and current production-log inspection. No release approval follows merely from green automated checks.
