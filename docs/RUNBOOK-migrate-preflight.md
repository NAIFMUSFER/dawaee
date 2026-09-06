# Runbook — migration preflight

`scripts/migrate.sh --preflight-only` answers one question:

> Would this deploy get off the ground, or would it stop half way?

It applies nothing. Run it before any release that carries a pending migration,
and again from the operator machine before the deploy window opens.

```bash
DATABASE_URL='…'  DAWAEE_APP_PASSWORD='…'  DAWAEE_WORKER_PASSWORD='…' \
  ./scripts/migrate.sh --preflight-only
```

A clean run prints four lines and exits 0:

```
preflight: connection
preflight: migrating as 'postgres'
preflight: role administration OK
preflight: definer policies
preflight complete — no migration was applied
```

---

## Why a preflight exists at all

P18 measured the alternative. Two failures, both of which committed some
migrations before revealing themselves:

**1. Role administration.** Since PostgreSQL 16, a `CREATEROLE` role may only
change the password of a role it created, or one it holds `ADMIN OPTION` on.
`migrate.sh` sets both runtime passwords on every deploy — at the *end*, after
the migrations. With `dawaee_app` created by a different role, the run looked
like this:

```
applied 10 migration(s)
applying role grants…
ERROR:  permission denied to alter role
DETAIL:  To change another role's password, the current user must have the
         CREATEROLE attribute and the ADMIN option on the role.
```

Non-zero exit, ten migrations committed. On Render that is the worker's
`preDeployCommand`, so the deploy fails with production on a schema no commit
corresponds to.

**2. The definer privilege path.** Migration `0025` deduplicates `dose_events`
before creating a unique index. Under `FORCE ROW LEVEL SECURITY` on a database
whose owner is not a superuser, that `DELETE` matched **zero rows** — silently,
because RLS filtering a `DELETE` to nothing is not an error — and the index build
then failed:

```
  applying 0025_missed_event_uniqueness.sql
ERROR:  could not create unique index "dose_events_one_missed_idx"
DETAIL:  Duplicate keys exist.
```

Ledger left at 24. The preflight now applies `db/maintenance/definer_policies.sql`
*before* the migration loop, which is the only place it can go: nothing numbered
`0030` can rescue a migration that sorts at `0025`.

---

## What each check does, and what to do when it fails

### `preflight: connection`

`SELECT 1` over `DATABASE_URL`.

**Fails** → the URL, the network, or the database is wrong. Nothing else runs.

### `preflight: migrating as '<role>'`

Refuses if that role is `dawaee_app` or `dawaee_worker`.

**Fails** → `DATABASE_URL` names a runtime role. Migrating as `dawaee_app` would
make the application role the owner of every table and every SECURITY DEFINER
function, and the definer sweep would then hand it a blanket exemption from
row-level security on every patient table. It would look like a clean deploy.
Point `DATABASE_URL` at the schema owner.

### `preflight: role administration OK`

Only runs when `DAWAEE_APP_PASSWORD` and `DAWAEE_WORKER_PASSWORD` are both set,
because those are what make the role-grant step necessary.

**Fails** with the roles it cannot administer. Two ways forward:

```sql
-- As a role that can. INHERIT FALSE, SET FALSE: administration WITHOUT
-- inheriting the runtime roles' privileges or their RLS policies.
GRANT dawaee_app    TO <migration role> WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT dawaee_worker TO <migration role> WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
```

Or unset both passwords and manage them out of band; `migrate.sh` then skips
role administration entirely and says so.

> On PostgreSQL 15 and earlier, `WITH ADMIN OPTION` is the whole syntax. This
> project targets 16 and 17.

### `preflight: definer policies`

Applies `db/maintenance/definer_policies.sql`: creates
`app.ensure_definer_policies()` and runs it. Idempotent; on a database that is
already correct it creates nothing.

**Fails** if a runtime role is running migrations, if a runtime role is a member
of the migration role (so it could `SET ROLE` into the exemption), or if the
tables in `public` are owned by somebody other than the migration role. All three
are refusals to proceed, not warnings — each one would make the sweep grant the
exemption to the wrong role.

---

## Before a release, also check

Not part of the script, because they are judgement calls rather than
pass/fail — but they belong in the same five minutes.

```sql
-- 1. Can the migration role bypass RLS? This decides whether the definer
--    policies are load-bearing or merely tidy. Either answer is workable; not
--    knowing is not.
SELECT current_user, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user;

-- 2. Where does the ledger stop, and does it agree with the repository?
SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 5;

-- 3. Anything already carrying the duplicates 0025 must remove.
SELECT dose_occurrence_id, count(*) FROM dose_events
 WHERE type = 'missed' GROUP BY 1 HAVING count(*) > 1;

-- 4. Anything already carrying the surplus live challenges 0028 retires.
SELECT phone_e164, count(*) FROM auth_otp_challenges
 WHERE consumed_at IS NULL GROUP BY 1 HAVING count(*) > 1;
```

Rows from 3 or 4 are not a problem — those migrations exist to clean them up —
but they are what makes the definer policy load-bearing rather than theoretical,
so a non-empty result means the preflight in step 3 above is not optional.

---

## After migrating

`scripts/migrate.sh` runs the definer sweep again on the way out, so a table
created by the migrations just applied is covered on the same deploy rather than
the next one. Migration `0030` asserts the end state and fails the run if any
`FORCE ROW LEVEL SECURITY` table is still uncovered, if any policy is granted to
`PUBLIC`, if a runtime role could become the owner, or if a table enables
row-level security without forcing it.
