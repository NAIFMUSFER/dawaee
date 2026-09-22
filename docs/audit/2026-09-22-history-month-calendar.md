# N17 — Gregorian history grid headings

The history month query and day numbers cover a Gregorian month. With the
Umm al-Qura preference enabled, its heading formerly described only the Hijri
month containing the first Gregorian day, which mislabelled the displayed range.
The month heading now explicitly uses the Gregorian calendar. Detail and day
view dates keep the preferred calendar, and numeral preferences remain intact.

Two real-screen harness cases failed before the fix, for Western and Arabic
numerals. They now pass, comparing the rendered heading with the actual request
start date. History pagination and date-picker semantics also pass: 8 tests in
3 files. Mobile TypeScript and changed-file ESLint pass. This is not a full Hijri
month grid implementation or physical-device acceptance.
