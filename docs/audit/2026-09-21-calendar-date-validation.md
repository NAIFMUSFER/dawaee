# N6 — reject nonexistent calendar dates at the API edge

Date: 2026-09-21

Base: `32f3e01f5cc5c28b7a8aad0f6f0f01f8d4c43313`
(`audit/ios10-evidence-20260920`)

## Finding reproduced

The shared `requireDate` guard checked only the `YYYY-MM-DD` shape. It accepted
values that are not Gregorian dates, including `2026-02-29`, `2026-04-31`,
month/day zero, month 13 and year `0000`. Those values can then reach a
PostgreSQL `date` cast instead of producing a stable validation response at the
API boundary.

The regression was written before the runtime change. Eleven of sixteen cases
failed: every nonexistent date returned HTTP 200 from the edge probe and the
optional/range helpers accepted the same invalid values.

## Written

- `apps/api/src/lib/params.ts` now validates the year, month and day after the
  existing strict shape check.
- Gregorian leap-year rules are applied directly, including the century and
  400-year rules. This avoids JavaScript date normalisation and its special
  handling of years 0–99.
- Year `0000` is rejected; the four-digit range `0001`–`9999` remains
  compatible with the existing contract.
- Because `optionalDate` and `requireDateRange` call `requireDate`, the same
  guard covers dose/history, notes and report date parameters without changing
  route permissions or SQL.
- `apps/api/test/calendar-date-validation.test.ts` checks stable HTTP 400
  errors without database/provider calls, valid leap days, optional values and
  both range endpoints.

## Tested

- Before fix: 11 failed / 5 passed in the new 16-case regression.
- After fix: 16 passed / 16 total.
- Calendar validation plus URL-redaction selection: 20 passed / 20 total.
- API TypeScript: pass.
- ESLint for both changed TypeScript files: pass.
- `git diff --check`: pass.

An attempted wider selection also loaded database-dependent log suites. Their
setup could not run because this workspace has no PostgreSQL listener on 5433
and no `psql` binary. That environment failure is not counted as an application
test result. PostgreSQL 16/17 and the full suite remain required in GitHub CI
for the published commit.

## Published / deployed / interface evidence

- GitHub: not published at the time this note was written.
- Preview/production: not deployed.
- No account, clinical record, provider message or database was created or
  changed by the focused test.
- This is an API input-boundary repair. It does not claim physical-device or
  rendered-interface acceptance, and it does not close the separate language
  and date-entry UX findings.
