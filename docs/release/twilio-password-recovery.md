# Optional Twilio Verify for password recovery

Implemented for review; the default remains `PASSWORD_RECOVERY_PROVIDER=firebase`.
No production credentials, API deployment, live SMS delivery or new iOS binary
are established by these code changes. The supplied Verify service SID is
`VA26d6f1831a5a1ec8203a6a115ae40b89`; this identifier is not an API secret.

## Dashboard and server setup

1. In the same Twilio account, keep Verify SMS enabled, the code length at six,
   default templates selected, custom code generation disabled and Fraud Guard
   enabled. Allow Saudi Arabia in Verify Geo Permissions. The app supplies
   `Locale=ar` or `en`; changing the dashboard preview is not a runtime language
   setting. A branded sender appearing in a preview does not establish carrier
   registration or handset delivery.
2. Resolve the account's displayed requirement to upgrade and obtain an approved
   Primary Compliance Profile before sending to arbitrary recipients. A trial
   test requires a recipient verified in Twilio. No number purchase is needed
   solely for Verify. See [Verify quickstart](https://www.twilio.com/docs/verify/quickstarts/node-express)
   and [Verification API](https://www.twilio.com/docs/verify/api/verification).
3. Create a suitable restricted API key with the required Verify permissions,
   or a Standard key, in US1 for that account. The adapter uses
   `verify.twilio.com` and Basic authentication with the API key SID and secret.
   It does not need a Main key. See [API keys](https://www.twilio.com/docs/iam/api-keys).
4. Deploy the reviewed API with the existing migrations through
   `0084_password_recovery.sql`. No new migration is introduced. Store these
   values only in the API service's environment (Render for this application):

| Variable | Value |
| --- | --- |
| `PASSWORD_RECOVERY_PROVIDER` | `twilio`, only after setup is ready |
| `PASSWORD_LOGIN_ENABLED` | `true` |
| `TWILIO_ACCOUNT_SID` | Account SID starting `AC` |
| `TWILIO_API_KEY_SID` | API key SID starting `SK` |
| `TWILIO_API_KEY_SECRET` | That key's secret |
| `TWILIO_VERIFY_SERVICE_SID` | `VA26d6f1831a5a1ec8203a6a115ae40b89` |

Never place the key secret or account Auth Token in `EXPO_PUBLIC_*`, mobile
config, source control, screenshots or chat. If sharing the existing invitation
key, it must have both Messaging and Verify permissions. A `VA` service handles
verification; an `MG` Messaging Service handles invitation texts. The latter
still needs its separate sender/URL eligibility and approval; see
[caregiver SMS setup](twilio-caregiver-invitations.md).

## API and client behavior

- Anonymous `GET /v1/auth/password/recovery-options` returns only the provider
  and configuration availability. It does not test credentials or delivery.
  An older API's 404 keeps the Firebase flow; network/503/malformed responses
  show unavailable, without silently switching provider. Installed clients
  using the existing Firebase `idToken` contract continue to work.
- `POST /v1/auth/password/recovery/start` accepts a canonical Saudi mobile only.
  It does not look up account existence. All valid numbers have the same send
  path, bounded before any provider call. The response is an encrypted
  challenge token, never an OTP or account identifier.
- `POST /v1/auth/password/recovery/check` accepts only that challenge and the
  six-digit code. It checks the exact bound `VE` verification SID and accepts
  only `approved`, with matching account, service, destination and channel.
  See [Verification Check](https://www.twilio.com/docs/verify/api/verification-check).
- The resulting encrypted proof has a distinct audience; a challenge, login
  JWT or client-supplied phone/user ID cannot serve as recovery authorization.
  `POST /v1/auth/password/recover` accepts this proof and the new password. It
  reuses the existing atomic recovery function, which refuses unknown/disabled
  users, consumes a stable provider verification key, changes the password,
  revokes sessions and deactivates push tokens. Same-proof/same-password retries
  are idempotent; a different password or a later credential change is refused.
- The client keeps challenge/proof in screen memory, clears them on restart or
  unmount, blocks duplicate actions and ignores late results after leaving.
  Password save only reports success after the API confirms `updated: true`.
  Neither proof is written into navigation or persistent client storage.

## Limits and failure behavior

- Durable fixed-window send budgets: 10/IP/hour, 1/phone/minute, 5/phone/hour and
  100 total/day. These are attempt limits, not SMS-segment billing limits;
  fixed-window boundaries can permit bursts. Failed sends count. The client
  adds a 60-second cooldown even after ambiguous timeouts.
- Checks use existing 30/IP/10-minute and 10/phone/10-minute limits, plus
  5/verification/5-minute window. Password saving also uses the existing IP
  and phone budgets. Database failure blocks sending/checking.
- Tokens expire five minutes from Twilio's original `date_created`. Resends do
  not extend this window. Twilio normally retains its verification for ten
  minutes, so an expired local flow may need to wait for that verification to
  expire before a fresh one can start. Do not refresh the original timestamp:
  that would let an older challenge cross a later password change.
- Provider calls time out at ten seconds and never automatically retry.
  Twilio can accept an SMS before a network failure. If a successful code check
  response is lost, Twilio may already have consumed the verification and a
  fresh request is needed; no durable check-response replay cache is included.
  A lost password-save response is safely retryable with the same proof/password.
- Logs redact both token fields, codes, passwords and phone numbers. Raw
  provider responses/errors are not logged. This does not imply the SMS
  provider or carrier processes no personal data.

## Validation and rollout

Local validation: 111 targeted tests passed across 11 suites. Eleven unrelated
log/database cases were excluded by the test-name filter. Workspace and mobile
TypeScript checks, changed-file ESLint, backend builds and web export passed.
The real PostgreSQL suites and a signed native build were not run in this update.

Provider HTTP is mocked in automated tests. The focused suite covers malformed
provider responses, exact-SID approval, encrypted token purpose and expiration,
rate-limit rejection, strict identity binding, SQL handoff, old Firebase clients,
Arabic phone/code input, duplicate actions, outages and leaving the screen.
The route boundary tests mock SQL; they do not replace the existing real
PostgreSQL recovery concurrency/session-revocation suite, which must run in CI.

After deployment and explicit authorization for a chosen recipient, test one
existing account on a handset: request the SMS, reject a wrong code, verify the
right one, set a new password, confirm the old password/session stop working and
sign in with the new password. This PR has not performed that live test.
The broader patient-feedback changes require a new native TestFlight build.
To stop new Twilio recovery sends, set the provider back to `firebase` and
restart the API; Firebase recovery then still requires its own working setup.
