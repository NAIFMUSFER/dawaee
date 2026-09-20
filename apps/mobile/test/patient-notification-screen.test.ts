import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intents from '../src/notifications/patient-intent.js';

const require = createRequire(import.meta.url);
const { createHarness, NetworkError } = require('./profile-screen-harness.cjs');
const USER = 'synthetic-account';
const SELF = 'own-patient';
const DEPENDENT = 'owned-dependent';
const DOSE = 'synthetic-dose';
const cleanups: Array<() => void> = [];

function setup(locked = false, doseId: string | null = DOSE) {
  intents.setPatientReminderIntent(USER, { doseId });
  const lock = { locked };
  const selections: string[] = [];
  const host: { current: any } = { current: null };
  const app: any = {
    ready: true, signedIn: true, user: { id: USER },
    activeProfile: { id: 'followed-patient', role: 'caregiver' },
    profiles: [
      { id: SELF, isSelf: true, role: 'owner', permissions: null },
      { id: DEPENDENT, isSelf: false, role: 'owner', permissions: null },
      { id: 'followed-patient', isSelf: false, role: 'caregiver', permissions: ['view_schedule', 'view_medications'] },
    ],
    refreshProfiles: vi.fn(async () => { app.profiles = app.profiles.map((profile: any) => ({ ...profile })); if (host.current) host.current.dirty = true; }),
    setActiveProfile: (id: string) => { selections.push(id); app.activeProfile = app.profiles.find((profile: any) => profile.id === id); if (host.current) host.current.dirty = true; },
  };
  const h = createHarness(resolve('apps/mobile/app/notification.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
    '@/state/app-store': { useApp: () => app },
    '@/security/AppLockGate': { useAppLock: () => lock },
    '@/notifications/patient-intent': intents,
  });
  host.current = h;
  cleanups.push(() => h.unmount());
  return { h, app, lock, selections };
}
beforeEach(() => { intents.bindPatientReminderAccount(null); intents.bindPatientReminderAccount(USER); });
afterEach(() => { for (const close of cleanups.splice(0)) close(); intents.bindPatientReminderAccount(null); });

describe('patient reminder target and account/lock boundaries', () => {
  it('resolves an owned dependent instead of opening the currently selected followed patient', async () => {
    const { h, app, selections } = setup();
    expect(h.requests[0].route).toBe(`/v1/doses/${DOSE}`);
    h.requests[0].resolve({ dose: { patientProfileId: DEPENDENT } });
    await h.flush();
    expect(selections).toEqual([DEPENDENT]);
    expect(app.refreshProfiles).toHaveBeenCalledTimes(1);
    expect(h.routes).toEqual(['/(tabs)/today']);
    expect(intents.getPatientReminderIntent()).toBeNull();
    expect(h.queued).toEqual([]);
  });
  it('does not fetch or navigate until the app lock is released', async () => {
    const { h, lock } = setup(true);
    expect(h.requests).toHaveLength(0);
    lock.locked = false; h.render(); await h.flush();
    expect(h.requests).toHaveLength(1);
    h.requests[0].resolve({ dose: { patientProfileId: SELF } });
    await h.flush();
    expect(h.routes).toEqual(['/(tabs)/today']);
  });
  it('does not select a profile removed by the authenticated permission refresh', async () => {
    const { h, app, selections } = setup();
    app.refreshProfiles.mockImplementationOnce(async () => { app.profiles = app.profiles.filter((p: any) => p.id !== DEPENDENT); h.dirty = true; });
    h.requests[0].resolve({ dose: { patientProfileId: DEPENDENT } });
    await h.flush();
    expect(selections).toEqual([]);
    expect(h.routes).toEqual([]);
    expect(h.text()).toContain('error.forbidden');
  });
  it('fences an old-account resolver reply before profile refresh or navigation', async () => {
    const { h, app } = setup();
    intents.bindPatientReminderAccount('other-account');
    app.user = { id: 'other-account' }; h.render(false);
    h.requests[0].resolve({ dose: { patientProfileId: DEPENDENT } });
    await h.flush();
    expect(app.refreshProfiles).not.toHaveBeenCalled();
    expect(h.routes).toEqual([]);
  });
  it('uses a matching own encrypted snapshot when the resolver is offline', async () => {
    const { h, selections } = setup();
    h.cacheReader = async (profileId: string) => ({ profileId, doses: [{ id: DOSE }] });
    h.requests[0].reject(new NetworkError()); await h.flush();
    expect(h.cachedReads).toEqual([SELF]);
    expect(selections).toEqual([SELF]);
    expect(h.routes).toEqual(['/(tabs)/today']);
  });
  it('does not substitute the own patient when its cache lacks the tapped dose', async () => {
    const { h, selections } = setup();
    h.cacheReader = async () => ({ profileId: SELF, doses: [] });
    h.requests[0].reject(new NetworkError()); await h.flush();
    expect(selections).toEqual([]);
    expect(h.routes).toEqual([]);
    expect(h.text()).toContain('notifications.offlineBanner');
  });
  it('handles legacy grouped metadata by selecting the owned self profile', async () => {
    const { h, selections } = setup(false, null);
    await h.flush();
    expect(h.requests).toEqual([]);
    expect(selections).toEqual([SELF]);
    expect(h.routes).toEqual(['/(tabs)/today']);
  });
});
