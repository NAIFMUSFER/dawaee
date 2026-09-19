# Account registration reset — 2026-09-19

The project owner explicitly requested that all previously registered accounts
be removed so users can register again. Production app accounts are in the
application's `public.users`; Supabase `auth.users` contained zero accounts.

## Production action and verification

Committed at **2026-09-19 13:56:19.453965 UTC**. Scope was the ten accounts
inventoried before 13:47:21.389244 UTC; a count and identity-set fingerprint
guarded against touching later signups. No new application release was deployed.

Before committing, an encrypted AES-256 recovery snapshot covering 31 application
tables was saved outside Git. It was successfully decrypted and parsed locally.
It includes the original ten accounts, 17 medications, 387 dose occurrences and
413 dose events. It excludes audit/job/provider/rate logs and external object
bytes. This is a logical data snapshot, not a tested full database re-import.
The encryption key and all account/contact/credential data remain outside Git.

The reviewed SQL was executed first inside an explicit ROLLBACK transaction.
All postcondition assertions passed; a separate read confirmed all ten accounts
were unchanged and no reset audit entry existed. The same bounded transaction
was then committed, with one append-only administrative audit record under
`owner-account-reset-20260919`.

The operation:

- Disabled all ten original accounts using the existing account-disable trigger
  and auth serialization lock. Revoked their sessions and disabled push endpoints.
- Released original phone/email identifiers. Disabled retained rows use unique
  `.invalid` placeholders, allowing fresh registrations to receive new user IDs.
  Removed old password credentials, verification states and recovery challenges.
- Archived ten patient profiles and their 17 medications; disabled schedules.
- Revoked care relationships and invitation capabilities, disabled care alerts,
  revoked emergency QR capabilities, and suppressed queued/sending deliveries.
- Recorded real deletion-request timestamps. The existing 14-day final erasure
  path remains intact; no timestamps were backdated and no trigger/RLS guard was
  disabled. The original rows and image metadata are still retained pending
  physical erasure. This is not an assertion that hard deletion has completed.

Independent post-commit reads found zero original contact identifiers, old
password credentials, unrevoked sessions, active push endpoints, active patient
profiles/schedules, usable care invitations, emergency QR capabilities, email
challenges or queued deliveries. The migration ledger remained at 88 entries;
eight stored-object metadata rows remained. No fresh account had yet registered
at the verification instant. New-registration UI acceptance is still pending.

The one-off operator script is `scripts/ops/reset-accounts-20260919.sql`. It
defaults to ROLLBACK and refuses replay after the audit marker exists. It is not
a migration and must not be added to deployment startup.

## Final erasure blocker discovered after reset

The nominal erasure eligibility is **2026-10-03 13:56:19 UTC**. Do not promise
successful physical erasure on that date before fixing worker storage:

- Production `housekeeping` had 23 failed runs in the preceding 24 hours.
- The last successful complete run was September 16 at 02:52:13 UTC.
- Latest failed-step metadata at September 19 13:55:09 reported two `uploads`
  failures: **Image storage is not configured on this deployment.**
- The failing worker is still production source `63b5b8d`. Its unavailable
  storage provider rejects physical deletes. Per-step savepoints let unrelated
  housekeeping continue, but users with stored objects cannot complete final
  erasure until the provider is correctly configured.
- Bucket, endpoint, access key, secret and region must match the actual private
  storage used by the API. No storage keys were fabricated or exposed. Existing
  object existence has not been verified. Never remove object metadata just to
  turn the cleanup status green; bytes must be checked/deleted through storage.

Production reminders and dispatch continued to record successful ticks after
the reset; both showed zero failed runs in the preceding 24 hours.

## Preview and UI limits

This operation affected production only. Preview uses a separate Render database.
Its SQL connector still fails with EOF / TLS-required errors, and the browser
remains unresponsive during CDP tab refresh after the revoke confirmation.
Preview accounts were not reset. No TLS downgrade or alternative credential
channel was used. Resume the actual patient/caregiver/nurse UI matrix after
browser recovery. Production storage configuration and physical iOS acceptance
remain release blockers; no final build or App Store submission was sent.
