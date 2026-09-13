# Audit-harness correction: never execute workflow argument input

Branch: `audit/e2e-red-white-black-2026-09-09`. Parent `c21193a6333af9bf8238fc1485d19f1b982929db`. PR #14 remains Draft; no merge, deploy or production mutation.

## Evidence before correction

The helper introduced in c211 (`scripts/test-ci-postgres-apt-selection.cjs`, blob `6a5664ce28684ca030637d62c38291ce0b26e2f6`) concatenated a workflow-derived line into `bash -c` at lines 20-27. Replacing sudo with a printing function did NOT make shell argument expansion non-executing.

An isolated fixture containing a `$(touch <temporary-marker>)` argument created that marker while reading the update arguments. The regression assertion that parsing must not execute shell input failed. The fixture used only a temporary directory and was removed in finally; no production/network/root operation was involved. A second regression showed arbitrary APT configuration was accepted and could be passed onward to APT. Acceptance was proved; execution of an APT hook is not claimed.

The two permanent new cases were added before correcting the helper. Against the unchanged parent helper the four-case result was **2 PASS / 2 FAIL**; both existing real-APT source-selection cases passed. This is a defect in the audit harness, not a demonstrated production application exploit. It is our introduced helper and must be corrected rather than hidden or described as a false positive.

## Bounded correction

Remove Bash invocation entirely from argument parsing. Accept only the checked-in simple `sudo apt-get ... update` grammar with `-o` pairs. Convert recognized source-scope/list-cleanup/strict-error options to fixed literal arguments; reject all other settings before spawning APT. Unknown executable APT hooks and shell syntax cannot become subprocess input. The real APT `--print-uris` source-selection checks and their discoverable unrelated-repository positive control remain.

The corrected helper blob `eb3b32e19c6737c675eb03ff24ae9d8d77101979` passed all four scenarios locally using Node 22.16.0 and real APT; `node --check` passed. The unchanged wrapper includes all four cases in root Vitest. No workflow, installer, auth, API, RLS, migration, security policy or production change.

```sh
node scripts/test-ci-postgres-apt-selection.cjs
npx vitest run apps/api/test/ci-postgres-apt-selection.test.ts
```

## Security-gate accounting

At a823ff3, the separate CodeQL PR gate reported 3 new High alerts (`102580071032`). At c211 it reported 5 new High alerts (`102582848634`), despite successful Security workflow #278. Its exact annotations were unavailable through the connector; therefore no specific CodeQL rule/source/sink is invented. The independently reproduced helper defect justifies this correction, while the alert-count change still requires rechecking on the resulting commit. Workflow completion is not the same as a passing vulnerability gate.

Full CI, both PostgreSQL versions, mobile exports, dependency/container checks, and the separate CodeQL PR gate must be verified on the new head. This local proof is not full CI or release approval. The inherited alert set, auth callback-observation race, physical device/push/escalation, live OCR/provider and remaining offline/replay/production-log boundaries remain open pending separate evidence.
