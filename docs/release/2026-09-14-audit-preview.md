# Isolated preview preparation — 14 September 2026

The existing preview was serving commit `14de48ea95ef0e11a6bc4addd88e87a83fbdc367`
and starting only the API. The existing EAS `preview` profile targets the old
production API. Neither is evidence for the PR #25 caregiver notification flow.

This change prepares the existing, isolated Render service for the candidate:

- `scripts/audit-preview-start.mjs --apply` retains its exact service, database,
  ordinary owner, schema/checksum and TLS checks. No reset or seed is added.
- It verifies both runtime roles lack elevated privileges and membership in
  the owner or sibling role. The owner connection closes before either child
  starts. Each child receives only its own database credential through the
  existing environment allowlist; providers remain mock/local.
- A supervisor starts the actual worker and API from the same checked-out
  build. An unexpected exit of either stops the pair and returns failure, even
  if the exited process returned zero. SIGTERM/SIGINT drain both, with a bounded
  20-second deadline and failure if a forced kill is necessary.
- `WORKER_READINESS_REQUIRED=true` opts this preview into the existing worker
  freshness, successful-job and matching-commit checks. Production always
  requires these checks regardless of this flag. Ordinary local tests retain
  their existing default.
- The existing build hook produces the same-origin web app during the build.

## Deployment and verification

Only service `srv-daipkbuk1f9s73952trg`, origin
`https://dawaee-audit-preview.onrender.com`, and database `dawaee_audit_db` on
`dpg-daipq80jo6nc73fsmhhg-a` are in scope. Its inspected source is
`audit/e2e-red-white-black-2026-09-09` with commit-triggered auto-deploy enabled.

After the exact candidate passes CI and Security, recheck the preview branch
and service configuration. Fast-forward only that preview branch to the tested
commit, preserving intervening work; do not force it or update `main`. Do not
also trigger a manual deployment when the branch update has already started
one. Record the deploy ID, actual commit, and time in the PR/checkpoint.

Verify `/version` matches the candidate, `/health/ready` has successful schema
and worker checks while openly reporting test mode and mocked providers, and
the web document serves the same-origin app. A second ready response after a
normal tick distinguishes continuing work from a single startup heartbeat.
Review startup/error logs without recording account or clinical data.

## Installed audit build

Use EAS profile `audit-preview` from the same tested commit. It selects the
isolated URL and requires `EXPO_PUBLIC_DEMO=0`. Dynamic Expo config gives it
name `دوائي تجريبي`, scheme `dawaee-audit`, and Android/iOS application ID
`app.dawaee.audit`. Separate installation identity isolates sessions, offline
queues and scheduled local notifications from `app.dawaee.mobile`. The normal
builds retain the static application identity. The EAS project is unchanged.

For an operator with authenticated EAS and the required signing credentials,
the prepared commands from `apps/mobile` are:

```sh
eas build --profile audit-preview --platform android
eas build --profile audit-preview --platform ios
```

These commands have **not** been run by this change. Signing must match the
audit application IDs; physical iOS registration/provisioning and Android push
configuration must be verified for this identity. No store submission is added.
[Expo documents build profiles and their environment settings](https://docs.expo.dev/build/eas-json/).

## Limits and release gates

This is a mock-provider preview for synthetic accounts, not the environment
for accepting real remote notifications. Both processes share one free web
instance. It sleeps after 15 minutes without inbound traffic and loses local
files on restart/sleep; no keep-alive workaround is installed. Consequently it
does not establish dependable background reminders or durable file recovery.
[Render documents these free-instance limits](https://render.com/docs/free).

Production backup/restore evidence and an acceptable recovery build remain
open. Signed Android/iPhone installation, real provider credentials matching
the installed identity, permission/receipt checks, and the
[caregiver acceptance scenarios](../caregiver-push-release-checklist.md) remain
open. Mock dispatch records, a web page, a Metro export, or a ready preview
response cannot close those gates. PR #25 remains Draft; this change does not
authorize a production migration, merge or deployment.
