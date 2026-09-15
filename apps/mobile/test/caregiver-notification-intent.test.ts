import { afterEach, describe, expect, it } from 'vitest';
import {
  bindCaregiverNotificationAccount as bind,
  clearCaregiverNotificationIntent as clear,
  getCaregiverNotificationIntent as read,
  isCaregiverNotificationIntentCurrent as current,
  setCaregiverNotificationIntent as select,
  subscribeCaregiverNotificationIntent as subscribe,
} from '../src/notifications/caregiver-intent';
import { startCaregiverNotificationListener, type CaregiverNotificationSelection } from '../src/notifications/caregiver-navigation';

const DELIVERY = '01234567-89ab-4cde-8fab-0123456789ab';
const OTHER = '01234567-89ab-4cde-8fab-0123456789ac';
const selection = { deliveryId: DELIVERY, kind: 'escalation' as const };
afterEach(() => bind(null));

describe('account-bound notification handoff', () => {
  it('accepts only the bound account and copies only the private handoff fields', () => {
    bind('one');
    select('two', selection);
    expect(read()).toBeNull();
    select('one', { ...selection, url: '/unexpected', patientId: 'unexpected' } as CaregiverNotificationSelection);
    expect(read()).toEqual({ ...selection, userId: 'one', revision: expect.any(Number) });
    expect(Object.isFrozen(read())).toBe(true);
  });
  it('keeps a tap across same-account profile renders and drops it at logout', () => {
    bind('one'); select('one', selection);
    const old = read()!;
    bind('one');
    expect(read()).toBe(old);
    bind(null); bind('one');
    expect(read()).toBeNull(); expect(current(old)).toBe(false);
  });
  it('invalidates a tap synchronously at account switch', () => {
    bind('one'); select('one', selection);
    const old = read()!;
    bind('two');
    expect(read()).toBeNull(); expect(current(old)).toBe(false);
    select('one', selection); expect(read()).toBeNull();
  });
  it('notifies an already-open screen and preserves the newer tap during old cleanup', () => {
    bind('one');
    let changes = 0;
    const unsubscribe = subscribe(() => { changes++; });
    select('one', selection); const old = read()!;
    select('one', { ...selection, deliveryId: OTHER }); const newer = read()!;
    clear(old);
    expect(read()).toBe(newer); expect(current(old)).toBe(false); expect(changes).toBe(2);
    clear(newer); expect(read()).toBeNull(); expect(changes).toBe(3);
    unsubscribe(); select('one', selection); expect(changes).toBe(3);
  });
});

describe('caregiver native-response selection', () => {
  function harness() {
    let listener: ((response: unknown) => void) | undefined;
    let last: unknown = null;
    const opened: CaregiverNotificationSelection[] = [];
    const stop = startCaregiverNotificationListener({
      DEFAULT_ACTION_IDENTIFIER: 'default',
      getLastNotificationResponseAsync: async () => last,
      clearLastNotificationResponseAsync: async () => { last = null; },
      addNotificationResponseReceivedListener: (fn) => { listener = fn; return { remove() { listener = undefined; } }; },
    }, (value) => opened.push(value), () => true);
    return { opened, stop, emit(deliveryId = DELIVERY, date: unknown = 100) {
      last = { actionIdentifier: 'default', notification: { date, request: {
        identifier: 'reused-native-id', content: { data: { kind: 'escalation', deliveryId, url: '/unexpected', patientId: 'unexpected' } },
      } } };
      listener?.(last);
    } };
  }
  it('passes only validated kind and delivery identity to the handoff', () => {
    const h = harness(); h.emit();
    expect(h.opened).toEqual([selection]); h.stop();
  });
  it('deduplicates one response but accepts a new delivery or occurrence with a reused native id', () => {
    const h = harness(); h.emit(); h.emit(); h.emit(OTHER); h.emit(OTHER, 200);
    expect(h.opened.map((v) => v.deliveryId)).toEqual([DELIVERY, OTHER, OTHER]); h.stop();
  });
  for (const date of [NaN, Infinity, '100', null]) {
    it(`ignores malformed native date ${String(date)}`, () => {
      const h = harness(); h.emit(DELIVERY, date); expect(h.opened).toEqual([]); h.stop();
    });
  }
});
