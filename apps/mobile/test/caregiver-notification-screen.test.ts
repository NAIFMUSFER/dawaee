import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intents from '../src/notifications/caregiver-intent';
import { startCaregiverNotificationListener } from '../src/notifications/caregiver-navigation';

const require = createRequire(import.meta.url);
const { createHarness, deferred, ApiError, NetworkError } = require('./profile-screen-harness.cjs');
const SCREEN = resolve('apps/mobile/app/caregiver/notification.tsx');
const HOOK = resolve('apps/mobile/src/hooks/useRequestScope.ts');
const USER = 'synthetic-caregiver';
const DELIVERY_A = '01234567-89ab-4cde-8fab-0123456789ab';
const DELIVERY_B = '01234567-89ab-4cde-8fab-0123456789ac';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const permissions = ['receive_notifications', 'view_medications', 'view_schedule', 'view_adherence'];
const setups: any[] = [];

function select(deliveryId = DELIVERY_A, kind: 'escalation' | 'daily_summary' | 'weekly_summary' = 'escalation') {
  intents.setCaregiverNotificationIntent(USER, { deliveryId, kind });
}
function result(patientProfileId = PATIENT_B, kind = 'escalation') {
  return { notification: { kind, patientProfileId, patientDisplayName: `SYNTHETIC-${patientProfileId === PATIENT_B ? 'B' : 'A'}` } };
}
function setup(options: { empty?: boolean; locked?: boolean; areaLocked?: boolean; signedIn?: boolean } = {}) {
  const selections: string[] = [];
  const lock = { locked: !!options.locked, areaLocked: !!options.areaLocked, needsArea: (area: string) => area === 'caregivers' && lock.areaLocked };
  const app: any = {
    ready: true, signedIn: options.signedIn ?? true, user: { id: USER },
    activeProfile: { id: PATIENT_A, role: 'caregiver' },
    profiles: [PATIENT_A, PATIENT_B].map((id) => ({ id, displayName: `local-${id}`, role: 'caregiver', permissions: [...permissions] })),
    refreshProfiles: vi.fn(async () => undefined),
    setActiveProfile: (id: string) => {
      selections.push(id);
      app.activeProfile = app.profiles.find((p: any) => p.id === id) ?? app.activeProfile;
      h.dirty = true;
    },
  };
  if (!options.empty) select();
  const h = createHarness(SCREEN, HOOK, {}, {
    '@/state/app-store': { useApp: () => app },
    '@/security/AppLockGate': { useAppLock: () => lock },
    '@/notifications/caregiver-intent': intents,
  });
  const entry = { h, app, lock, selections };
  setups.push(entry);
  return entry;
}
async function answer(h: any, response = result(), index = h.requests.length - 1) {
  h.requests[index].resolve(response);
  await h.flush();
}
function press(h: any, label: string) {
  const button = h.find('Button', (props: any) => props.label === label);
  expect(button, label).toBeTruthy();
  button.onPress();
}

beforeEach(() => { intents.bindCaregiverNotificationAccount(null); intents.bindCaregiverNotificationAccount(USER); });
afterEach(() => { for (const { h } of setups.splice(0)) h.unmount(); intents.bindCaregiverNotificationAccount(null); });

/** Real screen/listener modules with synthetic native, React and network
 * boundaries. These tests do not claim physical push receipt or device E2E. */
