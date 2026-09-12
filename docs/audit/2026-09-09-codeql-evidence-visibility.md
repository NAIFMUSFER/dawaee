# CodeQL evidence visibility without gate weakening

Prepared against `94cd0c3c635938c80eedad9e8b351b88e826cbdf`; preserve its removal of the additional APT helper and wrapper. Applied above concurrent `47b68b28dd921654fb8291f6dfcac3c1b9c13381`, retaining its rate-limit retention fixture blob `e181d57731cc13e9f8030f982b6107da6fc59872` unchanged. No removed test machinery is reintroduced here. Branch remains `audit/e2e-red-white-black-2026-09-09`, PR #14 Draft, no merge/deploy/production mutation.

## Proven diagnostic gap

The separate Advanced Security check on `2bda371e3a91c67a4a0b78eefb84574a15d24c8e`, check `102585632825`, completed at 2026-09-09T18:06:32Z with **5 High alerts**, while ordinary CodeQL workflow execution completed successfully. The current GitHub connector rejected the exact annotation URL as unsupported; tool discovery had no annotation/alert reader. Run `34385978260` exposed no artifacts, and its CodeQL job `102582219399` log did not include rule IDs or file/line locations for the five findings. Thus a successful scan run was observable but the actionable evidence was not.

This is an observability change, not a guessed remediation of any of the five findings. The pinned `github/codeql-action` analyze action at `cdf488f595d80d6e07e03d4674febd5ab45fa938` explicitly supports `output` (default `../results`). Set that existing input to `codeql-results`, then read only the known generated `javascript.sarif` file in a following diagnostic step.

## Data boundary and regression checks

The diagnostic emits JSON metadata: rule identifier, security severity, level, primary file/line and dataflow file/line paths. It does not emit result messages, source snippets, fixes, artifact contents, environment values or tokens. It evaluates no source text and launches no subprocess. Missing scan structure fails visibly; this does not turn a missing scan into zero findings.

Five standalone regression cases passed locally with Node 22.16.0 and are also collected by root Vitest: exact primary/dataflow locations, snippet/message/fix exclusion, indexed rules/artifacts, workflow-command-safe JSON framing, and rejection of missing scan structure. Full latest-head CI and actual scan-output interpretation still require CI.

```sh
node scripts/test-codeql-evidence.cjs
npx vitest run apps/api/test/codeql-evidence.test.ts
```

No query-set changes, dismissals, suppressions, severity threshold changes, extra credentials, permission widening or release-gate removal. CodeQL upload remains `always`, the separate PR findings gate remains authoritative, and Gitleaks/Trivy are untouched. The diagnostic is not release approval.
