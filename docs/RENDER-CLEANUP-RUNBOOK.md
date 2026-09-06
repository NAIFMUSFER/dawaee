# Render cleanup runbook

Read-only audit performed 2026-09-06 against workspace `tea-d9qth1iju40c73btab90`.
**Nothing in this document has been executed.** Every deletion requires explicit
operator authorization and the observation window below.

## What is in the workspace

Seven services and one database. Six services belong to Dawaee; `acs-engine`
belongs to a different project (`NAIFMUSFER/AI-Instruction`, Oregon) and is out
of scope for this audit — listed only so the inventory is complete.

| Resource | Type | Plan | Region | Status | Deploy state |
|---|---|---|---|---|---|
| `dawaee-api` | web | free | frankfurt | live | `db7061f1` — **the audit baseline** |
| `dawaee-worker` | worker | starter | frankfurt | live, ticking | `db7061f1` — **the audit baseline** |
| `dawaee-api-phop` | web | free | frankfurt | **never boots** | every deploy `update_failed` |
| `dawaee-api-htra` | web | free | frankfurt | **never boots** | every deploy `update_failed` |
| `dawaee-worker-phop` | worker | starter | frankfurt | **never boots** | pre-deploy exits 1 |
| `dawaee-worker-htra` | worker | starter | frankfurt | **never boots** | pre-deploy exits 1 |
| `dawaee-db` | Postgres 16 | free | frankfurt | available, **expires 2026-10-03** | ~0 connections |

## The four legacy services

All four were created 2026-09-04T22:55 within seconds of each other — the
signature of a Blueprint sync that produced duplicate services rather than
adopting the existing ones. All four point at the same repository and the same
branch as the primary services, with `autoDeploy: yes` and
`autoDeployTrigger: commit`.

**They have no environment variables configured at all.** That is the whole
story, and it is what makes them harmless:

```
dawaee-api-phop     fatal startup error: Invalid environment configuration:
                      DATABASE_URL: Required
                      JWT_SECRET: Required
                    ==> Exited with status 1

dawaee-worker-phop  ==> Starting pre-deploy: ./scripts/migrate.sh
                    ./scripts/migrate.sh: line 10: DATABASE_URL: DATABASE_URL is required
                    ==> Exited with status 1
```

`dawaee-api-htra` and `dawaee-worker-htra` fail identically.

### What this means for the security question

P17 asked whether a legacy public API could be serving a pre-remediation commit
and bypassing the fixes. **It cannot.** The two legacy web services never bind a
port: the config schema refuses to construct without `DATABASE_URL` and
`JWT_SECRET`, the process exits 1, and Render serves its own error page. There
is no application behind those URLs to attack — no authentication, no database
connection, no route table.

This is the P15 fail-closed configuration behaving exactly as designed. A
service with no secrets does not start with defaults; it refuses.

The two legacy workers are more interesting, because both carry
`preDeployCommand: ./scripts/migrate.sh`. Had they been configured, three
separate services would race to migrate the same database on every push. They
are not configured, so `migrate.sh` exits at its own guard before opening a
connection.

### What they still cost

| Cost | Detail |
|---|---|
| Build minutes | Every push to `main` triggers **six** builds, four of which are guaranteed to fail |
| Billing | Both legacy workers are on the **starter** plan, which is not free |
| Signal | Four permanently-red services make a genuinely broken deploy hard to notice |
| Future risk | If anyone ever adds environment variables to these, they become live duplicates immediately — including two more services that migrate the database |

### Per-resource assessment

| | `dawaee-api-phop` / `dawaee-api-htra` | `dawaee-worker-phop` / `dawaee-worker-htra` |
|---|---|---|
| Why it exists | Blueprint sync duplicate, 2026-09-04 | Blueprint sync duplicate, 2026-09-04 |
| Current status | Deploy fails; process never starts | Pre-deploy fails; process never starts |
| Traffic | None. No instance metrics of any kind | None |
| Dependencies | None — cannot connect to anything | None |
| Database target | **None.** No `DATABASE_URL` | **None** |
| Custom domain | None | N/A |
| Webhooks | None observed | None observed |
| Auto-deploy | **yes, on commit, branch `main`** | **yes, on commit, branch `main`** |
| Deletion risk | Very low | Very low |
| **Recommendation** | **DELETE CANDIDATE** | **DELETE CANDIDATE** |

## `dawaee-db`

**Do not delete. Not yet, and not on this evidence alone.**

| Property | Value |
|---|---|
| Engine | PostgreSQL **16** — note, production application data is on 17 elsewhere |
| Plan | free — **`expiresAt: 2026-10-03`** |
| `ipAllowList` | empty — no external access permitted |
| Active connections | **0 for essentially the entire 3-day window** |

Five isolated hours show exactly one connection (2026-09-03T04, 2026-09-04T04,
2026-09-04T16–19, 2026-09-05T05). A running application pool would hold
connections continuously; the primary worker connects every 60 seconds without
fail. Those single connections look like platform probes or a one-off manual
session, not an application.

**The inference that matters**, and it is an inference rather than a reading:
the primary worker demonstrably connects to a database every minute, and
`dawaee-db` shows no such pattern. Therefore the primary services are **not**
pointed at `dawaee-db`. This is consistent with `render.yaml`, which documents
the database as Supabase via the session-mode pooler.

That inference cannot be upgraded to a fact from here, because this MCP
integration exposes no read-only way to see a service's environment variables —
`update_environment_variables` is write-only, and writing is out of scope for a
read-only audit. **Confirming the target requires reading `DATABASE_URL`'s host
in the Render dashboard.**

**Classification: DELETION CANDIDATE — NOT "safe to delete".**

Note the expiry independently: a free Render Postgres expires 30 days after
creation. If anything *does* depend on it, that dependency breaks on
**2026-10-03** whether or not anyone deletes it.

## Deletion procedure — for authorization later, not for now

Never delete automatically. For each candidate, in this order:

**1. Confirm the environment is genuinely empty.** In the dashboard, open each
legacy service's Environment tab. If any variable exists, stop — the analysis
above no longer applies and the service must be re-assessed.

**2. Disable auto-deploy first, and leave it.** Set `autoDeploy: no` on all four
legacy services. This alone removes the build-minute cost and the red-badge
noise, and is fully reversible. It is the single highest-value action here and
it deletes nothing.

**3. Observe for 14 days.** Long enough to cover a weekly cycle plus a margin.
Zero traffic over a short window is not proof a service is unused; two weeks
with auto-deploy off and no metrics is meaningful evidence. Watch for anything
that starts failing.

**4. Suspend before deleting.** Render can suspend a service, which is
reversible. Suspend all four, wait a further 7 days.

**5. For `dawaee-db` specifically, before anything:**
   - Confirm `DATABASE_URL` on both primary services does **not** name it
   - Take a manual backup / export regardless — free-plan backups are limited
   - Confirm no migration tooling, cron, or external integration references it
   - Only then classify it for deletion

**6. Explicit operator approval, per resource, in writing.**

**7. Delete.**

Reverse the order of value: step 2 delivers most of the benefit at none of the
risk. There is no operational urgency to reach step 7.
