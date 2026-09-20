import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  startGroupedNotificationListener, type GroupedNotificationApi,
} from '../src/notifications/grouped-navigation.js';

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const group = (identifier = 'group-1', date = 100) => ({
  actionIdentifier: DEFAULT,
  notification: { date, request: { identifier, content: { data: { kind: 'dose_group_reminder' } } } },
});
const other = (kind = 'escalation') => ({
  ...group('other'),
  notification: { ...group().notification, request: {
    identifier: 'other', content: { data: { kind, deliveryId: '00000000-0000-4000-8000-000000000001' } },
  } },
});
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function harness(options: {
  last?: unknown;
  startup?: () => Promise<unknown>;
  open?: (doseId: string | null) => void;
  failClear?: boolean;
} = {}) {
  let last: unknown = options.last ?? null;
  let listener: ((response: unknown) => void) | null = null;
  let read: (() => Promise<unknown>) | null = null;
  let reads = 0;
  let opens = 0;
  let clears = 0;
  let removals = 0;
  let generation = 0;
  const capturedGeneration = generation;
  const native: GroupedNotificationApi = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT,
    getLastNotificationResponseAsync: () => {
      reads += 1;
      if (reads === 1 && options.startup) return options.startup();
      return read ? read() : Promise.resolve(last);
    },
    clearLastNotificationResponseAsync: async () => {
      clears += 1;
      if (options.failClear) throw new Error('synthetic native cache failure');
      last = null;
    },
    addNotificationResponseReceivedListener: (next) => {
      listener = next;
      return { remove() { removals += 1; listener = null; } };
    },
  };
  const stop = startGroupedNotificationListener(native, (doseId) => {
    options.open?.(doseId);
    opens += 1;
  }, () => generation === capturedGeneration);
  return {
    emit(value: unknown) { last = value; listener?.(value); },
    callback: () => listener!,
    setLast(value: unknown) { last = value; },
    setRead(next: () => Promise<unknown>) { read = next; },
    invalidate() { generation += 1; },
    opens: () => opens, clears: () => clears, removals: () => removals, stop,
  };
}

