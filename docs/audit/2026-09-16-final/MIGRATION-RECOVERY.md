# Preview migration recovery

## Evidence

- Target: `dawaee-audit-preview`, `srv-daipkbuk1f9s73952trg`; dedicated `dawaee_audit_db` only.
- Diagnostic commit: `fc9ec556338a10751617ca6981ff7979753270b9`.
- Render deploy: `dep-dalfsj9srm7s73ctf580`.
- 2026-09-16 20:40:43 UTC: `AUDIT_MIGRATION_CHECKSUM_MISMATCH file=0078_push_receipt_token_generation.sql`.
- **FAIL confirmed:** a shipped migration was subsequently edited. The strict migrator correctly refused it. This is separate from the earlier dependency-cache build failure.
- Direct external database inspection remains **BLOCKED** by the connector's TLS failure. No Shell access was obtained. Diagnosis used the authorized preview process's existing database connection, without opening network access.

## Repair

Keep the current portable 0078 and archive the exact original bytes from commit `4265c787b2d2da8edf50fc73caad9f322dff86f0` under `db/history` (never automatically executed there). Recognize only the pair of shipped MD5 checksums for this exact filename:

- Original: `ec497f38ff1917c25496d7b5e60b26c9`.
- Current: `a24625df6ace47e998761c803c8b5ee2`.

`migration-history.mjs` defines this one compatibility case for both the migrator and preview post-migration verification. A different filename, unknown historical checksum, or another modification to current 0078 still fails. No database checksum is replaced and no historical ledger row is removed by the repair.

New migration `0085_push_receipt_portable_hash.sql` converges the function definition with PostgreSQL's core SHA-256 implementation. It preserves token-generation binding and worker-only execution permissions. Fresh installations use current 0078, then 0085. Existing installations with either shipped 0078 converge through 0085. The normal transaction commits its DDL and ledger entry together. Preview runtime starts only after the complete ledger is verified.

## Validation and deployment gates

- **PASS:** initial secret-safe diagnostics: 16 local tests; ESLint.
- **NOT VERIFIED (pending CI):** new real PostgreSQL regression reconstructs the original function and historical ledger only in disposable `dawaee_test`, runs the actual migration script, verifies retained history, corrected function and permissions, repeats deployment, and rejects unknown history.
- Only deploy the repair to the isolated preview after PostgreSQL 16/17 regression gates pass. Do not use a successful build as evidence that the schema or phone journeys work.
- Production deployment and production migration remain prohibited by the user.
- Once preview starts, verify `/version` matches the tested repair commit and verify API/worker readiness; then synthetic dose/inventory acceptance. Provider delivery, installed phone source and physical touch remain **NOT VERIFIED** until independently exercised.

## Rollback

Do not reverse 0085 or rewrite 0078 ledger entries. It is a compatible function replacement. If application rollback is needed, use a reviewed source version compatible with the retained ledger; 9473638 itself still rejects the historical 0078 checksum. Stop the preview rollout on any unknown checksum or permission failure. No destructive down migration is supplied.
