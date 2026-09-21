# N26 — stable preview role credentials

Base: `75a826b`. The preview bootstrap generated role passwords whenever its
environment omitted them, then passed them to the migration runner on every
start. This could rotate existing credentials without an explicit decision.

Apply mode now refuses missing app/worker passwords before importing clients or
connecting. For an initialized database, it authenticates both supplied runtime
credentials and verifies their limited roles before invoking any migration.
A mismatch stops with a fixed diagnostic; it is never repaired by overwriting
the role password. The same role checks run after migration. Read-only
preflight remains available without runtime credentials. No new secret is
generated, logged, committed or installed by this change.

Four new bootstrap tests failed before the change and the read-only control
passed. After repair, 58 tests passed across credential stability, bootstrap,
runtime supervision and email opt-in. ESLint and diff checks passed. Database
connections are mocked in the new guard tests; no hosted database or secret was
touched. Exact-head CI/security remain prerequisites to integration.

This fixes the dangerous automatic behavior, but it does not prove that the
hosted preview already has both matching credentials configured. An operator
must verify the existing configuration through an authorized path before
deploying; this change does not authorize rotating or reconstructing secrets.
