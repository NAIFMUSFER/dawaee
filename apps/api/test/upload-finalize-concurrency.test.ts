import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness } from './harness.js';

const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
let h: Harness;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (h) await h.close();
});

describe('upload finalize is idempotent under a concurrent client retry', () => {
  it('returns success to both callers when they finalize the same valid lease together', async () => {
    const user = await signIn(h, '+966500097794');

    const requested = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads/request',
      headers: authHeaders(user),
      payload: {
        purpose: 'medication_image',
        contentType: 'image/png',
        byteSize: IMAGE.length,
        patientProfileId: user.profileId,
      },
    });
    expect(requested.statusCode, requested.body).toBe(200);
    const { objectKey } = requested.json<{ objectKey: string }>();

    // Deterministically put both requests past the initial uploaded_at=NULL
    // read before either can perform the compare-and-set UPDATE. This is the
    // real mobile failure mode: a double tap / transport retry can overlap while
    // the provider read is in flight, and an idempotent finalize must not report
    // that the object vanished merely because its twin request won the race.
    let readers = 0;
    let release!: () => void;
    const bothReading = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(h.worker.providers.storage, 'getObject').mockImplementation(async () => {
      readers += 1;
      if (readers === 2) release();
      await bothReading;
      return IMAGE;
    });

    const finalize = () => h.app.inject({
      method: 'POST',
      url: '/v1/uploads/finalize',
      headers: authHeaders(user),
      payload: { objectKey },
    });

    const [first, second] = await Promise.all([finalize(), finalize()]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);

    // RED on the pre-fix route: one request wins the conditional UPDATE and
    // returns 200; the other observes rowCount=0 and incorrectly returns 404,
    // even though the same user's lease is now successfully finalized.
    expect(statuses, `${first.body} / ${second.body}`).toEqual([200, 200]);
    expect(read).toHaveBeenCalledTimes(2);

    await withUser(user.userId, async (tx) => {
      const { rows } = await tx.query<{ uploaded_at: Date | null; scan_status: string }>(
        'SELECT uploaded_at, scan_status FROM stored_objects WHERE object_key = $1',
        [objectKey],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.uploaded_at).not.toBeNull();
      expect(rows[0]!.scan_status).toBe('clean');
    });
  });
});
