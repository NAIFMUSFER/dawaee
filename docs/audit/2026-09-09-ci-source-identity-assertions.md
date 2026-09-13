# CI signed-source identity assertions: concrete CodeQL evidence and mutation proof

Baseline: `881d0c6ab45314ce744126ecb44f938587ba4f94`, PR #14 Draft,
`audit/e2e-red-white-black-2026-09-09`. No runtime, workflow, database, migration,
auth, dependency, permission, notification, merge or deployment change.

## Evidence before editing

Security run `34388820848`, job `102591784367`, at 2026-09-09T18:26:43Z
printed the actual SARIF locations through the existing metadata diagnostic:

- `js/incomplete-hostname-regexp`: `apps/api/test/ci-postgres-source-scope.test.ts:65`
- `js/incomplete-hostname-regexp`: the same file, line 89
- `js/regex/missing-regexp-anchor`: the same file, line 89

The separate Advanced Security check `102592455964` reported 3 new High alerts
on this head despite successful scan execution. The diagnostic reported eight
results in all, with rule severity fields null. Do not equate the three new PR
alerts with the complete result set or claim the other five results resolved.

The exact source file was locally reconstructed from the connector and verified
as Git blob `3c1baa2e71542a0ca18c642993f75b9b278b41d0`; the unchanged complete
workflow matched blob `ecc94959f8b305a985966bd67afb080a513e74f6`.

All seven original callbacks passed against the real checked-in workflow. Then,
without changing those callbacks, each of six isolated workflow copies changed
only one inert URL string: repository hostname dots, signing-key hostname dots,
key filename dot, key filename suffix, repository URL embedded in another URL,
and key URL embedded in another URL. **All six incorrect-source mutations still
passed all seven original tests.** External commands were the existing installer
doubles, so no remote request, actual signing key download, root operation or
package installation was performed. This is a proven weakness in test assertions,
not evidence of a changed production package source or compromised application.

## Correction and permanent regressions

Replace the three permissive substring assertions with one local assertion over
complete captured command records. Require exactly the expected curl arguments
and exactly one complete signed repository record. Compare strings literally,
including scheme, host, path, key output/signed-by binding, suite and component.
Reject extra or missing download/source records. The assertion reads inert log
text; it does not evaluate shell or launch a subprocess.

Keep all seven original test cases and the existing workflow command doubles.
Add ten permanent controls using only mutated captured log text: the six URL
mutations above, an additional repository, an additional signing-key download,
a missing download, and a missing repository. Before the assertion correction,
the same expanded suite had **9 PASS / 8 FAIL**; afterward **17/17 PASS**.
The final suite was also replayed against all six complete-workflow URL mutants;
each mutant is rejected, while the unchanged workflow passes. The workflow blob
remains unchanged. No removed APT helper or arbitrary-path CLI is reintroduced.

## Verification boundaries

Local Node 22.16.0 / TypeScript 5.8.3 ran the unchanged callback bodies and real
Node assertions through a describe/it registration adapter, **not Vitest**.
Focused strict TypeScript checking passed with local declarations for only
Vitest's registration functions. This is not a full workspace typecheck or lint.
The sandbox has no PostgreSQL, Docker or project dependencies; DNS prevented a
public Git clone. Full exact-head Vitest, lint, workspace compilation, PG16/17,
mobile exports, Docker, Gitleaks, Trivy and separate CodeQL PR verdict must be
read from the resulting CI run before claiming they pass.

```sh
npx vitest run apps/api/test/ci-postgres-source-scope.test.ts
```

Parent CI #282 (`34388820894`) completed successfully on both PostgreSQL versions,
including ordinary-owner RLS/migrations, managed-Postgres application smoke and
full suites, plus mobile exports/dependencies/Docker. Those are parent results,
not advance approval for this change. Preserve the parent's constrained Today
runner and all prior unrelated changes.

Primary query guidance: CodeQL query help for `js/incomplete-hostname-regexp`
and `js/regex/missing-regexp-anchor` describes wildcard host characters and
substring matches. The executable mutation proof above, not a scanner count
alone, justifies this correction.

Remaining release boundaries include the other SARIF findings and missing rule
severity metadata, historical auth callback-order and time-window test flakiness,
physical iOS/Android/app-lock/background/reboot behavior, actual push/escalation
receipts and revocation, live OCR/storage-provider operations, remaining offline
and multi-device surfaces, and current production-log inspection. PR stays Draft;
no release approval follows from automated checks alone.
