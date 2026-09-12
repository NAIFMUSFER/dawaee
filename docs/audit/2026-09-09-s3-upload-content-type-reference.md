# S3/R2 Content-Type binding: independent verification of a concurrent fix

Branch: `audit/e2e-red-white-black-2026-09-09`; PR #14 remains DRAFT.
This continuation adds tests and evidence only. No merge, deployment,
production mutation, real upload, OCR call, notification send, migration,
RLS or dependency change was performed.

## Proof before changes

Inherited head `c949b3d5be9c00bb2e3d36b632bf402fd53822f8` adds only
`s3-upload-content-type-binding.test.ts`. That red test existed before this
continuation and is retained unchanged.

CI #260, run `34367803938`, PostgreSQL 17 job `102520943576` checked out
synthetic PR merge `421c6dbfd87b9c8ed7dd801948713a2dfd747e8e`
(c949b3d5 into main 4cf23531). At 2026-09-09T15:09:09Z it reported
99 passing files, 1 failing file; 1,432 passing tests, 1 failing test.
The sole failure was `s3-upload-content-type-binding.test.ts:39:39`:
`expected [ 'host' ] to include 'content-type'`.
RLS probes, non-superuser migrations and managed-Postgres smoke passed.
Bootstrap error-boundary tests passed 15/15.

The local baseline storage.ts copy was checked against Git blob
`84f433891819a8bacc48958e888ae6f7a5a0e46e` (11,972 UTF-8 bytes).
Baseline lines 178 and 186 sign only host; line 205 creates a PUT signature
without the Content-Type returned at line 207. This proves a signature
contract defect, not an affected production user or a live bucket exploit.

## Concurrent work preserved

While the independent proof and a local candidate were being tested, the
branch advanced to `5adc4f45fa1cbc0df0befe03a66859b3ab9e2fd5` with the
S3StorageProvider fix. Its exact source was reconstructed and verified against
Git blob `d6c194009f6e975a0f1ad324ba9ffe72fc07e98a` (12,780 bytes).
The same independent comparisons passed 10/10 on that source. The local
candidate is NOT committed; the concurrent runtime fix is preserved unchanged.

## Independent reference and permanent regression

Offline reference generation used installed AWS botocore 1.43.18
S3SigV4QueryAuth, synthetic credentials and fixed timestamp
2026-09-09T12:34:56Z. No service was contacted. The complete actual TypeScript
provider was transpiled and executed under Node 22.16.0 with synthetic config,
controlled Date and an intercepted DELETE fetch.

| Exact source | Four image types, S3 + R2 | GET / DELETE controls | Total |
| --- | --- | --- | --- |
| c949b3d5 baseline | 0/8 | 2/2 | 2/10 |
| Local candidate (not committed) | 8/8 | 2/2 | 10/10 |
| Concurrent 5adc4f45 | 8/8 | 2/2 | 10/10 |

New permanent `apps/api/test/s3-upload-signature-vectors.test.ts` adds 14 cases:
four allowed image types for both provider names, changed/omitted Content-Type
SDK-reference comparisons, and unchanged GET/DELETE reference signatures.
The expected signatures come from botocore, not a copy of the production signer.
This does not introduce an AWS SDK dependency into the application or CI.

To regenerate: use AWSRequest(method=method, url=endpoint + '/' + bucket + '/'
+ key, headers={'Content-Type': type}), S3SigV4QueryAuth(credentials, 's3',
'eu-central-1', expires=900), patch botocore.auth.get_current_datetime to the
fixed timestamp, then add_auth. All synthetic inputs are in the permanent test.
For GET omit Content-Type and use expiry 300; DELETE omits it with expiry 120.

Local focused proof is NOT the full Vitest/PG/mobile/security run. Final-commit
CI and security results must be verified separately before any release claim.

## Remaining release gates

The Render list_services call in this continuation requires an explicitly
confirmed workspace selection; no workaround or fresh production-health claim
was made. Physical iOS/Android, actual Push/escalation receipts and revocation,
live OCR/object lifecycle, bucket CORS/configuration and byte validation remain
unverified. Header signing does not prove image contents, enforce bucket size,
make URLs one-use, or revoke already issued URLs. End-to-end audit remains OPEN.
