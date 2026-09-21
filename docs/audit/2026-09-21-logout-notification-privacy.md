# Restored logout notification privacy — 2026-09-21

Base: candidate `75a826b`. The earlier local `53a3e48` object is unavailable;
this is a new, reviewed implementation, not a recovered test claim.

Logout now cancels pending notifications, dismisses delivered notifications,
and clears Expo's saved response within the existing serialized native mutation
lease. Each cleanup is attempted even if another fails; the first failure is
reported to the caller. A later account's schedule waits until cleanup finishes.
The existing Android exact-alarm lease and stale-request fences remain intact.

Three new native-boundary regressions failed before the source change, with the
29 existing scenarios passing. After the change the focused Vitest run, including
schedule/cache races, caller intent and notification actions, passed. Mobile
TypeScript, changed-file ESLint and `git diff --check` passed. Native I/O is
simulated; physical notification-center cleanup still requires a device check.

No hosted deployment, real notification, account deletion, or new binary was
performed. Full CI and security on the published head are required before
integration. Clearing saved responses reduces cross-account stale actions; this
does not claim that every remote push carries an account identifier or prove
operating-system behavior on a locked device.
