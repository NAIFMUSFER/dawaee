import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from '../src/context.js';

const h = vi.hoisted(() => ({ runJob: vi.fn(), housekeeping: vi.fn() }));
vi.mock('../src/context.js', () => ({ runJob: h.runJob }));
vi.mock('../src/jobs/housekeeping.js', () => ({ housekeepingJob: h.housekeeping }));
import { createHousekeepingSchedule } from '../src/housekeeping-schedule.js';

const START = Date.parse('2026-09-19T14:00:00Z');
let now = START;
const ctx = { now: () => new Date(now) } as WorkerContext;

beforeEach(() => {
  now = START;
  h.runJob.mockReset().mockResolvedValue({ ran: true, itemsProcessed: 0 });
  h.housekeeping.mockReset();
});

describe('cleanup cadence used by the worker entry point', () => {
  it('runs on startup, waits an hour, then runs again', async () => {
    const run = createHousekeepingSchedule(ctx);
    await run();
    expect(h.runJob).toHaveBeenCalledWith(ctx, 'housekeeping', expect.any(Function));
    now += 59 * 60_000;
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(1);
    now += 60_000;
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(2);
  });

  it('retries on the next tick if another worker held the cleanup lock', async () => {
    const run = createHousekeepingSchedule(ctx);
    h.runJob.mockResolvedValueOnce({ ran: false, itemsProcessed: 0 });
    await run();
    now += 60_000;
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(2);
  });

  it('retries after a connection failure before a job could run', async () => {
    const run = createHousekeepingSchedule(ctx);
    h.runJob.mockRejectedValueOnce(new Error('synthetic database outage'));
    await expect(run()).rejects.toThrow('synthetic database outage');
    now += 60_000;
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight cleanup single while overlapping ticks arrive', async () => {
    let finish!: (value: { ran: boolean; itemsProcessed: number }) => void;
    h.runJob.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const run = createHousekeepingSchedule(ctx);
    const first = run();
    const second = run();
    expect(h.runJob).toHaveBeenCalledTimes(1);
    finish({ ran: true, itemsProcessed: 0 });
    await Promise.all([first, second]);
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(1);
  });

  it('records a completed failing job at the hourly cadence instead of retrying every minute', async () => {
    h.runJob.mockResolvedValue({ ran: true, itemsProcessed: 0,
      failures: [{ step: 'uploads', error: 'synthetic storage outage' }] });
    const run = createHousekeepingSchedule(ctx);
    await run();
    now += 60_000;
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(1);
    now += 60 * 60_000;
    await run();
    expect(h.runJob).toHaveBeenCalledTimes(2);
  });

  it('a restarted worker checks cleanup immediately even within the previous hour', async () => {
    await createHousekeepingSchedule(ctx)();
    now += 60_000;
    await createHousekeepingSchedule(ctx)();
    expect(h.runJob).toHaveBeenCalledTimes(2);
  });
});
