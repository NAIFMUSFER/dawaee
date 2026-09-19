# تداوي · TADAWEE

A medication reminder, adherence and family-care platform, built Saudi-first:
Arabic RTL by default, English alongside it, and an elderly mode that is a real
mode rather than a larger font.

The product promise is narrow and deliberate. TADAWEE helps a person **organise
and remember** their medication, and helps the people who care about them know
when something was missed. It is **not** a doctor, a pharmacist, a prescription
service or a diagnostic system, and the codebase enforces that boundary in
several places rather than stating it in a disclaimer — see
[docs/medical-safety.md](docs/medical-safety.md).

---

## What is here

| Path | What it is |
|---|---|
| `packages/core` | The domain engines as pure functions: schedule expansion, the dose state machine, stock forecasting, adherence, the escalation ladder, duplicate detection, authorization, travel mode. No I/O; verified through domain tests. |
| `packages/shared` | Types, zod contracts, the AR/EN message catalog, and the design tokens. One source of truth for API, worker, app and portal. |
| `apps/api` | Fastify + TypeScript HTTP API over PostgreSQL. |
| `apps/worker` | The reminder, escalation, stock-alert and digest jobs. |
| `apps/mobile` | Expo / React Native app (iOS, Android, Web). |
| `db/migrations` | Versioned SQL migrations: schema, row-level security, append-only audit, and the SECURITY DEFINER surfaces. |
| `db/seed/rls_probe.sql` | An adversarial isolation probe that CI runs as a release gate. |

## Quick start

```bash
# 1. Database, API and worker, with mock providers — no credentials needed.
cp .env.example .env
docker compose up --build

# 2. The app
cd apps/mobile && npm install --legacy-peer-deps
EXPO_PUBLIC_API_URL=http://localhost:8080 npx expo start
```

The Compose migration service bootstraps separate application and worker roles
and runs the repository migration ledger before either runtime starts. It is a
local development stack; production provider setup follows the release runbook.
For a physical phone, replace `localhost` with the development computer's LAN
address. Keep the API override explicit: the normal app configuration points to
the production service.

## Verification

```bash
npm test                    # requires the test PostgreSQL roles and database
npm run typecheck
npm run lint
cd apps/mobile && npm run typecheck
```

GitHub CI runs PostgreSQL 16/17 integration and isolation checks, mobile exports,
container checks and security gates. Evidence belongs to an exact commit; see
[the current audit](docs/audit/2026-09-19-full-audit.md) for what has run and what
still needs real interface or device verification.

## Integrations

| Integration | Implementations | Configuration |
|---|---|---|
| Push | Expo transport for native notifications | `PUSH_PROVIDER` |
| Account email | Disabled or Resend | `ACCOUNT_EMAIL_PROVIDER` |
| OCR | Mock, Google Vision or Azure Document Intelligence | `OCR_PROVIDER` |
| Private images | Local development storage, S3 or R2 | `STORAGE_PROVIDER` |

Production refuses mock push and local storage at startup. Readiness additionally
checks database, migration contracts, worker health/build agreement and provider
configuration. Its public response is minimal; it does not expose provider
configuration. See [integration setup](docs/integrations.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the pieces fit and why
- [docs/security.md](docs/security.md) — the threat model and the layers
- [docs/medical-safety.md](docs/medical-safety.md) — the boundary, and where it is enforced
- [docs/api.md](docs/api.md) — endpoint reference
- [docs/operations.md](docs/operations.md) — deploy, monitor, run
- [docs/findings.md](docs/findings.md) — defects the tests caught
- [docs/status.md](docs/status.md) — what is done, what is not, honestly

## Licence

Not yet licensed for distribution. All rights reserved.