describe('grouped reminder default-tap lifecycle', () => {
  it('handles a live default tap and consumes its matching response', async () => {
    const h = harness();
    await flush();
    h.emit(group());
    expect(h.opens()).toBe(1);
    await flush();
    expect(h.clears()).toBe(1);
    h.stop();
  });

  it('opens a single-dose default tap, including cold startup', async () => {
    const reminder = other('dose_reminder');
    (reminder.notification.request.content.data as Record<string, unknown>).doseId = '00000000-0000-4000-8000-000000000003';
    const h = harness({ last: reminder });
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(1);
    h.stop();
  });

  it('handles an authenticated cold-start tap', async () => {
    const h = harness({ last: group() });
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(1);
    h.stop();
  });

  it('routes the dose from the remote JSON group once across cold and live delivery', async () => {
    const response = group('remote-group');
    Object.assign(response.notification.request.content.data, { doseIds: JSON.stringify(['DEPENDENT-DOSE', 'SECOND-DOSE']) });
    const opened: (string | null)[] = [];
    const h = harness({ last: response, open: (id) => opened.push(id) });
    await flush();
    h.emit(response);
    await flush();
    expect(opened).toEqual(['DEPENDENT-DOSE']);
    h.stop();
  });

  it('routes the snooze repeat default tap using its dose identity', async () => {
    const response = other('dose_reminder_repeat');
    Object.assign(response.notification.request.content.data, { doseId: 'SNOOZED-DOSE' });
    const opened: (string | null)[] = [];
    const h = harness({ last: response, open: (id) => opened.push(id) });
    await flush();
    expect(opened).toEqual(['SNOOZED-DOSE']);
    expect(h.clears()).toBe(1);
    h.stop();
  });

  for (const doseIds of ['bad-json', '{}', '[]', 'x'.repeat(16_385), Array(101).fill('dose'), [null]]) {
    it(`ignores malformed grouped identities ${String(doseIds).slice(0, 15)}`, async () => {
      const response = group();
      Object.assign(response.notification.request.content.data, { doseIds });
      const h = harness({ last: response });
      await flush();
      expect(h.opens()).toBe(0);
      expect(h.clears()).toBe(0);
      h.stop();
    });
  }

  for (const actionIdentifier of ['taken', 'snooze', 'skip', '']) {
    it(`does not interpret ${actionIdentifier || 'missing default'} as a default tap`, async () => {
      const h = harness({ last: { ...group(), actionIdentifier } });
      await flush();
      h.emit({ ...group(), actionIdentifier });
      await flush();
      expect(h.opens()).toBe(0);
      expect(h.clears()).toBe(0);
      h.stop();
    });
  }

  for (const kind of ['escalation', 'daily_summary', 'weekly_summary', 'dose_reminder']) {
    it(`leaves ${kind} responses for their own listener`, async () => {
      const h = harness({ last: other(kind) });
      await flush();
      h.emit(other(kind));
      await flush();
      expect(h.opens()).toBe(0);
      expect(h.clears()).toBe(0);
      h.stop();
    });
  }

  const malformed: unknown[] = [
    null, [], { actionIdentifier: DEFAULT },
    { ...group(), notification: [] },
    { ...group(), notification: { request: [] } },
    { ...group(), notification: { request: { identifier: 'id', content: { data: [] } } } },
    group(''), group('x'.repeat(1025)), group('invalid-date', Number.NaN),
  ];
  for (const [index, response] of malformed.entries()) {
    it(`ignores malformed response ${index} without consuming native state`, async () => {
      const h = harness({ last: response });
      await flush();
      h.emit(response);
      await flush();
      expect(h.opens()).toBe(0);
      expect(h.clears()).toBe(0);
      h.stop();
    });
  }

  it('deduplicates repeated delivery of the same response', async () => {
    const h = harness();
    await flush();
    h.emit(group());
    h.emit(group());
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(1);
    h.stop();
  });

  it('does not suppress another occurrence of a repeating local request', async () => {
    const h = harness();
    await flush();
    h.emit(group('repeat', 100));
    await flush();
    h.emit(group('repeat', 200));
    await flush();
    expect(h.opens()).toBe(2);
    expect(h.clears()).toBe(2);
    h.stop();
  });

  it('subscribes before the initial native lookup resolves and ignores its stale result', async () => {
    const startup = deferred();
    const h = harness({ startup: () => startup.promise });
    await flush();
    h.emit(group('new'));
    expect(h.opens()).toBe(1);
    startup.resolve(group('old'));
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(1);
    h.stop();
  });

  it('does not override a newer unrelated gesture with an old startup response', async () => {
    const startup = deferred();
    const h = harness({ startup: () => startup.promise });
    await flush();
    h.emit(other());
    startup.resolve(group('old'));
    await flush();
    expect(h.opens()).toBe(0);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('ignores a native startup response after cleanup', async () => {
    const startup = deferred();
    const h = harness({ startup: () => startup.promise });
    await flush();
    h.stop();
    startup.resolve(group());
    await flush();
    expect(h.opens()).toBe(0);
    expect(h.clears()).toBe(0);
  });

  it('invalidates a queued live callback before passive cleanup after account change', async () => {
    const h = harness();
    await flush();
    const queued = h.callback();
    h.invalidate();
    queued(group());
    await flush();
    expect(h.opens()).toBe(0);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('does not resurrect the old callback after an A-to-B-to-A account transition', async () => {
    const h = harness();
    await flush();
    const queued = h.callback();
    h.invalidate();
    h.invalidate();
    queued(group());
    await flush();
    expect(h.opens()).toBe(0);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('also fences a cold-start response on account change before cleanup', async () => {
    const startup = deferred();
    const h = harness({ startup: () => startup.promise });
    await flush();
    h.invalidate();
    startup.resolve(group());
    await flush();
    expect(h.opens()).toBe(0);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  for (const synchronous of [true, false]) {
    it(`keeps live taps working after a ${synchronous ? 'synchronous' : 'rejected'} startup read failure`, async () => {
      const h = harness({ startup: () => {
        if (synchronous) throw new Error('synthetic read failure');
        return Promise.reject(new Error('synthetic read failure'));
      } });
      await flush();
      h.emit(group());
      await flush();
      expect(h.opens()).toBe(1);
      expect(h.clears()).toBe(1);
      h.stop();
    });
  }

  it('does not clear a newer caregiver notification found during consumption', async () => {
    const h = harness();
    await flush();
    const reading = deferred();
    h.setRead(() => reading.promise);
    h.emit(group());
    h.setLast(other());
    reading.resolve(other());
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('does not clear after a newer live response even if an older read returns the matching id', async () => {
    const h = harness();
    await flush();
    const reading = deferred();
    h.setRead(() => reading.promise);
    h.emit(group());
    h.emit(other());
    reading.resolve(group());
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('does not clear a newer occurrence reusing the same request identifier', async () => {
    const h = harness();
    await flush();
    const reading = deferred();
    h.setRead(() => reading.promise);
    h.emit(group('repeat', 100));
    reading.resolve(group('repeat', 200));
    await flush();
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('does not clear a newer non-default action on the same request', async () => {
    const h = harness();
    await flush();
    const reading = deferred();
    h.setRead(() => reading.promise);
    h.emit(group());
    reading.resolve({ ...group(), actionIdentifier: 'taken' });
    await flush();
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('fences pending consumption on account change', async () => {
    const h = harness();
    await flush();
    const reading = deferred();
    h.setRead(() => reading.promise);
    h.emit(group());
    h.invalidate();
    reading.resolve(group());
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(0);
    h.stop();
  });

  it('does not repeat navigation when native cache clearing fails', async () => {
    const h = harness({ failClear: true });
    await flush();
    h.emit(group());
    await flush();
    h.emit(group());
    await flush();
    expect(h.opens()).toBe(1);
    h.stop();
  });

  it('retries a failed navigation without prematurely consuming the response', async () => {
    let attempts = 0;
    const h = harness({ open: () => { attempts += 1; if (attempts === 1) throw new Error('navigation failed'); } });
    await flush();
    h.emit(group());
    await flush();
    expect(h.clears()).toBe(0);
    h.emit(group());
    await flush();
    expect(h.opens()).toBe(1);
    expect(h.clears()).toBe(1);
    h.stop();
  });

  it('cleans up once and ignores an already-queued callback after stopping', async () => {
    const h = harness();
    await flush();
    const queued = h.callback();
    h.stop();
    h.stop();
    queued(group());
    await flush();
    expect(h.removals()).toBe(1);
    expect(h.opens()).toBe(0);
    expect(h.clears()).toBe(0);
  });

  it('the shell fences module loading and routes to a fixed path without using payload identifiers', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../app/_layout.tsx'), 'utf8');
    const grouped = source.slice(source.indexOf('A grouped reminder deliberately'), source.indexOf('  return (\n    <I18nProvider'));
    expect(grouped).toContain("if (!ready || !signedIn || deletionPending || !user?.id || Platform.OS === 'web') return;");
    expect(grouped).toContain('const generation = caregiverSession.current.generation;');
    expect(grouped).toContain('caregiverSession.current.generation === generation');
    expect(grouped).toContain('if (!isCurrent()) return;');
    expect(grouped).toContain('stop = startGroupedNotificationListener(');
    expect(grouped).toContain("router.replace('/notification')");
    expect(grouped).toContain('setPatientReminderIntent(user.id, { doseId })');
    expect(grouped).toContain('[ready, signedIn, deletionPending, user?.id, router]');
    expect(grouped).not.toContain('getLastNotificationResponseAsync');
    expect(grouped).not.toContain('clearLastNotificationResponseAsync');
  });
});
