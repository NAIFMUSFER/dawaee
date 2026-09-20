# Native language-direction reversal — 20 September 2026

## Scope and finding

Source baseline: PR #32 at `d4b0df92e7ea45a577a3daf0dcf3d0ed65d2c230`.
This is a targeted correction to A10, **not closure of native restart or UI
acceptance**. No production, preview or TestFlight deployment is part of it.

The reviewed call chain is language/settings selection ->
`AppProvider.updatePreferences` -> `applyNativeDirection`; authenticated
bootstrap and offline snapshot restoration also call the same helper.

React Native 0.83.10 captures `I18nManager.isRTL` for the running bridge. Its
native `allowRTL` and `forceRTL` setters persist different next-start flags.
The installed iOS implementation writes NSUserDefaults; Android writes its
preferences. The [versioned React Native documentation](https://reactnative.dev/docs/0.83/i18nmanager)
also distinguishes the current layout from next-start persistent changes.

The old helper returned early when the chosen language matched the current
bridge, without undoing an earlier persisted choice:

1. Start with English/LTR; choose Arabic. The current bridge remains LTR, but
   the native next-start flags become RTL.
2. Choose English before restarting. The old helper says no restart is needed,
   but leaves the native flags set to RTL.
3. A later restart uses the abandoned direction. The Arabic -> English ->
   Arabic sequence has the symmetric failure.

## Change

`apps/mobile/src/i18n/index.tsx` now writes both native flags for every requested
direction, including a return to the current layout. The restart-required result
still compares the requested direction with the actual running bridge. The web
returns early as before, without touching native flags or requesting a reload.

No credential, preference PATCH ordering, account-bound cache, offline dose
queue, privacy intent, notification scheduling, API contract or dependency was
changed. The existing manual restart notice remains; no automatic restart was
introduced.

## Evidence

- The new `native-direction-persistence.test.ts` executes the complete actual
  localization module with a synthetic native boundary that keeps `isRTL`
  constant and records next-start writes. It is not a physical device test.
- Before the fix: **8 failing / 6 passing cases**. Both reversal directions on
  iOS and Android reproduced the stale flags, including repeated toggles.
- After the fix: **14/14 cases passed**, including web no-op behavior and
  simulated next-start results under either device language.
- The targeted suite passed **51/51 tests in 8 files**: native/web direction,
  preference-write races, stale bootstrap results, offline privacy replay and
  offline account ownership. The normal test command rebuilt the web export
  successfully; no test/build guard was bypassed.
- Mobile TypeScript, changed-file ESLint and `git diff --check` passed. A test
  harness URL type mismatch was corrected by importing Node's URL explicitly;
  no application typechecking constraint was weakened.
- The complete `npx vitest run packages apps/mobile/test` run passed
  **1,362/1,362 tests across 175 files**, including the new 14 cases. This is
  local automated coverage, not PostgreSQL integration or physical rendering.

## Still open

Safe in-app restart needs more than calling a reload API. The current preference
flow is optimistic; anonymous language selection is process-local; encrypted
bootstrap persistence is best-effort; pending dose/cache operations have their
own serialization. A future restart action must prove durable selection and
settled writes, preserve account fencing, and handle save/reload failures before
it can be enabled. No data-loss or restart-safety claim is inferred here.

Installing `expo-updates` is not inherently required for this task: the already
installed Expo SDK 55 exposes [reloadAppAsync](https://docs.expo.dev/versions/v55.0.0/sdk/expo/#reloadappasyncreason)
for reloading the same bundle. That capability alone does not satisfy the
storage/lifecycle conditions above, and this patch does not invoke it.

The fresh cloud tab was successfully created this run, but navigation and a
subsequent lightweight visible-DOM check both failed with
`CDP operation refresh tabs timed out after 20000ms`. No visible registration,
authenticated role walkthrough or device interaction occurred. The successful
27 live HTTP checks and real mailbox receipt from the earlier preview checkpoint
remain separate evidence, not visual acceptance.

Next gates: exact-head CI/security, Arabic/English reversal on a signed iPhone
build (including choosing back before restart), native restart persistence,
three-role rendered UI and physical notification acceptance. Production remains
`63b5b8d`; preview remains `ff1bd1b`; no account deletion/reset was repeated.
