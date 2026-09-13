# Rebuild the generated browser artifact before CodeQL extraction

Parent: `b5b2b0a78b6bd964cf66766d0430c8aaec4e5ba8`.
Branch: `audit/e2e-red-white-black-2026-09-09`; PR #14 stays Draft/open.
No application/runtime, database, dependency version, scan query, permission,
severity threshold, suppression, merge, deploy or production mutation.

## Proven evidence gap

On prior head `7ba475365ba64f8ef24eff1fd9787101b06c772b`, CodeQL job
`102598797445` explicitly extracted `apps/api/public/index.html` and reported
three findings inside that generated document, alongside two source/test
findings. Subsequent commit `4fecb9d256d10b9b727be33ece245b7349a4c555`
removed tracked generated output and applied deterministic build hardening.

The current `.github/workflows/codeql.yml` baseline blob
`63ae6d85bf647b74d151371f76d4aed9e7b05254` checks out the repository and
immediately initializes/analyzes CodeQL. There is no dependency install or
production web build in that job. The separate Docker job builds its own image
on another runner and cannot supply this runner's source tree. Consequently a
clean scan checkout lacks the untracked HTML formerly analyzed. A green PR gate
alone cannot certify remediation in code that was absent from extraction.
This is a scanner-coverage defect, not a new demonstrated application exploit.

The new ordered-preparation regression fails against the baseline job shape
because the required build stages are absent. It passes with the added stages
and rejects a missing-build mutation. That local execution ran the exact
structural callback under Node, not Vitest, Expo or CodeQL. The actual scanner
log must independently prove extraction of the generated HTML after this change.

## Bounded correction

Before CodeQL init, use the repository's already-pinned Node setup action and
.nvmrc; install locked root/mobile dependencies, build workspace packages, and
execute the same `scripts/build-web.sh` used by production. Keep the same-origin
API setting and production mode confined to the build child. Require nonempty
HTML and hash sidecar before extraction. A failed install/build/check aborts;
there is no stale-bundle fallback, conditional skip or permission widening.
CodeQL queries/upload, metadata diagnostics, Gitleaks and Trivy are unchanged.

Four permanent checks complement the retained bootstrap tests: collection-time
access to the real same-origin HTML, a canonical 32-byte hash sidecar, ordered
production preparation before CodeQL, and retained query/upload semantics.
The first two read artifacts before any suite hook, not a mock document. The
latter two are configuration regression guards, not proof of scanner coverage.
The new module passes local TypeScript transpilation and node syntax checking;
full Vitest/typecheck/lint and actual CodeQL extraction still require CI.

## Preserve concurrent test-bootstrap correction

CI #289 (`34394139236`) PG17 job `102609739164` had **1,553 PASS / 1 FAIL**:
`endpoint-authorization.test.ts:326` found `GET /` and `GET /app` missing before
the later web suite built its artifact. The inventory correctly rejected the
incomplete fixture. An independently prepared overlapping candidate `6081783`
was rejected by a non-forced update after b5b2b0a landed. It was NOT applied.
Retain b5b's global setup, three tests, configuration, audit note and the web
suite's independent fresh build unchanged; do not overwrite them or attribute
the rejected candidate's settings to the branch.

## Production evidence and remaining acceptance boundaries

Confirmed explicit Render workspaceId restored read-only service/deploy/log
inspection; no workspace mutation was required. Main API
`srv-dad9mvf10e5c73dva9vg` and worker `srv-dad9meijnfac73f1o3tg` both report live
commit `4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72`. The explicit UTC window
2026-09-09T18:28:00Z–19:28:00Z has no warn/error-labelled entries for those two
services (hasMore=false). Unbounded historical logs include older 503s and
worker authentication failures; do not call them new incidents or infer E2E
health merely from quiet logs. No PHI or credentials are reproduced here.

Verify exact-head full CI, both PostgreSQL versions, mobile exports, dependency
and container gates; read the separate PR CodeQL verdict AND its actual generated
HTML extraction/diagnostic. A remaining finding must be triaged, not suppressed.
Physical-device app lock/background/reboot, real Push/caregiver receipts and
revocation, live OCR/storage, remaining offline/replay and dependency finding
triage stay open. No release approval follows from these preparation changes.
