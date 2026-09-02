# Integrations

Each integration is an interface with a real implementation and a recording
mock. The mock runs until credentials are configured, and `/health/ready`
reports which are still mocked. Nothing ever claims a message was delivered
when no provider was reachable.

## WhatsApp — Meta WhatsApp Cloud API

**Only the official Business Platform is supported.** Unofficial personal-
WhatsApp automation violates Meta's terms and would get a real deployment
banned, so there is deliberately no such code path.

```bash
WHATSAPP_PROVIDER=meta_cloud
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...            # X-Hub-Signature-256 verification
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...  # subscription handshake
```

Medication alerts are always business-initiated, so they must use **approved
templates**. Submit these four in WhatsApp Manager with these exact names:

| Name | Body parameters |
|---|---|
| `dawaee_dose_unconfirmed` | `{{1}}` patient, `{{2}}` medication, `{{3}}` time |
| `dawaee_daily_summary` | `{{1}}` patient, `{{2}}` scheduled, `{{3}}` taken, `{{4}}` missed, `{{5}}` adherence % |
| `dawaee_caregiver_invite` | `{{1}}` patient, `{{2}}` invite link |
| `dawaee_low_stock` | `{{1}}` patient, `{{2}}` medication, `{{3}}` days remaining |

Approval typically takes a few days — start it before you need it.

Two guards are enforced in code, not policy: the patient must have granted
`whatsapp_notifications` consent (checked again at send time, so withdrawal is
immediate), and message content carries only who / what / when / unconfirmed —
no diagnosis, no dosage rationale.

Webhook: `POST /v1/webhooks/whatsapp`, signature-verified, stored raw before
being folded into delivery state, so a forged or replayed callback cannot mark
a message delivered that was not.

## SMS — Twilio or Unifonic

Used for OTP and caregiver invitations. Unifonic generally has better
deliverability inside Saudi Arabia; Twilio has broader international reach.

```bash
SMS_PROVIDER=unifonic
UNIFONIC_APP_SID=...
UNIFONIC_SENDER_ID=...
# or
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=...
```

## Push — Expo → APNs + FCM

```bash
PUSH_PROVIDER=expo
EXPO_ACCESS_TOKEN=...
```

Requires a native build; Expo Go will not carry production push. Dead tokens
reported as `DeviceNotRegistered` are deactivated automatically.

On strength: medication reminders use an Android high-importance channel with a
custom sound and lock-screen visibility, and iOS `timeSensitive` interruption
level. iOS *critical* alerts need a special Apple entitlement that medication
apps are rarely granted — the code does not pretend to have it. This is why the
app also schedules local notifications on-device.

## OCR — Google Cloud Vision or Azure Document Intelligence

```bash
OCR_PROVIDER=google_vision
GOOGLE_VISION_API_KEY=...
# or
OCR_PROVIDER=azure_document_intelligence
AZURE_DI_ENDPOINT=...
AZURE_DI_KEY=...
```

Both feed the same parser, so the confirmation screen behaves identically
whichever backend is wired. Arabic is passed first in the language hints —
Saudi packaging is predominantly bilingual.

Sending a photo of a prescription to a third party is a disclosure, so it is
gated on a recorded, revocable `ocr_image_processing` consent (`428` until
granted). OCR output never creates a medication or a schedule.

## Object storage — S3 or Cloudflare R2

```bash
STORAGE_PROVIDER=r2
STORAGE_BUCKET=...
STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
```

Private buckets only. SigV4 presigning is done in-process, so no AWS SDK is
pulled into the runtime image. Production refuses to boot on
`STORAGE_PROVIDER=local`.
