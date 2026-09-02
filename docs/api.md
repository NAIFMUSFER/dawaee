# API reference

Base path `/v1`. All endpoints require `Authorization: Bearer <accessToken>`
except the auth endpoints, the public emergency scan and the provider webhooks.

Errors share one shape:

```json
{ "error": { "code": "forbidden", "message": "…", "requestId": "…" }, "meta": { } }
```

`code` is stable and machine-readable; the client maps it to a localized
message. `meta` carries structured detail for the codes that need it —
`duplicate_medication` returns candidates, `high_risk_confirmation_required`
returns the before/after values.

A caller with no access to a profile gets **404**, not 403: returning 403 would
confirm the profile exists. A connected caregiver missing one permission gets
**403**, since they already know it exists.


## Authentication and devices

Phone OTP sign-in, rotating refresh sessions, push token registration.

| Method | Path |
|---|---|
| `POST` | `/v1/auth/otp/request` |
| `POST` | `/v1/auth/otp/verify` |
| `POST` | `/v1/auth/refresh` |
| `POST` | `/v1/auth/logout` |
| `POST` | `/v1/auth/logout-all` |
| `GET` | `/v1/auth/sessions` |
| `POST` | `/v1/devices/push-token` |
| `DELETE` | `/v1/devices/push-token/:deviceId` |

## Account, preferences, consent, profiles, travel mode

One account may own several patient profiles. Medical data never crosses between them.

| Method | Path |
|---|---|
| `GET` | `/v1/me` |
| `PATCH` | `/v1/me` |
| `PATCH` | `/v1/me/preferences` |
| `PUT` | `/v1/me/consents` |
| `GET` | `/v1/profiles` |
| `POST` | `/v1/profiles` |
| `GET` | `/v1/profiles/:profileId` |
| `PATCH` | `/v1/profiles/:profileId` |
| `POST` | `/v1/profiles/:profileId/timezone-check` |
| `POST` | `/v1/profiles/:profileId/timezone-decision` |

## Medications and schedules

Duplicate detection is advisory: it warns with candidates and never blocks. Changes to identity, strength, dose or timing require `confirmHighRiskChange`.

| Method | Path |
|---|---|
| `POST` | `/v1/medications/check-duplicate` |
| `GET` | `/v1/medications` |
| `GET` | `/v1/medications/:medicationId` |
| `POST` | `/v1/medications` |
| `PATCH` | `/v1/medications/:medicationId` |
| `DELETE` | `/v1/medications/:medicationId` |
| `POST` | `/v1/medications/:medicationId/schedules` |
| `PATCH` | `/v1/schedules/:scheduleId` |
| `DELETE` | `/v1/schedules/:scheduleId` |

## Doses, Today, offline sync, adherence

`/v1/today` returns the next dose, the local day, and a 7-day prefetch window the device caches for offline reminders. Every action carries a `clientEventId` the server treats as an idempotency key.

| Method | Path |
|---|---|
| `GET` | `/v1/today` |
| `GET` | `/v1/doses` |
| `GET` | `/v1/doses/:doseId` |
| `POST` | `/v1/doses/:doseId/taken` |
| `POST` | `/v1/doses/:doseId/snooze` |
| `POST` | `/v1/doses/:doseId/skip` |
| `POST` | `/v1/doses/:doseId/undo` |
| `POST` | `/v1/doses/sync` |
| `GET` | `/v1/adherence` |

## Stock and refills

Arithmetic on user-entered quantities. The system never infers how much medication someone should have.

| Method | Path |
|---|---|
| `GET` | `/v1/medications/:medicationId/stock` |
| `PUT` | `/v1/medications/:medicationId/stock` |
| `POST` | `/v1/medications/:medicationId/refill` |
| `GET` | `/v1/stock/low` |

## Family Care Circle and escalation

No caregiver sees anything before explicit authorization, and revocation takes effect on the very next request.

| Method | Path |
|---|---|
| `GET` | `/v1/care-circle` |
| `POST` | `/v1/caregivers/invite` |
| `POST` | `/v1/caregivers/accept` |
| `PATCH` | `/v1/caregivers/:relationshipId/permissions` |
| `PUT` | `/v1/caregivers/:relationshipId/notification-rules` |
| `DELETE` | `/v1/caregivers/:relationshipId` |
| `GET` | `/v1/escalation-policy` |
| `PUT` | `/v1/escalation-policy` |

## Emergency card and QR

The QR is off by default, field-by-field opt-in, resolved inside the database, and killable instantly by rotating the token.

| Method | Path |
|---|---|
| `GET` | `/v1/emergency/card` |
| `PUT` | `/v1/emergency/card` |
| `POST` | `/v1/emergency/qr/enable` |
| `POST` | `/v1/emergency/qr/disable` |
| `GET` | `/v1/emergency/scan/:token` |

## Post-dose notes and measurements

Stored verbatim. Never interpreted, classified or acted on.

| Method | Path |
|---|---|
| `GET` | `/v1/notes` |
| `POST` | `/v1/notes` |
| `GET` | `/v1/measurements` |
| `POST` | `/v1/measurements` |

## Uploads and OCR

Server-generated object keys, magic-byte validation, private buckets, signed URLs. OCR output is a suggestion and writes nothing.

| Method | Path |
|---|---|
| `POST` | `/v1/uploads/request` |
| `GET` | `/v1/uploads/url` |
| `PUT` | `/v1/uploads/local/:objectKey` |
| `GET` | `/v1/uploads/local/:objectKey` |
| `POST` | `/v1/ocr/analyze` |

## Reports and data export

Every report carries its disclaimer keys in the payload so no renderer can drop them.

| Method | Path |
|---|---|
| `GET` | `/v1/reports/weekly` |
| `GET` | `/v1/reports/adherence` |
| `GET` | `/v1/reports/clinician` |
| `GET` | `/v1/reports/export` |

## Admin

System health and delivery failures only. No medical data, by design.

| Method | Path |
|---|---|
| `GET` | `/v1/admin/overview` |
| `GET` | `/v1/admin/deliveries/failed` |
| `GET` | `/v1/admin/deliveries/stats` |
| `GET` | `/v1/admin/jobs` |
| `GET` | `/v1/admin/webhooks/unprocessed` |

## Provider webhooks

Signature-verified, stored raw before being applied.

| Method | Path |
|---|---|
| `GET` | `/v1/webhooks/whatsapp` |
| `POST` | `/v1/webhooks/whatsapp` |

## Health

`/health/ready` reports which integrations are still running on mocks.

| Method | Path |
|---|---|
| `GET` | `/health` |
| `GET` | `/health/ready` |

## Rate limits

| Endpoint | Limit |
|---|---|
| `POST /v1/auth/otp/request` | 8 per 10 minutes per IP, 5 per 15 minutes per phone, 45 s resend cooldown |
| `POST /v1/auth/otp/verify` | 12 per 10 minutes; 5 wrong guesses burn the challenge |
| `POST /v1/ocr/analyze` | 20 per 5 minutes |
| `GET /v1/emergency/scan/:token` | 20 per minute |
| Everything else | 300 per minute, keyed by user where authenticated |

Keying by user rather than IP where possible means one abusive account cannot
lock out a shared network — a hospital, or a family home.

