/** One complete tick (including housekeeping) at a time in this process.
 * Database job locks still provide the separate cross-process boundary. */
export function startTickLoop(
  tick: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
): { stop: () => Promise<void> } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid worker tick interval');
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const pulse = () => {
    if (stopped || inFlight) return;
    inFlight = Promise.resolve().then(async () => {
      if (!stopped) await tick();
    }).catch(onError).finally(() => { inFlight = null; });
  };
  const timer = setInterval(pulse, intervalMs);
  pulse();
  return { stop: async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  } };
}
