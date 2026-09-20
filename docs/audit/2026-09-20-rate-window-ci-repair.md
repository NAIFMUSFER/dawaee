# Fixed-window persistence test repair — 20 September 2026

## Observed failure, not hidden by a retry

The documentation-only head `d4b0df92e7ea45a577a3daf0dcf3d0ed65d2c230`
failed [CI #1148](https://github.com/NAIFMUSFER/dawaee/actions/runs/35495126947)
on PostgreSQL 16: **2,884 passed, 1 failed / 377 files**. PostgreSQL 17,
security, mobile, dependencies, containers and runtime recovery passed.

The failure was in `shared-rate-limit.test.ts`, before construction of the new
server: eleven login attempts returned `401`, not the test's expected `429`.
The suite completed at 06:50:07.014 UTC and took 11.089 seconds, spanning the
absolute 06:50:00 ten-minute boundary. These timestamps support a window-seam
diagnosis; the CI logs do not contain per-request bucket timestamps, so they
are not by themselves a trace proving which request crossed the seam.

The actual contract in migration 0029 aligns windows to
`floor(epoch(now()) / window_seconds)`. It intentionally permits a fresh budget
after expiry. The old persistence test incorrectly assumed all sequential
requests and the subsequent restart probe share one fixed window. The adjacent
replica-persistence test had the same assumption. A rejected attempt is still
counted and committed; neither rule is being relaxed.

## Test-only repair

`apps/api/test/shared-rate-limit.test.ts` now:

- Sends the original ten real HTTP requests through alpha and verifies `401`
  for each and a total of ten hits in the real database counter.
- Discovers only that synthetic identifier's opaque key from the database; it
  neither duplicates the production HMAC nor clears unrelated fixtures.
- Seeds that key's current and next fixed windows to the threshold using one
  database-clock statement. This isolates persistence from legitimate expiry.
- Requires `429` on the existing/second/fresh server and verifies each refused
  attempt increments the persisted count. A memory-only or reset counter still
  fails these assertions.
- Adds the converse case: two exhausted **historical** windows do not prevent a
  new `401` response (invalid credentials, not authenticated success) and its
  single newly counted hit. Expiry must not become a permanent account lock.

The rebuilt Fastify server is not an independently spawned OS process; the test
wording now makes that boundary explicit. Native multi-connection CI remains
the integration gate. No application limiter, migration, maximum/window,
credential check, recovery exemption, skip or CI workflow changed.

## Local evidence and remaining gate

- API source typecheck, changed-file ESLint and whitespace validation passed.
- An isolated PGlite probe executed the **unchanged migration 0029** and the
  exact new fixture SQL extracted from its TypeScript AST: **22 assertions
  passed**. It checked counts 1–10, refusal at 11, valid expiry, current/next
  fixture refusal, refusal after moving the next bucket to the current window,
  historical-only expiry, and retry guidance. The probe moves only synthetic
  bucket timestamps within a transaction with a stable database clock; it does
  not mock the SQL function or claim a physical-time/native-concurrency test.
- A scratch-probe attempt first hit a unique-key collision while relocating
  rows in one delete/insert CTE. The probe was corrected to finish deletion
  before reinsertion. This was probe scaffolding, not application code or the
  checked-in fixture, and is not counted as a passed attempt.
- Native `psql`/PostgreSQL binaries and Docker are unavailable locally. The
  modified full HTTP suite therefore awaits exact-head PostgreSQL 16/17 CI;
  PGlite does not stand in for that result.

The separately published native-direction repair is `3780b5a`; its evidence is
in [the direction report](2026-09-20-native-direction-reversal.md). The latest
CI outcomes must be recorded in PR #32 after completion, not inferred from an
older head. Production remains `63b5b8d`, isolated preview `ff1bd1b`, and no
TestFlight build, deployment or account reset is part of this test repair.
