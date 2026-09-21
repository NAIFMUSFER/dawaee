import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTickLoop } from '../src/tick-loop.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('worker process tick scheduling', () => {
  it('skips elapsed intervals during a long tick, including its housekeeping', async () => {
    const work = gate(), housekeeping = gate();
    let active = 0, maximum = 0;
    const tick = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await work.promise;
      await housekeeping.promise;
      active--;
    });
    const loop = startTickLoop(tick, 60_000, error => { throw error; });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tick).toHaveBeenCalledTimes(1);
    work.resolve();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tick).toHaveBeenCalledTimes(1);
    housekeeping.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1); // no accumulated catch-up queue
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for the active tick before stop resolves and never schedules another', async () => {
    const work = gate();
    const tick = vi.fn(() => work.promise);
    const loop = startTickLoop(tick, 60_000, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const closing = loop.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(stopped).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);
    work.resolve();
    await closing;
    await loop.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('continues after a failed tick without leaving a stuck flight', async () => {
    const failure = new Error('synthetic tick failure');
    const tick = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const onError = vi.fn();
    const loop = startTickLoop(tick, 60_000, onError);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    await loop.stop();
  });
  it('can stop before the first scheduled work starts', async () => {
    const tick = vi.fn();
    const loop = startTickLoop(tick, 60_000, vi.fn());
    await loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])('refuses an invalid interval %s', interval => {
    expect(() => startTickLoop(vi.fn(), interval, vi.fn())).toThrow('Invalid worker tick interval');
    expect(vi.getTimerCount()).toBe(0);
  });
});
