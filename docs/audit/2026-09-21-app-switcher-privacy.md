# App-switcher preview privacy — 2026-09-21

## Scope and source

- Recovered an independent clean worktree from GitHub after the transient local
  Git metadata disappeared during workspace cleanup.
- Based this change on documented production/backend source `9bf0a3b`.
- Rechecked PR #32 before editing: it remains open and draft at `e59f864`.
- Left the separate worktree containing the legal-consent/rate-limit work
  untouched.

## Defect

`AppLockGate` drew the opaque iOS App Switcher / Android Recents cover only
while the optional biometric app lock was enabled. With the default
`appLockEnabled=false`, an authenticated patient's medication, notes, history,
or caregiver screen could remain in the operating-system preview.

## Written

- Added a pure `privacyPreviewCovered` rule: every `inactive` or `background`
  state is covered; only `active` is visible.
- Wired that rule directly to the root AppState listener independently of the
  biometric-lock preference.
- Made the independent preview cover override unlocked, whole-app-lock, and
  per-area presentation states, while keeping the underlying route mounted.
- Reused the same accessibility and private-modal boundary so hidden content is
  also removed from assistive-technology and native-modal presentation while
  covered.

## Tested

- 51/51 focused cases passed across app-lock behavior, background verification
  races, accessibility shielding, and privacy-aware native modals.
- Mobile TypeScript passed.
- ESLint passed for every changed source and test file.
- `git diff --check` passed.

These checks prove the state rule and application wiring in a controlled
environment. They do **not** prove the exact timing of an iOS/Android operating
system snapshot.

## Published and device status

- Not published to GitHub, preview, Render, Expo, TestFlight, or a store.
- No native build was started or repeated.
- A physical iPhone/Android Recents check remains required with app lock both
  off and on. The expected preview is an opaque background with no medication
  data or unlock controls.
