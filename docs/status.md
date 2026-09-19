# Current status — 19 September 2026

The active full audit continues PR #32. Its [evidence and remaining release
gates](audit/2026-09-19-full-audit.md) supersede unversioned early-project counts
and integration claims. Dated reports remain historical evidence.

## Observed release state

- Production API and worker were verified at `63b5b8d33a502b8e3d3cd2ca94b1855266665f90`.
- iOS 0.1.0 (6) is in TestFlight. The user confirmed one real notification after
  the APNs configuration repair on 19 September.
- Build 7 was built from an earlier revision and held from submission for this
  audit. It is not evidence for the new fixes or an approved final release.
- The audit baseline is PR head `9a39df8eb829a771dd2fe51f47d3cfdc4e6442d5`.
  Current repairs require their own CI, isolated preview and device evidence.

## Implemented surfaces

The shared Expo app supports patient, caregiver and nurse workflows: medication
photos and schedules, dose actions and notes, history, family invitations and
permissions, stock, measurements, reports, privacy and notification settings.
A readable PDF summary and complete JSON export are distinct outputs. Current
provider configuration is documented in [integrations](integrations.md).

A feature appearing in source does not establish that all of its user journeys
work. The current audit records automated checks separately from actual browser
and physical-device trials. No clinical validation, external penetration-test
certification, or large-scale capacity guarantee is claimed.

## Required before the final app

Complete the patient/caregiver/nurse UI matrix on the repaired revision, required
CI/security checks and deployment agreement. Recheck real account verification,
private image upload, invitation acceptance/revocation, offline conflict recovery,
notification delivery while open/locked, and native lock/share behavior. Follow
[the production release runbook](PRODUCTION-RELEASE-RUNBOOK.md) for the concrete
release window and compatible recovery evidence.
