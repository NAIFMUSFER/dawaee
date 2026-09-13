# Route assertion: preserve concurrent literal matching and exact path boundaries

Parent `18bce118f714a02751a2035fd6577719a922008e`, Draft PR #14.
Only test assertion and this evidence record change. No production router,
screen, API, database, workflow, scanner configuration, merge or deployment.

## Original finding and concurrent-work preservation

Actual CodeQL metadata at `7ba4753`, job `102598797445`, identifies
`js/incomplete-sanitization` at `apps/mobile/test/links-resolve.test.ts:47`.
The exact original blob `37e7ff89506c3d57a421e046db71e6b5191df9cc` was locally
reconstructed and Git-hash verified. Its RegExp source derived from filenames
accepts `/reports/v1X0` for literal `/reports/v1.0`, while literal plus signs or
parentheses can reject the real path. Twenty-two new exact-matcher callbacks
proved 12 PASS / 10 FAIL before the locally prepared correction.

While that work was prepared, concurrent commits `57c1d03` corrected four quote
fixture lint escapes and `18bce118` replaced the route RegExp with direct segment
matching and an additional regression. A non-fast-forward ref update was
rejected. No force push was attempted. The unpublished `c332ef8` proposal was
not applied; this change builds on `18bce118`, retaining its helper name,
dynamic matching, all five existing tests and the quote correction.

## Additional proof against the actual new parent

Reconstructed and hash-verified parent blob
`1a84344c43fd9e229d51839bf7c2df500986e400`. Its `.filter(Boolean)` calls collapse
empty path components, unlike the original exact-path assertion. It consequently
accepts an empty path or `//` for `/`, relative `invite/TOKEN`, doubled separator
`/invite//TOKEN`, and a trailing separator absent from the expected path.

Twenty-four permanent cases on that exact parent: **19 PASS / 5 FAIL**.
Remove only the two empty-component filters, retaining literal segment equality
and the parent's single-segment dynamic matching: **24/24 PASS**. No generic
router normalization is asserted. The additional cases retain positive literal
metacharacter routes, reject lookalikes, and exercise root, relative/empty/extra
components, actual single parameters and emergency transport boundaries.
All five parent tests remain; the full file now registers 29 cases.

## Verification limits and related pipeline evidence

Local Node 22.16.0 executed the exact isolated helper and 24 new callback bodies
using a registration/expect adapter, NOT Vitest. Original API/screen filesystem
route discovery was not replaced with a fake tree. Focused strict TypeScript
checking passed with a local declaration of the unavailable Vitest module.
Actual CI must prove all 29 cases against the real repository.

The preceding web correction `6738ba4` passed actual Docker/Expo production build
and the container/Trivy steps in Security #287 (`34393432336`, container job
`102607159979`). CI #286 stopped before database/tests on four unnecessary
quote-escape lint errors (`102607161864`); preserved `57c1d03` removes those
escapes without changing fixture bytes. The locally replayed 20-case web suite
remains green. Earlier passes do not approve this new head in advance.

Remaining independent acceptance includes rebuilt generated-code scan coverage,
physical-device/lifecycle delivery, provider receipts, live OCR/object storage
and the still-open full end-to-end audit. No finding is suppressed or dismissed.
