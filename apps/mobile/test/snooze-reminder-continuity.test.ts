import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const todayFile = fileURLToPath(new URL('../app/(tabs)/today.tsx', import.meta.url));
const layoutFile = fileURLToPath(new URL('../app/_layout.tsx', import.meta.url));

function source(file: string): string {
  return readFileSync(file, 'utf8').replace(/\s+/g, ' ');
}

describe('snooze reminder continuity across cache and offline actions', () => {
  it('persists server snooze metadata needed by a later offline reminder rebuild', () => {
    const today = source(todayFile);
    const cacheStart = today.indexOf('await cacheSchedule({');
    const cacheEnd = today.indexOf('});', cacheStart);
    const cacheWrite = today.slice(cacheStart, cacheEnd);

    expect(cacheStart).toBeGreaterThanOrEqual(0);
    expect(cacheWrite).toContain('scheduledTimezone: d.scheduledTimezone');
    expect(cacheWrite).toContain('snoozedUntil: d.snoozedUntil');
  });

  it('rebuilds the self-profile local reminder immediately after an offline Today snooze is safely queued', () => {
    const today = source(todayFile);
    const snoozeStart = today.indexOf('const snooze = useCallback');
    const greetingStart = today.indexOf('const greeting = useMemo', snoozeStart);
    const snooze = today.slice(snoozeStart, greetingStart);

    expect(snoozeStart).toBeGreaterThanOrEqual(0);
    expect(snooze).toContain("await enqueue({ type: 'snoozed'");
    expect(snooze).toContain('activeProfile.isSelf');
    expect(snooze).toContain('await rebuildRemindersFromCache(');
  });

  it('rebuilds an offline lock-screen snooze before attempting network replay', () => {
    const layout = source(layoutFile);
    const listenerStart = layout.indexOf('startNotificationActionListener');
    const groupedStart = layout.indexOf('startGroupedNotificationListener', listenerStart);
    const listener = layout.slice(listenerStart, groupedStart);

    expect(listenerStart).toBeGreaterThanOrEqual(0);
    expect(listener).toContain("outcome.action === 'snoozed'");
    expect(listener).toContain('!outcome.synced');
    expect(listener).toContain('await rebuildRemindersFromCache(');
    expect(listener.indexOf('await rebuildRemindersFromCache(')).toBeLessThan(listener.indexOf('await refreshAfterAction()'));
  });
});
