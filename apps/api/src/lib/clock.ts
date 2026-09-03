/**
 * The server's clock, behind one function.
 *
 * Almost every rule in this system is a statement about time — whether a dose
 * is late, whether an invitation expired, which day a report covers — and a
 * rule you cannot put a clock in front of is a rule you cannot test. Routes
 * therefore read the time from here rather than calling `new Date()`, so a
 * test can place the server at 20:35 on the day the scenario is about.
 *
 * `confirmTaken` still clamps a client-supplied timestamp to this value, so
 * moving the clock in a test does not weaken that check — it moves the ceiling
 * the check is made against.
 */
let source: () => Date = () => new Date();

export function now(): Date {
  return source();
}

/** Test-only. Production code must never call this. */
export function setClockSource(fn: () => Date): void {
  source = fn;
}

/** Test-only. Restores the real clock. */
export function resetClockSource(): void {
  source = () => new Date();
}
