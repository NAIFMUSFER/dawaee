# Dawaee mobile — screen authoring brief

Read this before adding a screen. Everything here already exists and works.

## Stack
Expo SDK 52 + expo-router (file-based routing) + React Native 0.76 + TypeScript strict.
No state library: `useApp()` for global state, `useState` locally.

## Import aliases (configured in tsconfig + metro)
- `@/...`      → `apps/mobile/src/...`
- `@dawaee/shared` → enums, types, zod contracts, i18n catalogs, design tokens
- `@dawaee/core`   → pure domain engines (schedule expansion, adherence, stock, escalation)

## The building blocks — USE THESE, do not hand-roll
```ts
import {
  Screen, Txt, Card, Button, Field, Badge, Row, Divider,
  SectionTitle, Banner, EmptyState, Loading, SafetyNote,
} from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { SnoozeSheet } from '@/components/SnoozeSheet';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/i18n';
import { useApp, useActiveProfile } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { MedicationView, DoseView, CaregiverView, AdherenceResponse } from '@/api/types';
```

- `Txt` variants: `display h1 h2 h3 bodyLarge body bodySmall caption`
- `Button` tones: `primary secondary success danger ghost`; `size="large"` for primary actions
- `useTheme()` → `{ colors, spacing, radius, font, touch, elderlyMode, isRtl, lineHeight, shadow }`
- `useI18n()` → `{ t, locale, isRtl, formatNumber, formatTime, formatDate, formatWeekday, formatRelativeMinutes }`

## Non-negotiable rules
1. **Never hard-code user-facing text.** Use `t('some.key')`. Every key already exists in
   `packages/shared/src/i18n.ts` for BOTH `ar` and `en` — a CI test fails on key drift.
   If you truly need a new string, add it to BOTH locales in that file.
2. **Never write `left`/`right` layout.** Use `Row`, `gap`, and logical properties
   (`marginStart`, `paddingEnd`, `borderStartWidth`). RN mirrors `flexDirection: 'row'`
   under RTL automatically. Arabic must be genuinely RTL, not reversed.
3. **Accessibility**: every pressable needs `accessibilityRole` + `accessibilityLabel`.
   The `Button`/`Card` components already do this — pass the label.
   Never rely on colour alone to convey status; pair it with text (`Badge`).
4. **Elderly mode** is a scale, not a second UI. Read `theme.elderlyMode` to *simplify*
   (fewer secondary actions, larger imagery), never to branch into a different component.
5. **Medical safety**: never render advice. No "take two", no "double the dose", no
   interpretation of a symptom or a number. Where a figure could read as clinical,
   render `<SafetyNote textKey="adherence.disclaimer" />` (or `reports.disclaimer`,
   `missed.guidance`, `emergency.userProvided`, `safety.notMedicalAdvice`).
6. **OCR output is a suggestion.** Always label it with `t('medication.detectedByAi')`,
   show `t('medication.aiDisclaimer')`, and require the user to confirm before saving.
7. **Offline**: reads may fail. Catch `NetworkError` and show
   `<Banner tone="warning" title={t('notifications.offlineBanner')} />` rather than an error.
8. Numbers and dates go through `formatNumber` / `formatTime` / `formatDate`, never
   `toString()` — the user may have chosen Arabic-Indic numerals.
9. Dates/times must be formatted **in the patient's timezone**: pass
   `profile.timezone` as the second argument.

