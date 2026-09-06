# Retention: what is eligible for deletion, before deleting any of it

This runbook **reports only**. Every statement here is a `SELECT`. It exists
because P8 and P10 established that housekeeping had never completed a run in
production — the worker held no `DELETE` privilege, so the first step threw
`permission denied` and aborted the job before any retention below it ran — and
the backlog that accumulated has never been measured.

Do not run a deletion from this document. Deletion is a P17 activity, under
explicit operator authorization, after the numbers below have been read.

## Why measure first

The purge is `DELETE FROM notification_deliveries WHERE created_at < now() -
interval '90 days'`. If the backlog is a few thousand rows that is one
statement. If it is several million it is a long-held lock on a table the
reminder dispatcher writes to every minute, on a Supabase instance sized for a
small service — the cleanup becomes the outage. The row counts decide which of
those it is, and nothing in the repository can tell you.

## The queries

Read-only. Safe to run against production. They return counts and timestamps,
never a row value, never a patient identifier, never message text.

```sql
-- What each retention class holds, and how much of it is past its window.
SELECT 'notification_deliveries' AS table_name,
       count(*)                                              AS total_rows,
       count(*) FILTER (WHERE created_at < now() - interval '90 days'
                          AND status IN ('sent','delivered','read','skipped'))
                                                             AS eligible_rows,
       min(created_at)                                       AS oldest,
       max(created_at)                                       AS newest
  FROM notification_deliveries
UNION ALL
SELECT 'provider_webhook_events',
       count(*),
       count(*) FILTER (WHERE received_at < now() - interval '30 days'
                          AND processed_at IS NOT NULL),
       min(received_at), max(received_at)
  FROM provider_webhook_events
UNION ALL
SELECT 'job_runs',
       count(*),
       count(*) FILTER (WHERE started_at < now() - interval '14 days'),
       min(started_at), max(started_at)
  FROM job_runs
UNION ALL
SELECT 'auth_sessions',
       count(*),
       count(*) FILTER (WHERE expires_at < now() - interval '30 days'),
       min(created_at), max(created_at)
  FROM auth_sessions
UNION ALL
SELECT 'auth_otp_challenges',
       count(*),
       count(*) FILTER (WHERE expires_at < now()),
       min(created_at), max(created_at)
  FROM auth_otp_challenges
UNION ALL
SELECT 'stored_objects (never uploaded)',
       count(*),
       count(*) FILTER (WHERE uploaded_at IS NULL
                          AND created_at < now() - interval '24 hours'),
       min(created_at), max(created_at)
  FROM stored_objects
ORDER BY 1;
```

```sql
-- Is the backlog one long tail or a few bad days? Decides whether the purge
-- can be a single statement or has to be batched by month.
SELECT date_trunc('month', created_at) AS month, count(*) AS rows
  FROM notification_deliveries
 WHERE created_at < now() - interval '90 days'
 GROUP BY 1 ORDER BY 1;
```

```sql
-- Has housekeeping ever completed since the P8/P10 fixes? An empty result, or
-- only failures, means the backlog is still growing.
SELECT started_at, succeeded, items_processed,
       left(coalesce(error_message, ''), 120) AS error
  FROM job_runs
 WHERE job_name = 'housekeeping'
 ORDER BY started_at DESC
 LIMIT 20;
```

`error_message` is safe to read: since P13 it is written through
`sanitizeOperationalError`, which reduces a database error to its SQLSTATE and
constraint name and strips identifiers, phone numbers, paths, tokens and
embedded payloads.

```sql
-- Table sizes, to tell a row-count problem from a storage problem.
SELECT relname AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       n_live_tup AS approx_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE n.nspname = 'public'
   AND relname IN ('notification_deliveries','provider_webhook_events','job_runs',
                   'auth_sessions','auth_otp_challenges','audit_logs','stored_objects')
 ORDER BY pg_total_relation_size(c.oid) DESC;
```

## Reading the result

| What you see | What it means | What P17 should do |
|---|---|---|
| `eligible_rows` in the low thousands | Ordinary backlog | One statement, off-peak |
| `eligible_rows` in the millions | Housekeeping never ran, or ran and failed | Batch by month, `LIMIT`-ed loop, watch lock waits |
| `oldest` older than the service | Rows survived a restore or a migration | Investigate before deleting — this is not routine cleanup |
| `job_runs` shows only failures | The P8 grant fix is not deployed | Fix the deployment first; deleting by hand hides the cause |
| `audit_logs` growing without limit | Correct — see below | Nothing. It has no retention by design |

## Two things this cannot tell you

**`audit_logs` has no retention window and no housekeeping step.** That is
deliberate and it is not a defect: an append-only accountability record that
deletes itself is not one, and the table is readable only by the profile owner
(`audit_read` is scoped to `app.owns_profile`). But "grows forever" is a
product and legal decision, not a technical one, and no policy for it exists in
this repository. **POLICY MISSING** — carry to product/legal, not to P17.

**Render's stdout log retention is not verifiable from here.** The request log
carries the client IP address and the route (capability tokens and object keys
redacted, medication names never present). How long that is kept, and who in
the Render account can read it, is a fact about the platform and the plan.
**NOT VERIFIED / operator action required** — check the retention on the actual
plan and record it, because it is the retention period for every IP address the
service has ever seen.

## Rule

Separate the two questions and answer them separately:

- *Does the technical cleanup work?* — P8/P10 fixed the grant; the queries above
  say whether it has run since.
- *Is the retention duration right?* — 90 days for deliveries, 30 for webhooks,
  14 for job runs, 30 for expired sessions. These are engineering defaults
  chosen for operational usefulness. **No legal or product review has approved
  them**, and this document does not invent one. Saudi PDPL sets no single
  number that can be copied in here; the period has to come from the product's
  own stated purpose for each record.
