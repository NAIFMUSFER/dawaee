# Email recovery and user-sent caregiver invitations

The owner chose email password recovery and device Messages invitations on
2026-09-18. The Twilio Verify and server invitation-SMS additions were removed.
There are no Twilio credentials, service IDs or runtime switches in the current
application configuration. This does not delete services in an external Twilio
account or confirm that manually entered hosting secrets have been removed.

## Account behavior

- Newly registered users visit Settings → Email and account recovery. Existing
  signed-in users can open the same screen. A pending caregiver invitation is
  retained when leaving email setup.
- Enter an email and the current password to request ownership verification.
  The existing login email is unchanged until the link is confirmed. Existing
  stored emails are **not** automatically considered verified.
- Forgot password requests an email link. The response is identical for unknown,
  disabled, unverified and verified accounts; only eligible verified mailboxes
  get a queued message. No account identifier or bearer token is returned.
- Verification links expire after 30 minutes; reset links after 15 minutes.
  Links have 256-bit random secrets. Only their SHA-256 hashes and encrypted
  delivery jobs are stored. Tokens remain in the URL fragment, are removed from
  browser history immediately, and are never sent in query parameters.
- Opening a link performs no mutation. The user must confirm the action. Reset
  validates password strength and atomically revokes all sessions and active
  push tokens. Replaced, expired, wrong-purpose and credential-stale links fail.
  An identical reset retry can acknowledge the same completed operation; a
  different password or subsequent credential change cannot reuse it.
- Changing the account email invalidates ownership verification and reset
  challenges, including email edits made through older client APIs.
- The API polls a durable encrypted outbox. Database leases prevent overlapping
  claims; provider idempotency keys stay stable across bounded retries. Delivery
  payloads are cleared on acceptance or expiry. Provider acceptance is not proof
  of inbox delivery. Requests do not wait for provider network responses.
- Anonymous and authenticated requests have durable IP, account, recipient,
  token and global budgets. Logs redact passwords, email, payload and tokens.

Caregiver invitations create a link/QR and open the device Messages composer on
explicit action. The user sends the SMS from their own phone. No server SMS
provider is used for invitation delivery. Existing Firebase phone-ownership
verification for caregiver acceptance and legacy installed-client recovery API
compatibility remain; the new forgot-password screen uses email only.

## Deployment configuration

Apply migration `0086_account_email_recovery.sql` using the normal migration
role before enabling the new API. It installs restricted verification/challenge
tables and SECURITY DEFINER operations. The mail queue is API-owned and grants
no additional worker access.

Default configuration is disabled. After verifying the owner's actual sending
domain with Resend, configure these on the API service only:

```dotenv
ACCOUNT_EMAIL_PROVIDER=resend
ACCOUNT_EMAIL_FROM=accounts@mail.your-owned-domain.example
ACCOUNT_EMAIL_SENDER_VERIFIED=true
ACCOUNT_EMAIL_BASE_URL=https://your-api-origin.example
RESEND_API_KEY=<server secret stored in hosting configuration>
```

The example domains above are placeholders. `ACCOUNT_EMAIL_FROM` must be a
plain address on the verified sending domain. `ACCOUNT_EMAIL_BASE_URL` must be
an HTTPS origin serving `/account-email` and the API on the same origin; no path,
query or credentials. The current API origin can be used until a custom API
hostname is configured. Do not point this value at a parked registrar page.

The owner has a GoDaddy domain but its exact name is not yet available in this
session. Resend returned no sending domains. GoDaddy requires sign-in. Use the
actual DNS records supplied by Resend for that domain, verify sending readiness,
and configure an appropriate DMARC policy before activation; preserve existing
mail/MX configuration. Never publish provider keys in the mobile app or Git.
The sender-ready flag is an operator assertion, not an automated DNS check.

Render's connector has no selected workspace and explicitly requires the owner
to confirm the workspace before selection. No production environment variables,
DNS records or Twilio account resources were modified during this change.

## Verification and rollout limits

Focused tests cover real SQL execution through PostgreSQL WASM (PGlite), HTTP
boundaries with mocked I/O, provider transport/encryption, browser-form behavior,
mobile recovery/settings lifecycle, and manual invitation regressions. All 86
migrations are applied to the SQL test database using the migration role. Raw
app/worker access, account binding, expiration, replay, password/session
invalidation, queue leases and stale acknowledgements are exercised.

PGlite uses one connection. These tests do not prove native PostgreSQL concurrent
interleaving. Run the existing native PostgreSQL authorization/recovery suites in
CI before merge/deployment. No live email or SMS was sent. No new native build or
TestFlight upload was performed. Real mailbox receipt, reset from a physical
phone, pending-invitation continuation and Messages sending remain device and
service checks after configuration/deployment.
