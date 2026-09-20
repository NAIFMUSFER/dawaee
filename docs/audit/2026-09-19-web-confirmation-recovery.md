# Web confirmation recovery — 2026-09-19

The owner authorized three separate synthetic patient/caregiver/nurse accounts.
No new accounts have yet been created: actual website access remains blocked,
and prepared fixtures or automated tests must not be described as UI acceptance.

## Observed blocker

The prior patient trial stopped at Revoke access. On this continuation a new
browser tab was created, but navigation still failed during tab refresh. Closing
the old preview tab returned a specific diagnostic: an active JavaScript confirm
dialog must be dismissed first. The documented dialog-dismiss operation was
superseded by browser recovery; a later refresh timed out again. Neither the
revocation nor dismissal is confirmed. This is a browser-control limitation,
not evidence that the application API is down.

The root web adapter in `_layout.tsx` replaced `Alert.alert` with the blocking
browser `confirm` function. It selected one destructive/non-cancel callback,
discarded the actual button labels and never called a cancellation callback.
The affected shipped controls are caregiver revocation, leaving a care circle,
and informational notification-action errors.

## Repair

- Web alerts now render inside the application using the existing themed
  controls and `PrivacyModal`, with every supplied action and its actual label.
  Destructive actions still require an explicit button press. Escape/cancel
  never invokes the destructive callback, and duplicate presses run it once.
- The host is keyed by authenticated account, patient profile and route. Old
  callbacks are discarded when any of those change, on unmount, when an alert
  is replaced, or when app lock covers the content. Unlock does not revive an
  old confirmation. The existing native iOS/Android Alert stays unchanged.
- Existing API authorization, invitation state and permission checks stay in
  place. This does not automatically revoke the pending synthetic invitation
  or change authentication to bypass the blocked browser.

## Verification and remaining work

Fifteen new component/action tests passed, including cancellation, explicit
destructive consent, duplicate/stale events, multiple actions, account/profile/
route changes, lock/unlock, restoration and both native platforms. The focused
suite passed **71 tests / five files** including existing app-lock, modal privacy,
private-route and notification-listener coverage. These use controlled React
hooks and host elements, not a browser or native renderer. Full build/CI and
deployed visual acceptance are recorded separately in PR #32.

The old browser confirmation can remain open even after new code is deployed;
this repair prevents newly opened application confirmations from depending on
that blocking API, but it does not reset the cloud browser. Three-role account
creation, verified registration/login, recipient invitation acceptance and
permission enforcement must still be exercised through the real interfaces.
Production private storage and physical iOS notification trials remain open.
