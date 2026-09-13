# CodeQL path-selection boundary in the offline Today test runner

Immediate parent: `6cc057bc76a92fd79050a3b5d46912a341d9db41`, audit branch / Draft PR #14. No merge, deployment or production operation.

## Correction of security status and actual scanner proof

CI276 passed on a823ff3, and Security277 completed successfully. However the SEPARATE CodeQL PR check102580253805 FAILED with three new High alerts. Executing/uploading a scan successfully is not alert clearance. Earlier broad checkpoint wording was corrected in PR comment5606581253. Keep the PR blocked until both the real CI and separate CodeQL verdict have been verified for the resulting head.

The concurrent SARIF metadata helper in parent6cc057bc resolved the evidence gap. Actual CodeQL job102588069384 (Security282/run34387628327), at 2026-09-09 18:16:08 UTC, reports exactly three js/path-injection results, security severity7.5, Uncontrolled data used in path expression. Locations: apps/mobile/test/profile-screen-harness.cjs line118 and twice at line158. The code-flow metadata identifies the new offline-today-rollover.cjs CLI process.argv[2]/[3] at line110 as the source, through scenarios/createHarness into the file read and hook-path construction. These are TEST-TOOL paths, not an observed production patient-data exploit. No finding was dismissed as harmless solely because it lives in test code.

Exact runner baseline blob: `7c45098aa9bb88ea2e6b65070305d805972cd1d6`.

## Minimal remediation, not a scanner exclusion

The standalone runner no longer accepts file or hook path arguments at all. It executes the known checked-in Today source relative to its own directory, independent of cwd. Extra arguments fail with usage status64 before scenario evaluation. The exported scenarios and all ten scenario callback bodies are retained unchanged, as are the Vitest wrapper, screen harness and application runtime. No CodeQL query/exclusion/suppression, security permission, workflow condition, test collection or threshold is changed.

Corrected runner blob: `b1ffc9a6066b66137f642e787747d49bfcf7201a`.

Three new tests execute actual Node subprocesses from another working directory. Harmless temporary sources emit SYNTHETIC-CLI-PATH-EXECUTED if evaluated. BEFORE: the external screen and hook canaries execute, the no-argument runner fails, and the same three assertions fail. AFTER: both external inputs are rejected with64 and no canary output; the no-argument invocation runs all ten existing scenarios successfully. The three unchanged tests pass locally through a registration adapter; actual Vitest/CodeQL must still run in CI. Native patient UI/network/storage remain mocked by the existing harness.

Current command (supersedes the older file-argument example in the rollover report):

```sh
node apps/mobile/test/offline-today-rollover.cjs
npx vitest run apps/mobile/test/offline-today-rollover.test.ts apps/mobile/test/offline-today-cli-boundary.test.ts
```

The before/after clinical comparison remains reproducible from the preserved hashed source fixtures through the exported scenario API in a reviewed fixed-fixture evidence harness. It is not necessary to permit arbitrary CLI source evaluation in the repository runner to retain a red proof.

This correction owns the alerts introduced by the new CLI instead of changing unrelated application logic. It preserves the concurrent SARIF diagnostics and rate-limit retention fixture correction. It does not resolve the separately observed fixed-window boundary test assumption, physical-device acceptance, live notification receipts or global end-to-end release readiness. No all-green claim is made before exact-head verification.
