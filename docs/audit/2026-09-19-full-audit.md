# Full audit checkpoint — 19 September 2026

Status: repairs and verification in progress; **not final release approval**.
This continues [PR #32](https://github.com/NAIFMUSFER/dawaee/pull/32).

The later [legacy-audit reconciliation](2026-09-19-legacy-audit-reconciliation.md)
supersedes broad closure claims below. In particular, public lockout responses,
legal/release prerequisites and device/UI acceptance remain open. The later
[invitation/deletion/notification checkpoint](2026-09-19-invitation-deletion-notification-review.md)
records source repairs and their bounded evidence for those paths. Baseline evidence below is historical.

## Baseline and method

The PR baseline is `9a39df8eb829a771dd2fe51f47d3cfdc4e6442d5`, tree
`f1c3cb8987bdfd3a94327906e23e3c573bfae276`. The local audit checkout initially
used commit `fdbe31f2c0cc5977a7ed668b961d0e1d81f4e477`; its tree was verified
identical before work. Production API/worker were observed at
`63b5b8d33a502b8e3d3cd2ca94b1855266665f90`.

All 850 tracked baseline files were read before edits, tests or builds in this
audit. Patient, caregiver, nurse and engineering reviews covered source,
contracts, SQL, tests, assets, deployment scripts and documentation. Findings
were traced across input, persistence, authorization and visible output before
repairs. Generated dependencies were not treated as project-authored files.

## Repair bundles

| Area | Confirmed problem and repair |
|---|---|
| Recognition photo | Add/edit/capture share a private finalized image upload, independent of optional OCR. Manual fallback retains the correct photo; retake clears the old image key. Web storage origin is explicitly allowed by CSP. |
| Medication integrity | Arabic/Persian numeric input is parsed consistently; invalid values do not silently clear saved fields. Dates constrain schedule materialization; historical doses with notes/events/measurements/stock records are preserved. Historical exports use dose snapshots and medication IDs. |
| Notes and permissions | A confirm-only caregiver can read their own notes back without gaining general history access. Owned dependent profiles and revoked access are handled consistently in the UI. Clinical writes record the caregiver role. |
| Offline dose actions | Pending actions overlay authoritative cached data until acknowledged. Reconnect/foreground retry and session fences prevent lost or cross-account work. Rejected sync removes the optimistic result and shows a generic visible notice. Frozen action timestamps and private replay/order checks reject stale conflicts. |
| Automatic stock | Confirm-only actions deduct stock and undo the matching movement atomically without granting manual stock editing. Event identity, actor/profile binding, same-transaction creation, replay, clamping and unit checks bound the helper. |
| Reminders | Snooze intent is independent of escalation stages. Dispatch revalidates current dose/stock state and lease; grouped payloads are rebuilt. Quiet-hour work remains pending, overdue digest selection is bounded, and reminder scanning uses fair paging. |
| Identity and privacy | Worker email verification checks the exact active relationship. The candidate now refuses locked password attempts uniformly without checking the real hash, and adds a shared post-authentication account budget while retaining the early address guard; see [lockout](2026-09-19-password-lockout-oracle.md) and [account-budget](2026-09-19-authenticated-account-rate-budget.md) evidence. Identifier-budget denial remains open. Warm native invitations parse allowed links. Sensitive modals and report output respect account/profile/app-lock boundaries. Emergency QR retry retains its in-memory capability and states offline uncertainty. |
| Reports | Readable PDF summary and complete JSON export are separate actions. Temporary outputs are cleaned up and cancelled on scope/lock changes. |
| Operations | Fresh Compose setup uses restricted runtime roles and the normal migration ledger. Orphan recovery refuses nonempty partial schemas. Terminal notification retention has a bounded worker DELETE policy. Current setup documents replace obsolete provider claims. |

New migrations 0089–0093 are additive; applied baseline migrations have not been
rewritten. Native PostgreSQL CI must verify both their privileges and complete
migration behavior before production deployment.

## Evidence at this checkpoint

| Verification | Result / limit |
|---|---|
| Read-before-edit coverage | Complete: 850 tracked baseline files. |
| Backend TypeScript | Passed after rebinding local workspace package links to the actual audit checkout. |
| Mobile regression checks | Full mobile suite passed 994/994; targeted final queue/action and output-visibility regressions also passed. Mobile TypeScript passed. |
| Backend / web build | `npm run build` passed for shared/core/API/worker. An explicit Expo web export against the isolated preview URL passed. GitHub full candidate gates remain pending. |
| Focused SQL/domain checks | 20 API PGlite scenarios and 16 worker SQL scenarios passed, alongside core/shared/time/date tests and migration/identity checks. |
| SQL in this workspace | PGlite with actual migrations and restricted roles exercises API/worker findings. It cannot prove separate PostgreSQL connections or Docker execution. |
| Previous PR CI | Baseline had two missing-notification-mock fixture failures; the audit repairs those fixtures. Previous security PASS does not transfer to the candidate. |
| Cloud browser | A fresh session opened successfully and securely authenticated. Actual production patient navigation reached Today, medications, the existing synthetic medication detail/edit, settings, accessibility, phone-link entry, email-status refresh, notification settings and travel. Font increase changed the displayed size and decrease restored it. Phone/email entry screens were inspected without replacing account credentials. Candidate repairs are not yet deployed, so these are baseline observations only. |
| Three-role repaired UI | Pending isolated preview deployment and actual patient/caregiver/nurse trials. |
| Real iOS notification | User confirmed one alert after APNs repair. No blanket foreground/locked/offline delivery claim. |
| Final iOS app | Not submitted. Build 7 predates the audit repairs and is held. |

## Remaining interface and release matrix

- Patient: phone/email registration and recovery, image add/change/remove and dose
  confirmation card, notes write/read, Taken/Skip/Snooze/Undo with history and
  stock, offline rejection, all settings and output buttons, Arabic/English and
  elderly layout.
- Caregiver: invitation creation/sharing/acceptance/revocation, verified identity,
  patient switching, each permission combination and own-note readback, dose
  attribution and stock effect, summaries and escalation settings.
- Nurse: multiple authorized patients, clinical notes/measurements/reports,
  permission loss during a screen or request, quiet hours and alerts.
- Native device: notification presentation while open/locked/offline, tap routing
  after process restart/profile change, photo picker, temporary sharing, app-lock
  modal layering and account changes.
- Engineer: exact candidate CI/Security on PostgreSQL 16/17, Docker/migrations,
  isolated preview identity, production recovery/readiness, then a native build
  from the verified revision.

Keep synthetic test data distinct from real patient records. Do not put account
credentials, signing keys, private image URLs or health records in this report.
Each future result must name the revision/environment and distinguish provider
acceptance, UI observation and physical-device evidence.