## API (all authenticated; base client handles tokens + refresh)
```
GET    /v1/profiles
GET    /v1/me                                   → { user, preferences, consents }
PATCH  /v1/me/preferences
PUT    /v1/me/consents                          { type, granted, version }
POST   /v1/profiles                             { displayName, birthYear?, timezone, isSelf }
GET    /v1/medications?profileId=&status=       → { medications: MedicationView[] }
GET    /v1/medications/:id                      → { medication, schedules, stock }
POST   /v1/medications                          { patientProfileId, name, form, ..., schedule?, stock?, acknowledgeDuplicate? }
                                                 409 duplicate_medication → meta.duplicates[]
                                                 409 high_risk_confirmation_required → meta.changes[]
PATCH  /v1/medications/:id                      { ..., confirmHighRiskChange? }
DELETE /v1/medications/:id                      → { deleted, archived, historyCount }
POST   /v1/medications/check-duplicate          { patientProfileId, name, strengthValue?, strengthUnit?, barcode? }
POST   /v1/medications/:id/schedules            { rule, doseQuantity, doseUnit, startDate, ... }
PATCH  /v1/schedules/:id                        { ..., confirmHighRiskChange? }
DELETE /v1/schedules/:id
GET    /v1/medications/:id/stock                → { stock, forecast, transactions, refills }
PUT    /v1/medications/:id/stock                { remainingQuantity? | delta?, reason }
POST   /v1/medications/:id/refill               { quantityAdded, unit, pharmacy?, cost?, note? }
GET    /v1/stock/low?profileId=                 → { lowStock[], expiringSoon[] }
GET    /v1/today?profileId=                     → TodayResponse
GET    /v1/doses?profileId=&from=&to=&medicationId=&status=
GET    /v1/doses/:id                            → { dose, events }
POST   /v1/doses/:id/taken                      { clientEventId, method, takenAt?, note? }
POST   /v1/doses/:id/snooze                     { minutes, clientEventId }
POST   /v1/doses/:id/skip                       { reason?, clientEventId }
POST   /v1/doses/:id/undo
GET    /v1/adherence?profileId=&from=&to=       → AdherenceResponse
GET    /v1/care-circle?profileId=               → { caregivers: CaregiverView[], viewerRole, presets }
POST   /v1/caregivers/invite                    { patientProfileId, invitedName, invitedPhone, role, permissions[], escalationPriority, channel }
POST   /v1/caregivers/accept                    { token }
PATCH  /v1/caregivers/:id/permissions           { permissions[], escalationPriority?, role? }
PUT    /v1/caregivers/:id/notification-rules    { channel, mode, consecutiveMissedThreshold, summaryTime?, enabled }
DELETE /v1/caregivers/:id
GET    /v1/escalation-policy?profileId=         → { policy, isDefault, defaultStages }
PUT    /v1/escalation-policy?profileId=         { enabled, stages[], quietHoursStart?, quietHoursEnd? }
GET    /v1/reports/weekly?profileId=
GET    /v1/reports/clinician?profileId=&from=&to=
GET    /v1/reports/export?profileId=
GET    /v1/emergency/card?profileId=
PUT    /v1/emergency/card?profileId=            { bloodType?, allergies[], conditionsNote?, emergencyContacts[], include* }
POST   /v1/emergency/qr/enable?profileId=       → { qrUrl, token }
POST   /v1/emergency/qr/disable?profileId=
GET    /v1/notes?profileId=&from=&to=
POST   /v1/notes                                { profileId, doseOccurrenceId?, tags[], text? }
GET    /v1/measurements?profileId=&type=
POST   /v1/measurements?profileId=              { type, valuePrimary, valueSecondary?, unit, measuredAt? }
POST   /v1/uploads/request                      { purpose, contentType, byteSize, patientProfileId? } → { objectKey, upload }
POST   /v1/ocr/analyze                          { imageKey, patientProfileId, kind }  (428 consent_required)
POST   /v1/profiles/:id/timezone-check          { deviceTimezone }
POST   /v1/profiles/:id/timezone-decision       { detectedTimezone, decision }
```

## Error handling pattern
```tsx
try { ... } catch (err) {
  if (err instanceof NetworkError) setOffline(true);
  else if (err instanceof ApiError) setError(err.message);   // already localized-ish; prefer t(`error.${err.code}`)
  else setError(t('error.internal_error'));
}
```
`ApiError` carries `.code`, `.status`, `.meta` (e.g. `meta.duplicates`, `meta.changes`).

## Existing routes (do not recreate)
```
app/_layout.tsx                app/index.tsx
app/(auth)/_layout.tsx  language.tsx  phone.tsx  otp.tsx
app/(tabs)/_layout.tsx  today.tsx
src/components/ui.tsx  DoseCard.tsx  SnoozeSheet.tsx
```
The tab bar expects these files to exist:
`app/(tabs)/today.tsx  medications.tsx  history.tsx  family.tsx  settings.tsx`

## Style of the code itself
Write it like production code someone will maintain: real error and empty states,
loading states, no `any`, no TODOs, no placeholder copy. Comments only where a
reader would otherwise wonder *why* — not narrating *what*.
