# Integrations

Current configuration follows `apps/api/src/config.ts`, `.env.example`, the
provider factory and the account-email module. Provider names or flags in old
dated reports do not enable a removed integration.

## Push

Set `PUSH_PROVIDER=expo` and supply `EXPO_ACCESS_TOKEN` through the secret store.
Native device tokens, the correct Expo project and platform signing credentials
must agree. Production startup refuses `PUSH_PROVIDER=mock`.

The worker sends reminders and polls provider receipts. A ticket means provider
acceptance; a successful receipt still does not prove display on a phone. Local
notifications are separately scheduled by the native app from its authorized
cached dose window. See [delivery semantics](PUSH-DELIVERY-SEMANTICS.md) and the
[caregiver release checklist](caregiver-push-release-checklist.md).

## Account email and phone verification

Account email defaults to disabled. Resend requires `ACCOUNT_EMAIL_PROVIDER=resend`,
`RESEND_API_KEY`, `ACCOUNT_EMAIL_FROM`, `ACCOUNT_EMAIL_SENDER_VERIFIED=true` and a
correct HTTPS origin in `ACCOUNT_EMAIL_BASE_URL` (no path, query or credentials). See
[account recovery](release/email-account-recovery.md). Do not count a disabled
provider, a mock response or creation of a token as successful inbox delivery.

Phone verification uses the Firebase integration described in the
[phone-verification release record](release/2026-09-16-caregiver-phone-verification.md).
Caregiver invitation sharing uses the device's user-controlled composer/share
flow. The current provider factory does not implement a Twilio, Unifonic or
WhatsApp delivery channel; their former environment variables are not setup
instructions for this version.

## OCR

`OCR_PROVIDER` accepts `mock`, `google_vision` and
`azure_document_intelligence`. Real implementations use `GOOGLE_VISION_API_KEY`,
or `AZURE_DI_ENDPOINT` plus `AZURE_DI_KEY`, respectively. OCR remains subject to
recorded consent. The user reviews extracted values before saving a medication.
A recognition photo may also be attached without running OCR.

## Private image storage

`STORAGE_PROVIDER=s3` or `r2` requires `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`,
`STORAGE_SECRET_ACCESS_KEY` and the appropriate `STORAGE_REGION`. Supply
`STORAGE_ENDPOINT` for R2 or a custom S3 endpoint; otherwise S3 uses
`https://s3.<region>.amazonaws.com`. Keep objects private. The upload flow presigns, transfers and
finalizes an authorized object before associating its key with medication data.
The web CSP allows the configured storage origin for image/upload requests.
The bucket's CORS configuration must also permit the actual app origin; a CSP
unit test cannot establish that external bucket configuration.

`STORAGE_PROVIDER=local` is for non-production use and is refused in production.
Secret values, signing keys and live signed image URLs must not enter Git or
user-visible diagnostic output.

## Readiness

`GET /health/ready` checks the database, schema contract, required worker jobs
and build agreement. In production it also rejects mocked or unavailable
push/OCR/storage implementations. The normal response exposes only readiness
and failed check categories, not integration details. Account-email readiness
must be checked through its own configuration and a real account flow.
Readiness checks provider configuration; it does not make live delivery or
storage requests to prove the external services are reachable.
