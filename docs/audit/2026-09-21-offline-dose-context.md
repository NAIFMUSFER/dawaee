# Restored offline dose context — 2026-09-21

Base: `75a826b`. The earlier local `21417da` object is unavailable; this repair
was reimplemented and verified against the candidate.

The existing encrypted, account/profile-bound schedule cache now retains the
medication form, strength, instructions, medication notes and per-dose notes.
Today restores these fields when the API is unreachable. New cache fields are
optional; older envelopes remain readable with explicit empty/null fallbacks.
No plaintext storage, delegated offline access or change to dose actions was
introduced. An image key remains an identifier, not an offline photo download.

Before the source change, two real-Today harness scenarios failed because the
cached clinical text disappeared; nine existing scenarios passed. After repair,
37 focused Vitest cases passed across JSON persistence, offline Today, bootstrap
ownership and queue races. Mobile TypeScript, changed-file ESLint and diff checks
passed. One initial Vitest attempt stopped before tests because two generated
entry bundles remained locally; only the generated export was removed, and the
unchanged original global build/setup passed on the repeated run. No build guard
was weakened or bypassed.

CI/security on the published head, hosted deployment and a physical-device
check remain required. No real patient data or hosted accounts were modified.
