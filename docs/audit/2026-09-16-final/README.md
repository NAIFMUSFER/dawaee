# تداوي | TADAWEE — final audit and repair candidate

Status: **NOT VERIFIED for production release.** This PR is for review; no production deployment, migration, merge, real-patient action or outbound reminder was authorized or performed.

This work starts at PR #29 `ac44deb05b083520e7bd66d171849a611c2e424e`, preserving its phone-verification changes and the subsequent migration fixes. PR #28 was reviewed separately: its legacy API hotfix must not replace the newer application wholesale.

## Observed baseline — 16 September 2026 UTC

| Component | Evidence | Status / implication |
| --- | --- | --- |
| main | `07bf101c8a4720dc74d55de37b0dcb825c7841e5` | PASS: source identity only |
| Serving API | `/version` and Render live deployment: `60b474ea81105529c16f88d5b878c5c274c7b03b`; ready response reports schema 0033 | PASS: live source identified; not proof of successful authenticated dose transaction |
| Serving worker | Render live deployment: `0338ddefc475d23cccecf13d5ede0f32d2007fb0`; latest main deployment failed pre-deploy | FAIL: worker remains behind API and database |
| Worker logs | 11:52 and 12:52 UTC: `42501`, permission denied for `stored_objects` | FAIL: housekeeping is not operating with the current privilege contract; do not broaden runtime grants |
| Actual Supabase catalog | PostgreSQL 17.6; 77 migration rows through 0077; `stock_tx_dose_event_idx` unique partial index on `dose_event_id`; old `stock_tx_dose_idx` absent | PASS: read-only catalog inspection; advertised schema 0033 is not the catalog. Runtime connection correlation remains to be proved with deployment configuration/isolated rollout |
| Android build in PR #29 | EAS build `52047e47-114f-4257-a942-edee319379fc`, source `ac44deb`, version code 4 | NOT VERIFIED: this does not identify the currently installed phone binary |
| Physical Android / provider arrival | No connected device or provider delivery experiment in this session | BLOCKED: hardware Back, navigation gestures, lock/reboot, real push arrival and camera require isolated device acceptance |

## Screenshot findings and repairs

Original evidence: `IMG_0413.jpeg` (application screenshot), `IMG_0414.jpeg` and `IMG_0415(1).png` (conversation composites). Composites contain third-party identity and are intentionally not published to this public repository. Their comments are transcribed as issues below. A screenshot does not prove an interaction works.

| ID | Priority / evidence | Root cause / candidate repair | Acceptance / verification |
| --- | --- | --- | --- |
| UI-01 | P1: time picker clipped; user reports no scroll, Back or tappable footer | `TimeField.tsx`: over-height centered card with touch-intercepting wrappers. Full-screen safe-area modal, bounded hour/minute scrollers, footer outside scroll, explicit cancel and Android `onRequestClose` | All 24 hours/60 minutes reachable; confirm/cancel reachable, repeated open/close and Back preserve committed time. Component regression PASS; native interaction NOT VERIFIED |
| UI-02 | P1: per-dose shortcuts 0.5/1/1.5/2/3 and custom 6 | `quick-create.tsx`: separate quantity from daily times; strict shared Arabic/English/fraction parser, retain custom value, label shortcuts as input shortcuts only | 6 saved with 4+ appointments independently. Screen/contract tests PASS; real DB suite pending CI |
| UI-03 | P1: horizontally clipped units | `DoseUnitPicker.tsx` / `Picker.tsx`: wrap shape-appropriate units; disclose extra units; always show selected unit; explicit review when form changes | No silent unit change or mg/ml/tablet conversion. Screen regression PASS; narrow viewport and enlarged font pending interaction |
| UI-04 | P1: weekday/footer visibility and scroll concern | Wrapped weekday/unit controls, keyboard dismissal for time modal and retained full form scroller | Seven weekdays, selected unit and final save reachable with keyboard/font/navigation variations; physical matrix NOT VERIFIED |
| DATA-01 | P0: reported `/v1/dose/action` 404 and PostgreSQL 42P10 | Live PR #28 contains the route and removes the obsolete conflict target; candidate retains latest route and per-event ledger constraints. Never swallow SQL errors | Live successful tracked confirmation NOT VERIFIED; real PostgreSQL regression required |
| DATA-02 | P0: concurrent replay / undo → retake | `dose-service.ts`: lock occurrence before replay lookup; undo has durable request identity; stock reversal refers to current take event, including tracking-disabled case | Concurrent take/snooze/skip, stale undo, take → undo → take consume stock once per event; real PostgreSQL suite pending CI |
| DATA-03 | P0: ambiguous create response / duplicate retry | Additive migration 0083 plus profile lock and request hash; mobile reuses create key for unchanged input; no speculative successful confirmation on server error | Identical concurrent/retried create returns original; changed body with same key rejects. Real PostgreSQL suite pending CI |
| OCR-01 | P1: extracted confidence presented as provider certainty | Provider marks rule-extracted fields `heuristic`; mobile only renders provider percentages with explicit provider provenance | All extracted values remain editable; box text cannot supply a prescription schedule. Regression pending final suite |
| UX-01 | P2: English identity differs | User-facing launch/language labels use exactly TADAWEE and تداوي; persistent package IDs remain stable | Bundle/typecheck; final visual inspection pending |

## Verification boundaries

The screen harness executes the screen's state/handlers with mocked native rendering and transport. It proves parsing, payloads, retries and cancellation logic; it does **not** prove native touch dispatch, viewport reachability, Android Back gestures, real camera/OCR or push arrival.

Local PostgreSQL startup was blocked by host process/user-management permissions. SQL integration results must come from the isolated CI PostgreSQL 16/17 services (ordinary migration owner, no RLS bypass), never a mock or a production mutation. Final CI links, detailed journey matrix, screenshots and rollout/rollback steps will be attached before review is complete.
