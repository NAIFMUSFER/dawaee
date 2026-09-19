import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { WorkerContext } from '../src/context.js';
import { housekeepingJob } from '../src/jobs/housekeeping.js';

function emptyDeployment(isProduction: boolean, storage: string) {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const deleteObject = vi.fn();
  const ctx = {
    config: { isProduction },
    providers: { storage: { name: storage, deleteObject } },
    log: { info: vi.fn(), error: vi.fn() },
    now: () => new Date('2026-09-19T14:00:00Z'),
  } as unknown as WorkerContext;
  return { ctx, client: { query } as unknown as PoolClient, deleteObject };
}

describe('account-erasure storage readiness without existing uploads', () => {
  it.each(['unconfigured', 'local', 'mock'])(
    'records unavailable production storage (%s) even when no object is due', async storage => {
      const h = emptyDeployment(true, storage);
      const result = await housekeepingJob(h.ctx, h.client);
      expect(result.failures).toContainEqual({
        step: 'storageConfiguration', error: 'Private image storage is not configured for production.',
      });
      expect(h.deleteObject).not.toHaveBeenCalled();
      // Other retention work still runs instead of being abandoned by the fault.
      expect(h.client.query).toHaveBeenCalledWith('SELECT app.purge_expired_otp(24)');
    },
  );

  it.each(['s3', 'r2'])('permits configured production storage (%s)', async storage => {
    const h = emptyDeployment(true, storage);
    expect((await housekeepingJob(h.ctx, h.client)).failures).toEqual([]);
  });

  it('permits deliberate local storage in the isolated preview', async () => {
    const h = emptyDeployment(false, 'local');
    expect((await housekeepingJob(h.ctx, h.client)).failures).toEqual([]);
  });
});
