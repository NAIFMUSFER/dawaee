import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 10 notification close-out.
 *
 * Dawaee now uses Expo's managed/CNG notification runtime. The generated
 * android/ and ios/ projects are not the source of truth and are intentionally
 * absent from the repository. These assertions therefore audit the durable
 * inputs that EAS/Expo prebuild consumes instead of stale generated native
 * files.
 */

const MOBILE = resolve(import.meta.dirname, '../../mobile');
const read = (path: string) => readFileSync(resolve(MOBILE, path), 'utf8');

describe('phase 10 — managed notification runtime is wired end to end', () => {
  it('declares Expo notification capabilities for both mobile platforms', () => {
    const app = JSON.parse(read('app.json')) as {
      expo: {
        plugins: Array<string | [string, Record<string, unknown>]>;
        android: { permissions?: string[]; blockedPermissions?: string[] };
        ios: { infoPlist?: { UIBackgroundModes?: string[] } };
      };
    };

    const notificationPlugin = app.expo.plugins.find(
      (plugin): plugin is [string, Record<string, unknown>] => Array.isArray(plugin) && plugin[0] === 'expo-notifications',
    );

    expect(notificationPlugin, 'expo-notifications is not configured in app.json').toBeDefined();
    expect(notificationPlugin?.[1]?.defaultChannel).toBe('medication-critical');
    expect(app.expo.android.permissions).toEqual(expect.arrayContaining([
      'POST_NOTIFICATIONS',
      'SCHEDULE_EXACT_ALARM',
      'RECEIVE_BOOT_COMPLETED',
      'VIBRATE',
    ]));
    expect(app.expo.android.permissions).not.toContain('USE_EXACT_ALARM');
    expect(app.expo.android.blockedPermissions).toContain('android.permission.USE_EXACT_ALARM');
    expect(app.expo.ios.infoPlist?.UIBackgroundModes).toContain('remote-notification');
  });

  it('implements local scheduling, high-importance channels and notification actions in Expo source', () => {
    const src = read('src/notifications/index.ts');

    expect(src).toContain("MEDICATION_CHANNEL_ID = 'medication-critical'");
    expect(src).toContain('setNotificationChannelAsync');
    expect(src).toContain('AndroidImportance.MAX');
    expect(src).toContain('setNotificationCategoryAsync');
    expect(src).toContain('scheduleNotificationAsync');
    expect(src).toContain("interruptionLevel: 'timeSensitive'");
    expect(src).toContain('cancelAllScheduledNotificationsAsync');
  });

  it('registers a real Expo push token and binds it to the authenticated device', () => {
    const src = read('src/notifications/index.ts');

    expect(src).toContain('getExpoPushTokenAsync');
    expect(src).toContain("api.post('/v1/devices/push-token'");
    expect(src).toContain('deviceId');
    expect(src).toContain("platform: Platform.OS === 'ios' ? 'ios' : 'android'");
  });

  it('starts channel/category configuration, push registration and action handling from the app shell', () => {
    const layout = read('app/_layout.tsx');

    expect(layout).toContain('configureChannels');
    expect(layout).toContain('configureCategories');
    expect(layout).toContain('syncPushRegistration(deviceId)');
    expect(layout).toContain('startNotificationActionListener');
    expect(layout).toContain("import('expo-notifications')");
  });

  it('does not depend on checked-in generated native projects', () => {
    expect(existsSync(resolve(MOBILE, 'android'))).toBe(false);
    expect(existsSync(resolve(MOBILE, 'ios'))).toBe(false);
    expect(existsSync(resolve(MOBILE, 'src/notifications/index.ts'))).toBe(true);
  });
});
