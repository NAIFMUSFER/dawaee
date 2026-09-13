# CodeQL evidence: resolve the referenced rule component

Baseline `4055c64a78ccf721af0e73ada37103c5cbc47a0b`; PR #14 remains Draft.
No application, database, workflow, scan-policy, permission or production change.

## Proven defect

Security job `102591784367` printed eight findings with both `securitySeverity`
and `level` null at 2026-09-09T18:26:43Z. The diagnostic at
`scripts/codeql-evidence.cjs:10,23-27` searched only `tool.driver.rules`, ignoring
`result.rule` and `tool.extensions`. Its exact baseline blob is
`e46028901ff81a411aba81f9b8d18f078338b025`; existing test blob is
`7efbfa5272872b605054a0250134535cf67ad8c0` (both locally hash-verified).

SARIF 2.1.0 sections 3.27.7, 3.52 and 3.54 define component-scoped descriptor
lookup. A valid extension/index fixture loses its metadata with the existing
helper. More importantly, a same-ID driver rule with severity 1.0 incorrectly
supplies that value for an explicitly referenced extension rule with severity
9.2. Thus this is not merely a display preference; it can mislabel evidence.
The raw producer report was not available locally, so the next actual scan must
confirm whether this supported report shape also explains the observed nulls.

## Bounded correction and tests

Resolve the tool component first (extension index, component GUID, otherwise
driver), then the descriptor (rule index, descriptor GUID, or the existing
legacy ID fallback). Respect result.rule fields and legacy result fields.
An unresolved explicit index/GUID stays unavailable; it cannot borrow metadata
from a different component or fall back to a same-ID descriptor. Keep explicit
result.level precedence, all findings and file/dataflow locations unchanged.

Eight new permanent cases exercise extension-only metadata, same-ID driver
shadowing, modern result.rule fields, driver object references, GUID references,
invalid component/rule indices, and explicit result level. Together with the
five unchanged tests: **before 5 PASS / 8 FAIL; after 13/13 PASS**. Both scripts
passed node --check. Tests ran directly with Node 22.16.0, no mock runner needed.
The existing Vitest wrapper collects all cases without modification.

The diagnostic still reads only its fixed local SARIF file. It executes no
report text, invokes no subprocess, and emits no messages, snippets, help,
fixes, arbitrary properties or artifact contents. Missing metadata remains null,
not zero severity and not a clean finding. This is a focused evidence formatter,
not a full SARIF validator or a substitute for GitHub's findings gate.

```sh
node scripts/test-codeql-evidence.cjs
npx vitest run apps/api/test/codeql-evidence.test.ts
```

The preceding source-assertion fix has independently passed the separate CodeQL
PR gate on 4055 (check `102596749456`, completed 2026-09-09T18:39:18Z): no new
alerts. That does not mean the complete SARIF report has no findings. Full CI
and Security must still be verified on the resulting head; no release approved.
