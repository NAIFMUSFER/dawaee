import { describe, expect, it } from 'vitest';

import { assessWorkerHeartbeat } from '../src/lib/deployment-coherence.js';

describe('deployment coherence', () => {
  it('fails closed when the API release identity is unknown', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const workerCommit = '0123456789abcdef0123456789abcdef01234567';

    const result = assessWorkerHeartbeat({
      apiCommit: 'unknown',
      heartbeat: {
        startedAt: now,
        succeeded: true,
        buildCommit: workerCommit,
      },
      now,
      maxAgeMs: 60_000,
    });

    expect(result).toEqual({
      ok: false,
      detail: 'API build identity unavailable',
    });
  });
});
