# Build the real web surface before any authorization inventory starts

Baseline `d692117e1c2d43be1f3aebe17573131a7c28433d`, Draft PR #14.
No application, database, workflow, scan-policy, permission or production change.

## Actual failing evidence

CI #289 (`34394139236`) finished FAILURE, superseding the earlier in-progress
snapshot in comment 5607465087. Both PostgreSQL jobs stopped at the full suite.
The completed PG16 job `102609739355` reports **1553 PASS / 1 FAIL**, across
108 passing files and one failing file (109 total), under real Vitest 2.1.9.
The sole failure is `P12-1 the inventory covers the whole surface > has no entry
for a route that no longer exists`, at
`apps/api/test/endpoint-authorization.test.ts:326`: extra inventory entries
`GET /` and `GET /app` were absent from the running route table.

The exact source explains this deterministic clean-checkout dependency:
`apps/api/src/routes/web-app.ts:71-74` returns without registering web routes
when generated public/index.html is absent. Generated artifacts are now ignored
and no longer tracked. The inventory's beforeAll starts its server directly;
only a later `web-app.test.ts` beforeAll builds the web output. That later file
passed all eight tests after a real 25-second Expo build, while the earlier
server had already captured the API-only route surface. No production route was
shown broken by this failure. The authorization inventory correctly rejected an
incomplete test setup; it must not be weakened to tolerate missing web routes.

The same PG16 run independently passed the new **20 web-hardening** and **29
route-matching** tests under actual Vitest, not the local callback adapter.
Build/lint/typecheck, realistic ownership, RLS probe, migrations and managed-PG
application smoke passed before the full suite failed. Separate Security #290,
Docker, mobile exports and dependency jobs also passed on the baseline; they do
not turn the full CI result into a pass.

## Narrow correction

Register a Vitest global setup that invokes the actual fixed build-web.sh before
any test worker starts. Always rebuild rather than trust stale generated files.
Use the same credential-free public API literal as the existing web test, a
fixed script argument and bounded 120-second timeout; propagate any error.
Keep the endpoint inventory, all routes, all existing suites, serial database
execution, timeouts and exclusions unchanged. Keep the web route suite's own
fresh build so its independent source-build contract remains intact.

The global hook applies to filtered root Vitest runs too, so they require the
mobile build dependencies just as the full audit does. It builds, but does not
publish, deploy, migrate a production database or call any application provider.
Vitest v2's official globalSetup documentation specifies execution before test
workers: https://v2.vitest.dev/config/#globalsetup .

Three permanent cases pin global registration, actual fixed build arguments and
failure propagation. The registration assertion is RED on the exact original
config blob `0647e4e7d75aff8663f8c21d21b3f454c06040c8` and GREEN with the hook.
All three callbacks pass locally with a Node registration/mock adapter, NOT
Vitest; the subprocess is mocked in those unit cases. Focused strict TypeScript
checking passed with declarations for the unavailable Vitest functions. No local
Expo, Fastify or PostgreSQL run is claimed. The next real CI must demonstrate the
unchanged inventory passes against an actual clean-checkout production build.

Generated-browser-code scan coverage, physical device behavior, provider delivery
receipts and the remaining E2E audit are still independent open acceptance items.
No merge, release approval or deployment follows from this change.
