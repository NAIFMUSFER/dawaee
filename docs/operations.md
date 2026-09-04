# Operations

## Deploying to Render

```bash
# The blueprint provisions the database, the API and the worker together.
# From the Render dashboard: New → Blueprint → point at this repository.
```

`render.yaml` declares everything. On first apply Render prompts for each
`sync: false` secret. `JWT_SECRET` and `IP_HASH_SALT` are generated for you and
shared with the worker via `fromService`, so both processes sign and verify the
same tokens.

Migrations run in the WORKER's `preDeployCommand`, before the new version takes traffic — Render only permits pre-deploy commands on paid instances, and the API runs on the free plan. Every
migration is written to converge, so a re-run is safe.

### Required before the first deploy

| Variable | Why |
|---|---|
| `PUBLIC_APP_URL` | Goes into caregiver invitation links and emergency QR codes |
| `CORS_ORIGINS` | The caregiver portal origin, if any |
| `STORAGE_*` | Production refuses to boot on `STORAGE_PROVIDER=local` |

Everything else can stay on its mock and be switched on later without a code
change.

## Health checks

- `GET /health` — liveness. Used by the platform.
- `GET /health/ready` — readiness plus a database round-trip **and**
  `mockedIntegrations`, an explicit list of what is not live. Check this after
  every deploy: a production instance with `["whatsapp","push"]` in that array
  is not sending anything.

## What to watch

| Signal | Where | Why it matters |
|---|---|---|
| `job_runs` where `succeeded = false` | `GET /v1/admin/jobs` | A failed reminder tick means doses were not dispatched |
| Failed deliveries by channel | `GET /v1/admin/deliveries/failed` | A spike in `no_active_device` means push tokens are going stale |
| Unprocessed webhooks | `GET /v1/admin/webhooks/unprocessed` | Delivery receipts are not being folded in |
| Reminder tick duration | `job_runs.finished_at - started_at` | Should stay well under the tick interval |

The admin surface deliberately carries **no** medical data — no medication
names, no patient names. An operator can diagnose a delivery failure without
becoming a holder of medical records.

## Runbook

### Reminders are not going out

1. `GET /health/ready` — is the database reachable? Is the channel mocked?
2. `GET /v1/admin/jobs` — did `reminders` and `dispatch` run, and did they
   succeed?
3. `GET /v1/admin/deliveries/failed?channel=push` — what is the error code?
   - `no_active_device` → the user has no registered token; the app shows them
     the "alerts are disabled" banner.
   - `DeviceNotRegistered` → the token is dead; the dispatcher deactivates it
     automatically.
   - `network_error` → provider outage; rows stay queued and retry with backoff.
4. Local notifications on the device are independent of all of this. A patient
   with a cached window is still being reminded.

### The worker is behind

Escalation catches up by design: it jumps to the highest due stage rather than
replaying every one, so a patient who is an hour late gets one caregiver alert,
not four. Scale the worker to more than one instance freely — every job takes a
Postgres advisory lock, so extra instances give redundancy, not duplicates.

### A patient reports a wrong reminder time

Almost always travel mode. Check `travel_prompts` for that profile: the app asks
before changing anything, and a dismissed prompt leaves times on home time
deliberately. `medication_schedules.timezone` is the authority.

### Rolling back

The API and worker share one image, so roll both back together. Migrations are
forward-only; none of the 13 drops a column, so an older image runs against a
newer schema safely.

## Backups

Render's managed Postgres provides daily snapshots and point-in-time recovery on
paid plans. `GET /v1/reports/export?profileId=` produces a complete
per-patient JSON export, which is also the PDPL data-access mechanism.

## Cost shape

| Component | Render plan | Notes |
|---|---|---|
| PostgreSQL | Supabase free (Frankfurt) | Reached through the session-mode pooler on port 5432 — Render is IPv4-only and Supabase's direct endpoint is IPv6 on the free tier. Scale on connection count. |
| API | `starter` | One instance handles the reminder read load comfortably |
| Worker | `starter` | One is enough; more gives redundancy |

The WhatsApp Cloud API charges per conversation, which is a real reason the
escalation ladder contacts the *primary* caregiver first rather than everyone.
