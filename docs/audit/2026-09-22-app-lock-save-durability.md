# N11: Report App Lock persistence failures

The provider discarded the boolean returned by encrypted bootstrap storage and returned before the write completed. The settings screen could display an enabled lock while the preference would be lost on restart. HTTP rejections were also silently swallowed.

The provider now retains the storage result, waits for the latest relevant local snapshot before completing a lock update, and rejects a failed write. Non-network server rejections are surfaced for lock settings. Other preference behavior and serialized storage/server queues remain intact. Current-process lock protection is retained rather than rolled back after a failed durable write.

The App Lock screen catches failures for enabling, disabling, and area selection, displays a localized persistence warning distinct from biometric failure, and disables area controls while saving.

Validation: four new deterministic provider integration cases failed on the previous implementation and pass with the fix: storage false, storage exception, pending durable write while offline, and server rejection. All 69 targeted lock/preference lifecycle tests pass; mobile TypeScript, changed-file ESLint, shared package build, and git diff checks pass. Race harness mocks now return explicit successful storage results.

These tests use controlled host I/O, not a physical device. They prove failure reporting and waiting, not successful writes on every device. Native release and device acceptance remain outstanding. Full CI must pass before candidate promotion.
