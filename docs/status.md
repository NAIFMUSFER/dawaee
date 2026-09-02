# Status — what is done, and what is not

Written to be read by someone deciding what to trust.

## Verified by running it

| Area | Evidence |
|---|---|
| Domain engines | 179 unit tests, including DST transitions, ambiguous and nonexistent local times, the brief's 30-tablet stock scenario, and the full 20:00→20:35 escalation ladder |
| API | 72 integration tests against a real PostgreSQL |
| Cross-patient isolation | 30 adversarial SQL assertions, all passing; CI gate |
| Escalation end-to-end | Real API + real worker: patient at 20:00, repeat at 20:10, WhatsApp to the primary caregiver at 20:30, confirmation at 20:35, **no** secondary alert at 21:00 |
| Offline replay | Batch sync applied once, replayed idempotently, stock not double-decremented |
| Scale | 50 medications on one profile; list and Today render in ~1.3 s |
| Arabic RTL | Rendered in a browser and inspected; bidi-isolated measurements; localized units |
| Elderly mode | Rendered and inspected: 35 % larger type, larger targets, fewer secondary actions |
| English LTR | Rendered and inspected |
| Mobile typecheck | `tsc --noEmit` clean across 37 screens |
| Web build | `expo export` succeeds; served and driven end-to-end with zero runtime errors |

## Built, correct by construction, not yet exercised against a live provider

These have real implementations and recording mocks. The mock is what runs
until credentials exist, and `/health/ready` says so.

| Integration | What is missing |
|---|---|
| WhatsApp Cloud API | A Meta Business account, phone number ID, access token, and **approved message templates** (the four names are in `providers/whatsapp.ts`) |
| SMS | Twilio or Unifonic credentials |
| Push (APNs/FCM) | An Expo project and a native build; the token registration and receipt handling are written |
| OCR | A Google Vision or Azure Document Intelligence key |
| Object storage | An S3 or R2 bucket |

The SigV4 presigner, the HMAC webhook verification, the template payloads and
the retry/backoff logic are all written and typechecked — but code that has
never met the real API is not the same as code known to work against it.

## Not built

- **Native iOS/Android binaries.** The app runs on Expo Web and the source is
  complete, but producing signed builds needs an Apple Developer account and a
  Google Play account.
- **Caregiver web portal.** The API supports it fully; the Next.js front end is
  not written. The mobile app covers the caregiver flows today.
- **PDF report export.** Reports render in-app and share as text. PDF
  generation is not implemented.
- **Widgets, smartwatch, voice assistants.** The architecture supports them —
  dose confirmation is an idempotent API call with a client event id — but no
  platform extension is written. These are P2 in the brief.
- **Barcode → medication database lookup.** Barcodes are captured and stored;
  there is no lookup against a national medicines register (SFDA has no public
  API).
- **Admin UI.** The admin endpoints exist and are permission-gated; there is no
  front end.
- **Load testing.** Correct at 50 medications on one profile; behaviour at
  10,000 concurrent patients is unmeasured.

## Explicitly not claimed

- No compliance certification of any kind (PDPL, HIPAA, GDPR). The architecture
  follows privacy-by-design principles; that is not the same as an assessment.
- No penetration test against a deployed instance.
- No clinical validation. The app is a reminder and organisation tool by
  design — see [medical-safety.md](medical-safety.md).

## Next three things worth doing

1. **Wire one real provider end-to-end** — WhatsApp is the highest-value, and it
   is also the one with the longest lead time because template approval takes
   days. Everything else can follow.
2. **Ship a TestFlight build to one real elderly user** and watch them use it.
   Elderly mode is designed from principles; it has not met an 80-year-old.
3. **Load-test the reminder tick** at a realistic patient count. The queries are
   indexed for it, but "indexed" and "measured" are different words.
