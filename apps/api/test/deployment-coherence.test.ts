import { describe, expect, it } from 'vitest';

import {
  assessWorkerHeartbeat,
  WORKER_SCHEDULER_JOB_NAME,
} from '../src/lib/deployment-coherence.js';

describe('deployment coherence', () => {
  it('fails closed when the API release identity is unknown', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const workerReleaseId = '0123456789abcdef0123456789abcdef01234567';

    const result = assessWorkerHeartbeat({
      rows: [
        {
          job_name: WORKER_SCHEDULER_JOB_NAME,
          worker_release_id: workerReleaseId,
          updated_at: now.toISOString(),
        },
      ],
      apiCommit: 'unknown',
      now,
      staleAfterMs: 60_000,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'api-release-unknown',
      ageMs: null,
      workerReleaseId,
    });
  });
});
