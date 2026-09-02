# دوائي · Dawaee

A medication reminder, adherence and family-care platform, built Saudi-first:
Arabic RTL by default, English alongside it, and an elderly mode that is a real
mode rather than a larger font.

The product promise is narrow and deliberate. Dawaee helps a person **organise
and remember** their medication, and helps the people who care about them know
when something was missed. It is **not** a doctor, a pharmacist, a prescription
service or a diagnostic system, and the codebase enforces that boundary in
several places rather than stating it in a disclaimer — see
[docs/medical-safety.md](docs/medical-safety.md).

---

## What is here

| Path | What it is |
|---|---|
| `packages/core` | The domain engines as pure functions: schedule expansion, the dose state machine, stock forecasting, adherence, the escalation ladder, duplicate detection, authorization, travel mode. No I/O, exhaustively tested. |
| `packages/shared` | Types, zod contracts, the AR/EN message catalog, and the design tokens. One source of truth for API, worker, app and portal. |
| `apps/api` | Fastify + TypeScript HTTP API over PostgreSQL. |
| `apps/worker` | The reminder, escalation, stock-alert and digest jobs. |
| `apps/mobile` | Expo / React Native app (iOS, Android, Web). |
| `db/migrations` | 13 SQL migrations: schema, row-level security, append-only audit, and the SECURITY DEFINER surfaces. |
| `db/seed/rls_probe.sql` | An adversarial isolation probe that CI runs as a release gate. |

## Quick start

```bash
# 1. Database, API and worker, with mock providers — no credentials needed.
cp .env.example .env
docker compose up --build

# 2. The app
cd apps/mobile && npm install --legacy-peer-deps && npx expo start
```

Without Docker:

```bash
npm install
npx tsc -b packages/shared packages/core apps/api apps/worker
./scripts/dev-pg.sh                      # local Postgres on :5433
./scripts/db-reset.sh dawaee_dev         # apply migrations
DAWAEE_APP_PASSWORD=devpass DAWAEE_WORKER_PASSWORD=devpass \
  ./scripts/db-bootstrap-roles.sh dawaee_dev
npm run dev:api                          # :8080
npm run dev:worker
```

## Tests

```bash
npm test                                 # 251 tests: unit + integration
psql -d dawaee_test -f db/seed/rls_probe.sql   # 30 isolation assertions
```

The suite is not decorative. Writing it surfaced six real defects, including
two authentication vulnerabilities and a silent data-loss bug; they are
documented in [docs/findings.md](docs/findings.md) with what each would have
cost in production.

## Integrations

Every outbound integration is an interface with a real implementation **and** a
recording mock. The mock is what runs until credentials are configured, and
`GET /health/ready` lists exactly which integrations are still mocked — a
deployment never quietly pretends to be sending messages.

| Integration | Real implementation | Configure with |
|---|---|---|
| SMS (OTP, invitations) | Twilio, Unifonic | `SMS_PROVIDER` |
| WhatsApp | Meta WhatsApp Cloud API (official only) | `WHATSAPP_PROVIDER` |
| Push | Expo → APNs + FCM | `PUSH_PROVIDER` |
| OCR | Google Cloud Vision, Azure Document Intelligence | `OCR_PROVIDER` |
| Object storage | S3, Cloudflare R2 | `STORAGE_PROVIDER` |

See [docs/integrations.md](docs/integrations.md) for what each one needs.

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
