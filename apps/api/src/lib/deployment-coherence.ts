const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * The commit the running process was actually built from.
 *
 * Render supplies RENDER_GIT_COMMIT to both the API and worker. GIT_COMMIT is
 * the portable fallback for non-Render builds. Values are validated before
 * they are written to job metadata or exposed by /version.
 */
export function runtimeCommit(env: NodeJS.ProcessEnv = process.env): string {
  const commit = [env.RENDER_GIT_COMMIT, env.GIT_COMMIT]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value) && COMMIT_PATTERN.test(value!));
  return commit ?? 'unknown';
}

export interface WorkerHeartbeat {
  startedAt: Date | string;
  succeeded: boolean;
  buildCommit: string | null;
}

export interface CoherenceCheck {
  ok: boolean;
  detail: string;
}

/**
 * Decide whether the worker that is actually executing jobs belongs to the
 * same release as the API.
 *
 * This exists because the two Render services are deployed independently.
 * Production was observed with the API on a newer commit while the worker was
 * still running an older reminder implementation. /health/ready previously
 * checked only the API process and database, so it reported READY while the
 * safety-critical reminder path was stale.
 */
export function assessWorkerHeartbeat(input: {
  apiCommit: string;
  heartbeat: WorkerHeartbeat | null;
  now?: Date;
  maxAgeMs?: number;
}): CoherenceCheck {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? 180_000;
  const heartbeat = input.heartbeat;

  if (!heartbeat) return { ok: false, detail: 'no worker heartbeat recorded' };

  const startedAt = heartbeat.startedAt instanceof Date
    ? heartbeat.startedAt
    : new Date(heartbeat.startedAt);
  if (!Number.isFinite(startedAt.getTime())) {
    return { ok: false, detail: 'worker heartbeat timestamp is invalid' };
  }

  const ageMs = Math.max(0, now.getTime() - startedAt.getTime());
  if (ageMs > maxAgeMs) {
    return { ok: false, detail: `worker heartbeat is stale (${Math.round(ageMs / 1000)}s)` };
  }
  if (!heartbeat.succeeded) {
    return { ok: false, detail: 'latest reminder job failed' };
  }

  const workerCommit = heartbeat.buildCommit?.trim() || 'unknown';
  if (workerCommit === 'unknown') {
    return { ok: false, detail: 'worker build identity unavailable' };
  }
  if (!COMMIT_PATTERN.test(workerCommit)) {
    return { ok: false, detail: 'worker build identity is invalid' };
  }
  if (input.apiCommit !== 'unknown' && workerCommit !== input.apiCommit) {
    return { ok: false, detail: `worker/API commit mismatch (${workerCommit.slice(0, 12)} != ${input.apiCommit.slice(0, 12)})` };
  }

  return { ok: true, detail: `${workerCommit.slice(0, 12)} · ${Math.round(ageMs / 1000)}s ago` };
}
