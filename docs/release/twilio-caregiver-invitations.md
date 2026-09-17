# Optional Twilio caregiver invitation SMS

Status: implemented for review, **disabled by default**. No real credentials,
approved sender, production deployment or handset delivery is established by
this change. It only sends caregiver invitation links. Firebase phone proof,
login/recovery and medication/missed-dose notification channels are unchanged.

## Eligibility before purchase

[Twilio's Saudi Arabia guidelines](https://www.twilio.com/en-us/guidelines/sa/sms)
require a registered alphanumeric sender. The same page states Twilio cannot
register Sender IDs for **domestic Saudi brands**. Buying a foreign phone number
does not resolve this restriction. Establish the true legal brand location and
provider eligibility before paying for service. If TADAWEE is a domestic Saudi
brand, use a provider able to register and serve that brand; do not submit it as
an international brand. Keep this Twilio adapter disabled in that case.

For an eligible brand, open Twilio's
[Sender ID registration](https://console.twilio.com/us1/develop/phone-numbers/sender-ids/applications/create)
and select Saudi Arabia. Supply the actual business/sender information requested
by Twilio and wait for approval. Invitation links also require URL allowlisting;
shortened URLs are prohibited. Register the actual HTTPS origin/path used for
`PUBLIC_APP_URL` and validate `/invite#/invite/<token>` on a phone. The default
domain in source is not evidence of domain ownership or a working deployment.

## Server setup after approval

1. In **Messaging → Services**, create a Messaging Service for transactional
   caregiver invitations. Add the approved alphanumeric sender to its Sender
   Pool. Confirm Saudi destination permissions and sender eligibility. Keep
   link shortening disabled. See [Messaging Services](https://www.twilio.com/docs/messaging/services).
2. Create a server API key for the same account in US1 (this adapter uses
   `api.twilio.com`). Use a suitable restricted messaging key where available,
   or a Standard key; a Main key is unnecessary. The secret is shown on creation.
   See [API keys](https://www.twilio.com/docs/iam/api-keys).
3. Deploy the reviewed API code with the existing database migrations applied.
   This feature uses the existing invitation channel and rate-budget function;
   it adds no migration. Configure **only the API service's secret environment**:

| Variable | Value |
| --- | --- |
| `CAREGIVER_SMS_PROVIDER` | `twilio` |
| `CAREGIVER_SMS_SENDER_APPROVED` | `false` until sender and URL approval are confirmed; then `true` |
| `TWILIO_ACCOUNT_SID` | Account SID beginning `AC` |
| `TWILIO_API_KEY_SID` | API key SID beginning `SK` |
| `TWILIO_API_KEY_SECRET` | That key's secret |
| `TWILIO_MESSAGING_SERVICE_SID` | Service SID beginning `MG` |
| `PUBLIC_APP_URL` | The working, approved HTTPS application origin |

Do not put keys in mobile config, `EXPO_PUBLIC_*`, Git, screenshots or chat.
The approval flag records an operator's confirmation; it does not query Twilio
or prove approval. Missing settings leave availability false. The authenticated
`GET /v1/caregivers/delivery-options` returns only `{ "smsAvailable": boolean }`.
That response means configuration is present, **not** that carrier delivery was
tested. Setting the provider to `disabled` and restarting stops new sends.

## Sending behavior and limits

- Only an authenticated profile owner may create the invitation. The server
  normalizes the destination and sends only to Saudi mobile numbers. The client
  cannot provide arbitrary SMS body text. Link/QR-only requests never send SMS.
- When available, SMS is initially selected on the mobile invitation form with
  a notice that creating the invitation sends a text. A patient's explicit
  link/QR choice is preserved. Old/unavailable APIs retain link/QR plus the
  explicit device Messages composer after creation.
- Each server SMS uses a generic Arabic template without the patient's name,
  medication or clinical information. The invitation remains a sensitive
  bearer link; the normal verified-phone acceptance check still applies.
- Database commit precedes the external send. No database connection is held
  during provider HTTP. Failed/ambiguous delivery still returns the QR/link.
  There is no automatic provider retry, background outbox or delivery callback.
  A crash after commit can therefore leave a pending invitation unsent.
- Fixed-window, database-backed attempts: 20 per IP/hour, 5 per account/hour,
  1 per recipient/5-minute window, 3 per recipient/day and 100 total/day.
  These count attempts, not billable SMS segments. Boundary bursts are possible
  with fixed windows. Failed sends consume budgets; identifiers are HMAC hashed.
- API timeout is 10 seconds. Twilio `accepted`/`queued` is displayed as accepted,
  never as confirmed handset delivery. Timeout/5xx is `unknown` and is not
  automatically retried. A manual resend after an unknown outcome can duplicate
  a message. Rapid submit taps are blocked locally, but this is not an
  exactly-once delivery system.
- The request sets content retention to `discard`, address retention to
  `obfuscate`, validity to 600 seconds, and disables URL shortening. Provider
  errors and credentials are not logged. These settings do not imply zero
  processing/retention by the provider or carrier. See the
  [Message resource](https://www.twilio.com/docs/messaging/api/message-resource).

## Verification before enabling for patients

Automated tests mock all outbound HTTP and do not send messages. They cover
disabled/missing setup, destination validation, transport outcomes, ownership,
commit ordering, budget rejection, old-API fallback, profile changes and
duplicate taps. Existing caregiver acceptance/RLS protections remain in place.

After provider approval and explicit consent from a chosen test recipient,
create one invitation in the app, verify the real handset receives it, open the
link and complete the existing verified-phone acceptance flow. Confirm QR and
manual sharing work when automatic sending is disabled. Check provider delivery
status for this authorized test without sharing credentials or invitation links
in logs/screenshots. No real test send is authorized or performed by this PR.

The broader patient-feedback release still needs a new signed iOS build and
physical-device checks; the earlier TestFlight build does not contain these
changes.
