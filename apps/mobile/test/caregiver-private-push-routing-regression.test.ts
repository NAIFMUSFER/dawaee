import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  startCaregiverNotificationListener,
  type CaregiverNotificationApi,
} from '../src/notifications/caregiver-navigation.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const DELIVERY_ID = '01234567-89ab-4cde-8fab-0123456789ab';

type Listener = (response: unknown) => void;

function response(kind: string, identifier = `notification-${kind}`) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: {
      request: {
        identifier,
        content: { data: { kind, deliveryId: DELIVERY_ID } },
      },
    },
  };
}

function harness() {
  let listener: Listener | null = null;
  let last: unknown = null;
  let opens = 0;
  const native: CaregiverNotificationApi = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    getLastNotificationResponseAsync: async () => last,
    clearLastNotificationResponseAsync: async () => { last = null; },
    addNotificationResponseReceivedListener: (next) => {
      listener = next;
      return { remove: () => { listener = null; } };
    },
  };
  const stop = startCaregiverNotificationListener(native, () => { opens += 1; }, () => true);
  return {
    emit(value: unknown) { last = value; listener?.(value); },
    opens: () => opens,
    stop,
  };
}

describe('private caregiver push routing regression', () => {
  for (const kind of ['escalation', 'daily_summary', 'weekly_summary']) {
    it(`handles a live ${kind} default tap`, () => {
      const h = harness();
      h.emit(response(kind));
      expect(h.opens()).toBe(1);
      h.stop();
    });
  }

  it('uses a dedicated neutral caregiver landing rather than the current Family profile', () => {
    const shell = source('apps/mobile/app/_layout.tsx');
    expect(shell).toContain("router.replace('/caregiver/notification')");
    expect(shell).not.toContain("router.replace('/(tabs)/family')");
  });

  it('the notification landing asks for a followed profile before opening clinical dashboard data', () => {
    const landing = source('apps/mobile/app/caregiver/notification.tsx');
    expect(landing).toContain("profiles.filter((profile) => profile.role === 'caregiver')");
    expect(landing).toContain('setActiveProfile(profile.id)');
    expect(landing).toContain("router.replace('/caregiver/dashboard')");
    expect(landing).not.toMatch(/\bapi\./);
    expect(landing).not.toMatch(/profileId=.*\$\{/);
  });

  it('documents why the previous Family route was not a neutral landing', () => {
    const store = source('apps/mobile/src/state/app-store.tsx');
    const family = source('apps/mobile/app/(tabs)/family.tsx');
    expect(store).toMatch(/profilesRes\.profiles\.find\(\(p\) => p\.isSelf\)/);
    expect(family).toContain("api.get<CareCircleResponse>('/v1/care-circle', { profileId: activeProfile.id })");
  });
});
