# F18 — serialize process ticks and drain shutdown

The worker interval started a fresh run even while the previous tick was still
active, replacing the only promise shutdown waited on. Individual database job
locks did not serialize the complete ordered tick and housekeeping sequence.

The entry point now uses one process loop that skips timer pulses while busy,
keeps housekeeping in the same flight, and clears its timer before awaiting the
active tick at shutdown. It does not accumulate delayed ticks. Per-job database
locks and job order are unchanged. Invalid zero/negative/non-finite intervals
fail startup rather than creating a hot loop.

Validation:
- 14/14 tick-loop and housekeeping cases passed with controlled timers/gates:
  six-minute work, delayed housekeeping, bounded concurrency, no catch-up queue,
  shutdown waiting, repeated stop, recovery after error and invalid configuration.
- Existing real worker subprocess stayed alive for 12 seconds against an
  unreachable database; its liveness test passed with the rebuilt entry point.
- Workspace TypeScript, changed-file ESLint and diff check passed.
- One initial test attempt used a matcher unavailable in the pinned Vitest;
  it was replaced by equivalent call-count and argument assertions and rerun.

No hosted worker was restarted or deployed. These are process scheduling and
local failure tests, not production throughput or device delivery evidence.
