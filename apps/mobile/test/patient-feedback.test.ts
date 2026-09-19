import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPatientReport } from '../src/privacy/patient-report.js';
import { notificationPermissionGranted } from '../src/notifications/permission.js';
import { phoneProofErrorKey } from '../src/security/phone-proof-errors.js';

const require = createRequire(import.meta.url);
const { createHarness, deferred } = require('./profile-screen-harness.cjs');
const hook = resolve('apps/mobile/src/hooks/useRequestScope.ts');

describe('iOS notification permission feedback', () => {
  it('uses iOS authorization including provisional and ephemeral grants', () => {
    for (const status of [2, 3, 4]) expect(notificationPermissionGranted({ granted: false, ios: { status } })).toBe(true);
    for (const status of [0, 1]) expect(notificationPermissionGranted({ granted: true, ios: { status } })).toBe(false);
    expect(notificationPermissionGranted({ granted: true })).toBe(true);
    expect(notificationPermissionGranted({ status: 'denied' })).toBe(false);
  });

  it('clears the Today warning after returning from iOS settings and ignores an older read', async () => {
    const reads: any[] = [];
    const h = createHarness(resolve('apps/mobile/app/(tabs)/today.tsx'), hook, {}, {
      '@/notifications': {
        inspectCapability: () => { const d = deferred(); reads.push(d); return d.promise; },
        captureLocalReminderContext: () => () => true,
        rescheduleLocalNotifications: async () => ({ scheduled: 0, failed: 0 }),
      },
    });
    try {
      h.answer(h.batch(), 'A');
      reads[0].resolve({ supported: true, permissionGranted: false }); await h.flush();
      expect(h.text()).toContain('notifications.disabledTitle');
      h.changeAppState('active'); h.changeAppState('active');
      reads[2].resolve({ supported: true, permissionGranted: true }); await h.flush();
      reads[1].resolve({ supported: true, permissionGranted: false }); await h.flush();
      expect(h.text()).not.toContain('notifications.disabledTitle');
    } finally { h.unmount(); }
  });
});

describe('phone verification error feedback', () => {
  it('does not confuse a failed account lookup with an account having no phone', async () => {
    const h = createHarness(resolve('apps/mobile/src/components/PhoneVerification.tsx'), hook, {}, {
      '@/security/phone-proof': { phoneVerificationSupported: true },
    });
    try {
      h.requests[0].reject(new Error('unavailable')); await h.flush();
      expect(h.text()).toContain('phoneVerification.loadError');
      expect(h.text()).not.toContain('phoneVerification.noPhone');
      expect(h.find('Button', (p: any) => p.label === 'common.retry')).toBeTruthy();
    } finally { h.unmount(); }
  });
  it('distinguishes setup, connectivity, rate limits and invalid codes without provider payloads', () => {
    expect(phoneProofErrorKey({ code: 'auth/invalid-app-credential', message: 'PRIVATE' })).toBe('phoneVerification.serviceUnavailable');
    expect(phoneProofErrorKey({ code: 'auth/network-request-failed' })).toBe('notifications.offlineBanner');
    expect(phoneProofErrorKey({ code: 'auth/too-many-requests' })).toBe('phoneVerification.rateLimited');
    expect(phoneProofErrorKey({ code: 'auth/invalid-verification-code' })).toBe('phoneVerification.codeError');
  });
});

describe('readable patient report', () => {
  it('renders factual Arabic schedules, preserves zero and escapes patient HTML', () => {
    const report = buildPatientReport({ exportedAt: '2026-09-18T01:00:00Z', data: {
      profile: [{ display_name: '<script>private</script>', timezone: 'Asia/Riyadh' }],
      medications: [{ id: 'm', name: 'Panadol', form: 'tablet', status: 'active', strength_value: 500, strength_unit: 'mg' }],
      schedules: [
        { medication_id: 'm', dose_quantity: 1, dose_unit: 'tablet', rule: { kind: 'days_of_week', weekdays: [0], times: ['08:00'] } },
        { medication_id: 'm', rule: { kind: 'cycle', daysOn: 3, daysOff: 2, times: ['09:00'], cycleAnchorDate: '2026-09-18' } },
        { medication_id: 'm', rule: { kind: 'as_needed', maxPerDay: 4, minHoursBetween: 6 } },
      ],
      stock: [{ medication_id: 'm', remaining_quantity: 0, unit: 'tablet' }],
      emergencyCard: [{ allergies: ['<img src=x onerror=alert(1)>'], qr_token_hash: 'NEVER-PUBLISH' }],
      auditLog: [{ token: 'NEVER-PUBLISH' }],
    } }, 'ar');
    expect(report.html).toContain('dir="rtl"');
    expect(report.html).toContain('&lt;script&gt;');
    expect(report.html).not.toContain('<script>');
    expect(report.html).not.toContain('<img');
    expect(report.text).toContain('الأحد');
    expect(report.text).toContain('3 أيام تناول / 2 أيام توقف');
    expect(report.text).toContain('الحد اليومي: 4');
    expect(report.text).toContain('0 قرص');
    expect(report.text).not.toContain('NEVER-PUBLISH');
    expect(report.text).not.toContain('medication_id');
  });
});
