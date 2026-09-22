# N14 — review quantities after changing dose units

Changing a dose unit in quick medication creation or schedule creation/editing
previously retained the old numeric quantity. Quick creation also retained the
stock amount while changing its unit. No conversion factors establish that these
amounts are equivalent.

The UI now clears the dose amount when the selected unit actually changes.
Quick creation clears stock too and requires an explicit stock edit if stock was
previously entered, preventing the blank field from silently disabling tracking.
Selecting the same unit preserves both amounts; changing back never restores an
old amount. Arabic and English hints explain the required review. This does not
calculate or recommend a medical dose.

Validation: four failing cases before the change (two quick-create cases and
schedule create/edit); seven focused Vitest files pass, 19 outer tests including
nested screen harness scenarios. Shared build, mobile TypeScript, and changed-file
ESLint pass. Tests exercise the real screen handlers with controlled I/O, not a
physical device. Prior APK/TestFlight artifacts do not include this change.

Full CI and native acceptance must be recorded separately before deployment.
