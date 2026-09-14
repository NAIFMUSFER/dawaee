# PR #25 — rebuilt runtime recovery

This extends the [synthetic archive rehearsal](2026-09-14-recovery-rehearsal.md)
to complete API and worker processes. It uses each selected source's unchanged
Dockerfile, lockfiles and default entrypoint. These are **rebuilt images**, not
retrieved original Render images. The production backup, role mapping, TLS and
provider configuration, platform rollback mechanism and installed devices still
need their separate release evidence.

The recorded live sources were rechecked through Render in this continuation:

| Runtime | Source commit | Recorded live deploy |
| --- | --- | --- |
| Old API | `4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72` | `dep-dajgcue7bikc73bvq9j0` |
| Old worker | `0338ddefc475d23cccecf13d5ede0f32d2007fb0` | `dep-dai8atfqj5pc739j2vu0` |
| Candidate API and worker | Exact PR head checked out by the job | No production deploy |

## CI execution and containment

The required `runtime-recovery` CI job runs
`node scripts/release-runtime-recovery.mjs` on a disposable GitHub-hosted runner.
It refuses a different repository, self-hosted runner, remote Docker daemon,
non-default Docker context, non-test database topology or a checkout differing
from the selected full candidate SHA. Eighteen local unit cases hold the
environment and loopback boundaries; the release-suite inventory requires their collection.

Only the two fixed old commits are fetched. Detached temporary worktrees keep
all three build contexts clean. Docker builds run normally with registry access;
the resulting **application containers** run on a fresh internal bridge network
with no external provider credentials and with explicit mock push/OCR and local
storage configuration. Fixed-target TCP forwarders bind API/PostgreSQL access
only to host loopback. They run in child processes so the controller's synchronous
PostgreSQL commands cannot block forwarding; Docker publishes no container ports.
Application root filesystems are read-only, runtime users are non-root, and each
container connects as its ordinary app or worker database role. No application
source or entrypoint is patched to make the test pass.

Docker documents the [internal network boundary and host access](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal).
Internal networks still permit host/gateway communication; this test is an
isolated application integration environment, not a hostile-code sandbox.

The harness creates its own PostgreSQL 17 container, verifies its sole network
and loopback forwarder, and only then bootstraps ordinary CI roles. The shared archive harness
creates fresh database names and rejects overwriting the source or a populated
target. Cleanup tracks successful creations, drains runtime processes, drops
owned databases, stops forwarders, removes owned containers/anonymous volumes/network, and removes
temporary worktrees. Built images disappear with the disposable runner.

## Acceptance sequence

| Phase | Required observation |
| --- | --- |
| Original baseline | Real migrations create 0001–0033 + 0047; old API starts, reports its SHA, registers a synthetic account, logs in and rotates a refresh token |
| Old API data paths | Real HTTP creates medication, schedule and stock; stock reads, take, immediate replay and undo produce 30 → 29 → 30 |
| Old worker before backup | Its unchanged main loop materializes a fixture gap, records all seven jobs and deletes an expired operational row; upload cleanup is explicitly observed as a successful-but-ineffective RLS no-op; SIGTERM drains cleanly |
| Quiescent backup | Old runtimes stop, their database sessions are absent, and a populated custom-format dump is taken |
| Candidate on restored upgrade | Restore comparisons pass before upgrade; all 80 ledger checksums match and the next migration run is a no-op; both current runtimes start |
| Current API and worker | Login/refresh and HTTP take/undo/re-take/history replay preserve stock; seven ledger rows reconstruct balance 30 and four new movements identify distinct events; all eight worker jobs succeed with the candidate SHA |
| Old runtimes on upgraded schema | Old API can start but its stock-backed confirmation returns HTTP 500 with clinical state rolled back; old worker records failed upload housekeeping; any other failed jobs are recorded too |
| Recovered baseline | Original archive restored into another fresh database matches rows, ledger, sequences, grants/RLS, policies, functions, indexes and constraints before startup |
| Matching recovered runtimes | Candidate API refuses the old ledger; old API logs in/refreshes, takes and undoes a dose, and reproduces its missing re-take ledger movement; old worker materializes and removes the expired operational row while upload tickets remain; original 34-row ledger stays unchanged |

Each worker uses `WORKER_TICK_SECONDS=3600` so its **real first tick** includes
hourly housekeeping immediately, followed by an idle interval. The harness
checks newly inserted `job_runs` above the pre-start ID; restored historical
successes cannot satisfy the check. Materialization and operational-row retention
perform real work. Each version's upload outcome is checked separately. Other
jobs must complete, but their success is not evidence of a
real push being sent or received. The runtime image and API identities are
checked, and candidate job stamps must match. A test-mode `/health/ready` result
is not the production provider/coherence acceptance gate.

The final `RUNTIME RECOVERY REHEARSAL PASSED` JSON is emitted **after cleanup**.
It records full source SHAs, built image IDs, root lockfile blobs, required
schemas, archive digest, timings, job outcomes and explicit evidence limits.
Keep the exact job URL and candidate SHA with the release record; do not inherit
a previous candidate's result. Tiny synthetic fixtures do not measure production
restore time or prove production data compatibility.

## Restoring the baseline also restores its defects

The first full-runtime attempt with working network access exposed the old
worker's upload DELETE matching zero rows under FORCE RLS, although its job
reported success. Migration 0038 already documents this defect; 0039 turns the
old direct-table path into an explicit permission failure on the upgraded schema.
The rehearsal preserves the baseline policies and verifies the no-op both before
backup and after restore. A separate expired operational row must actually be
deleted; the current worker must remove all abandoned upload tickets.

After restore, re-taking the previously undone dose changes live stock to 29,
while the old three-row ledger still reconstructs 30. The following undo returns
live stock to 30. This is the historical defect addressed by 0037, now explicitly
recorded through the unmodified old HTTP runtime. Restored login, HTTP availability
or successful job flags cannot establish that the old build is fully healthy.

Original image identity,
production-derived restore, object-store recovery, offline queue reconciliation
and physical Android/iPhone acceptance remain outstanding. Keep PR #25 Draft.
