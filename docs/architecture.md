# Architecture

## The shape of it

```
                    ┌──────────────┐        ┌──────────────┐
  Expo app  ───────▶│   API        │◀──────▶│  PostgreSQL  │
  (iOS/Android/Web) │  (Fastify)   │        │  + RLS       │
        │           └──────────────┘        └──────────────┘
        │                                          ▲
        │  local notifications                     │
        │  from a cached window            ┌──────────────┐
        └─────────────────────────────────▶│   Worker     │
                                           │ reminders,   │
                                           │ escalation,  │
                                           │ stock, digest│
                                           └──────┬───────┘
                                                  │
                          push (Expo→APNs/FCM) ───┼─── WhatsApp Cloud API
                                          SMS ────┘
```

Both server processes are built from **one image**. The worker enforces the
escalation rules the API's tests cover; a version skew between them would mean
reminders behaving differently from what the app shows.

## Decisions worth explaining

### Domain logic is pure, and lives in one package

`packages/core` has no database, no HTTP, no clock of its own — `now` is always
a parameter. That is what makes the escalation ladder, the DST edge cases and
the stock arithmetic testable at the level of "what should happen", and it is
why the same code can run in the API, in the worker, and on the device.

### One instant per dose

A dose carries `scheduled_at` (UTC) as its single authority, plus the wall clock
it was authored in (`scheduled_local_time` + `scheduled_timezone`) for display
and for travel mode. Storing only a local time would break the moment someone
flies; storing only an instant would lose the patient's intent ("08:00, my
time"). Both are needed, and which is authoritative is never ambiguous.

### Dose status is partly derived, partly recorded

- *Derived* — `upcoming`, `due`, `snoozed`, `missed` — is a pure function of the
  clock, recomputed on read. A phone that was off for two days still shows the
  truth.
- *Recorded* — `taken`, `taken_late`, `skipped`, `cancelled` — is written once by
  an explicit action and never moves on its own.

`missed` is deliberately in the first group. An early version treated it as
final, which meant a patient who took their medication but forgot to tap could
never correct their own history. That is how you teach people their adherence
record is meaningless.

### Occurrences are materialized, not computed

A dose needs identity: it accumulates a notification history, an escalation
stage, a confirmation, a stock movement and an audit trail. A computed view
could carry none of that. The horizon is a rolling 14 days, so a schedule edit
rewrites a small tail rather than months of rows. `(schedule_id, scheduled_at)`
is unique, which makes the materializer idempotent — running it every minute,
or twice concurrently, produces exactly the same rows.

### Escalation decides; the dispatcher sends

The reminder job evaluates the policy and **enqueues**; a separate job sends.
A WhatsApp outage therefore cannot stall the escalation clock, and a retry
cannot re-run the escalation decision. Delivery rows carry a dedupe key with a
unique index, so a worker restart mid-dispatch can never double-message a
family member.

On catch-up: if the worker was down for an hour, escalation jumps to the
**highest due stage** rather than replaying every one. A patient who is an hour
late gets one caregiver alert, not four notifications at once.

### Offline is a first-class path, not a fallback

The server returns a 7-day prefetch window with every Today request. The device
caches it, renders from it, and schedules its own local notifications from it.
Pressing "Taken" always succeeds locally and is queued with a client event id
that the server treats as an idempotency key — so a retry after a crash, a
reinstall, or a duplicated batch cannot record the same dose twice or decrement
the medication box twice.

### Defence in depth on access

Two independent layers enforce the same boundary:

1. **Application** — `packages/core/authorization.ts`, pure and exhaustively
   tested.
2. **Database** — row-level security written against a per-transaction
   `app.user_id`.

Neither is trusted alone. A bug in the first degrades to "the database refuses
and the user sees a 404", not a data leak. This is not theoretical: RLS caught
a missing DELETE policy that was silently making schedule edits a no-op.

### The auth plane is separate on purpose

Account creation, OTP verification and session rotation all happen *before* an
identity exists, so they cannot satisfy the RLS policies. Rather than loosening
those policies — which would weaken every authenticated request — the auth
plane gets its own narrow `SECURITY DEFINER` surface (migrations 0010, 0011).
The request-serving role cannot read an OTP hash at all.

## Data model

25 tables. The medical boundary is `patient_profiles`: one account may own
several (self, father, mother) and **data never crosses between them**. A
database trigger asserts that every child row's profile matches its parent
medication's, so a profile mismatch is impossible rather than merely unlikely.

`audit_logs` is append-only by construction: `UPDATE`, `DELETE` and `TRUNCATE`
are revoked from both application roles, and a trigger raises regardless of
grants.