describe('delivery-specific caregiver notification screen', () => {
  it('sends only the delivery in the POST body and shows the server-selected second patient', async () => {
    const { h, selections } = setup();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ method: 'POST', route: '/v1/caregivers/notification/resolve', payload: { deliveryId: DELIVERY_A } });
    expect(h.text()).toContain('caregiver.notificationLoading');
    await answer(h);
    expect(h.text()).toContain('SYNTHETIC-B');
    expect(h.text()).not.toContain('SYNTHETIC-A');
    expect(h.routes).toEqual([]);
    expect(selections).toEqual([]);
  });

  it('revalidates, selects exactly the resolved patient, and waits before the fixed dashboard route', async () => {
    const { h, app, selections } = setup();
    await answer(h);
    press(h, 'caregiver.notificationOpen');
    expect(h.routes).toEqual([]);
    await answer(h);
    expect(app.refreshProfiles).toHaveBeenCalledTimes(2);
    expect(selections).toEqual([PATIENT_B]);
    expect(app.activeProfile.id).toBe(PATIENT_B);
    expect(h.routes).toEqual(['/caregiver/dashboard']);
    expect(intents.getCaregiverNotificationIntent()).toBeNull();
    expect(h.requests.every((r: any) => r.route === '/v1/caregivers/notification/resolve')).toBe(true);
    expect(h.queued).toEqual([]);
  });

  it('ignores a payload-selected person and handles a newer tap while already on the route', async () => {
    const { h } = setup();
    await answer(h, result(PATIENT_A));
    let callback: ((value: unknown) => void) | undefined;
    const stop = startCaregiverNotificationListener({
      DEFAULT_ACTION_IDENTIFIER: 'default', getLastNotificationResponseAsync: async () => null,
      clearLastNotificationResponseAsync: async () => undefined,
      addNotificationResponseReceivedListener: (next) => { callback = next; return { remove() {} }; },
    }, (selection) => intents.setCaregiverNotificationIntent(USER, selection), () => true);
    callback?.({ actionIdentifier: 'default', notification: { request: {
      identifier: 'synthetic-new-tap', content: { data: { kind: 'escalation', deliveryId: DELIVERY_B, patientId: PATIENT_A, patientName: 'Untrusted name', url: '/untrusted' } },
    } } });
    h.render(false);
    expect(h.text()).not.toContain('SYNTHETIC-A');
    await h.flush();
    expect(h.requests[1].payload).toEqual({ deliveryId: DELIVERY_B });
    await answer(h);
    expect(h.text()).toContain('SYNTHETIC-B');
    expect(h.text()).not.toContain('Untrusted name');
    stop();
  });

  it('ignores a late resolver response after a newer selection, even before effects commit', async () => {
    const { h, app } = setup();
    const old = h.requests[0];
    select(DELIVERY_B);
    old.resolve(result(PATIENT_A));
    await h.flush();
    expect(app.refreshProfiles).not.toHaveBeenCalled();
    expect(h.text()).not.toContain('SYNTHETIC-A');
    await answer(h);
    expect(h.text()).toContain('SYNTHETIC-B');
  });

  it('ignores a previous tap still awaiting a profile refresh', async () => {
    const { h, app } = setup();
    const refresh = deferred();
    app.refreshProfiles.mockImplementationOnce(() => refresh.promise);
    h.requests[0].resolve(result(PATIENT_A));
    await h.flush();
    select(DELIVERY_B);
    await h.flush();
    await answer(h);
    refresh.resolve();
    await h.flush();
    expect(h.text()).toContain('SYNTHETIC-B');
    expect(h.text()).not.toContain('SYNTHETIC-A');
  });

  for (const signedIn of [false, true]) {
    it(`drops the prior identity at ${signedIn ? 'account switch' : 'logout'} before passive effects`, async () => {
      const { h, app } = setup();
      const pending = h.requests[0];
      intents.bindCaregiverNotificationAccount(signedIn ? 'other-account' : null);
      app.signedIn = signedIn;
      app.user = signedIn ? { id: 'other-account' } : null;
      h.render(false);
      pending.resolve(result());
      await h.flush();
      expect(h.text()).not.toContain('SYNTHETIC-B');
      expect(app.refreshProfiles).not.toHaveBeenCalled();
      expect(h.routes).toEqual([]);
    });
  }

  it('does not restore a selection after signing out and back into the same account', async () => {
    const { h } = setup();
    const pending = h.requests[0];
    intents.bindCaregiverNotificationAccount(null);
    intents.bindCaregiverNotificationAccount(USER);
    pending.resolve(result());
    await h.flush();
    h.render();
    expect(h.text()).not.toContain('SYNTHETIC-B');
    expect(intents.getCaregiverNotificationIntent()).toBeNull();
  });

  for (const mode of ['close', 'blur', 'unmount']) {
    it(`invalidates in-flight work on ${mode}`, async () => {
      const { h, app } = setup();
      const pending = h.requests[0];
      if (mode === 'close') press(h, 'common.back');
      else if (mode === 'blur') h.blur();
      else h.unmount();
      pending.resolve(result());
      await h.flush();
      expect(app.refreshProfiles).not.toHaveBeenCalled();
      expect(h.routes).not.toContain('/caregiver/dashboard');
      expect(intents.getCaregiverNotificationIntent()).toBeNull();
    });
  }

  for (const mode of ['locked', 'areaLocked'] as const) {
    it(`waits for ${mode} to clear, and discards responses started before relocking`, async () => {
      const { h, lock } = setup({ [mode]: true });
      expect(h.requests).toHaveLength(0);
      expect(h.tree).toBeNull();
      lock[mode] = false;
      h.render();
      expect(h.requests).toHaveLength(1);
      lock[mode] = true;
      h.render(false);
      h.requests[0].resolve(result(PATIENT_A));
      await h.flush();
      expect(h.tree).toBeNull();
      lock[mode] = false;
      h.render();
      await answer(h);
      expect(h.text()).toContain('SYNTHETIC-B');
    });
  }

  it('shows an offline state and retries without a clinical empty-state claim', async () => {
    const { h } = setup();
    h.requests[0].reject(new NetworkError());
    await h.flush();
    expect(h.text()).toContain('caregiver.notificationOffline');
    expect(h.text()).not.toContain('noDoses');
    press(h, 'common.retry');
    await answer(h);
    expect(h.text()).toContain('SYNTHETIC-B');
  });

  it('hides a previously resolved identity on the first unlock frame until revalidation', async () => {
    const { h, lock } = setup();
    await answer(h);
    expect(h.text()).toContain('SYNTHETIC-B');
    lock.locked = true;
    h.render();
    lock.locked = false;
    h.render(false);
    expect(h.text()).not.toContain('SYNTHETIC-B');
    await h.flush();
    h.requests.at(-1).reject(new ApiError('not_found'));
    await h.flush();
    expect(h.text()).toContain('caregiver.notificationUnavailable');
    expect(h.text()).not.toContain('SYNTHETIC-B');
  });

  it('only the newest retry can commit when two requests finish in reverse order', async () => {
    const { h, selections } = setup();
    await answer(h);
    const open = h.find('Button', (p: any) => p.label === 'caregiver.notificationOpen').onPress;
    open(); open();
    expect(h.requests).toHaveLength(3);
    await answer(h, result(PATIENT_B), 2);
    await answer(h, result(PATIENT_A), 1);
    expect(selections).toEqual([PATIENT_B]);
    expect(h.routes).toEqual(['/caregiver/dashboard']);
  });

  for (const code of ['not_found', 'forbidden', 'unauthorized', 'session_changed']) {
    it(`clears identity and stays off the dashboard after ${code} on revalidation`, async () => {
      const { h } = setup();
      await answer(h);
      press(h, 'caregiver.notificationOpen');
      h.requests[1].reject(new ApiError(code));
      await h.flush();
      expect(h.text()).toContain('caregiver.notificationUnavailable');
      expect(h.text()).not.toContain('SYNTHETIC-B');
      expect(h.routes).toEqual([]);
    });
  }

  it('handles a server failure without displaying raw error content', async () => {
    const { h } = setup();
    h.requests[0].reject(new Error('SYNTHETIC-RAW-PRIVATE-ERROR'));
    await h.flush();
    expect(h.text()).toContain('caregiver.notificationError');
    expect(h.text()).not.toContain('SYNTHETIC-RAW-PRIVATE-ERROR');
  });

  it('does not infer an identity from profiles when opened without a native selection', () => {
    const { h } = setup({ empty: true });
    expect(h.requests).toHaveLength(0);
    expect(h.text()).toContain('caregiver.notificationUnavailable');
    expect(h.find('Button', (p: any) => p.label === 'caregiver.notificationOpen')).toBeNull();
  });

  it('does not resolve while signed out even if a process-local selection exists', () => {
    const { h } = setup({ signedIn: false });
    expect(h.requests).toHaveLength(0);
  });

  for (const change of ['removed', 'role', 'permission']) {
    it(`does not fall back to the active or first patient when target is ${change}`, async () => {
      const { h, app, selections } = setup();
      await answer(h);
      press(h, 'caregiver.notificationOpen');
      app.refreshProfiles.mockImplementationOnce(async () => {
        if (change === 'removed') app.profiles = app.profiles.filter((p: any) => p.id !== PATIENT_B);
        else if (change === 'role') app.profiles[1].role = 'owner';
        else app.profiles[1].permissions = ['view_schedule'];
      });
      await answer(h);
      expect(h.text()).toContain('caregiver.notificationUnavailable');
      expect(h.text()).not.toContain('SYNTHETIC-B');
      expect(selections).toEqual([]);
      expect(h.routes).toEqual([]);
    });
  }

  for (const kind of ['daily_summary', 'weekly_summary'] as const) {
    it(`uses the server's ${kind} and requires its current summary grants`, async () => {
      const { h, app } = setup();
      await answer(h, result(PATIENT_B, kind));
      expect(h.text()).toContain(kind === 'daily_summary' ? 'caregiver.notificationDaily' : 'caregiver.notificationWeekly');
      app.profiles[1].permissions = ['receive_notifications', 'view_schedule'];
      h.render(false);
      expect(h.text()).toContain('caregiver.notificationUnavailable');
      expect(h.text()).not.toContain('SYNTHETIC-B');
    });
  }

  for (const notification of [undefined, {}, { ...result().notification, kind: 'dose_reminder' }, { ...result().notification, patientProfileId: '' }]) {
    it(`rejects an incomplete or unsupported resolver response ${JSON.stringify(notification)}`, async () => {
      const { h, app } = setup();
      await answer(h, { notification } as any);
      expect(h.text()).toContain('caregiver.notificationUnavailable');
      expect(app.refreshProfiles).not.toHaveBeenCalled();
      expect(h.routes).toEqual([]);
    });
  }
});
