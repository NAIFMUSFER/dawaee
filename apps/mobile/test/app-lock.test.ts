import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  areaForPath,
  areaNeedsVerification,
  INITIAL_LOCK_STATE,
  isLockExemptPath,
  lockReducer,
  RELOCK_GRACE_MS,
} from '../src/security/lock-state.js';
import type { LockState } from '../src/security/lock-state.js';

/**
 * The app lock, which reported itself as ON while enforcing nothing.
 *
 * `appLockEnabled` was written by the settings screen, read back by the
 * settings screen to render "On", and consulted by no other code in the app —
 * so a patient who turned it on was told their medication history, caregivers,
 * emergency card and reports were protected while anyone holding the unlocked
 * phone could read all of it. These tests pin the rule that now decides it.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

/** A state that has settled into "on, and verified". */
const unlocked = (): LockState =>
  lockReducer(
    lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true }),
    { type: 'verified' },
  );

describe('the lock engages without being asked to', () => {
  it('starts locked the moment it is enabled, not after the first frame', () => {
    const s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    expect(s.phase).toBe('locked');
  });

  it('stays unlocked when the patient has not turned it on', () => {
    const s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: false });
    expect(s.phase).toBe('unlocked');
  });

  it('opens only after the operating system says yes', () => {
    let s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    expect(s.phase).toBe('locked');
    s = lockReducer(s, { type: 'verified' });
    expect(s.phase).toBe('unlocked');
  });
});

describe('leaving the foreground', () => {
  /**
   * The task-switcher snapshot. iOS photographs the app as it leaves the
   * foreground and Android does the same for Recents; without a cover, the
   * thumbnail shows today's doses to anyone who opens the switcher.
   */
  it('covers the content before the app is photographed', () => {
    const s = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 1_000 });
    expect(s.phase).toBe('covered');
  });

  it('re-locks on return once the grace window has passed', () => {
    let s = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 0 });
    s = lockReducer(s, { type: 'appStatus', status: 'active', now: RELOCK_GRACE_MS + 1 });
    expect(s.phase).toBe('locked');
  });

  /**
   * Photographing a medication box for OCR hands control to the system camera,
   * which backgrounds the app. Re-locking on every one of those is the friction
   * that makes people switch the lock off entirely.
   */
  it('does not re-lock for a trip shorter than the grace window', () => {
    let s = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 0 });
    s = lockReducer(s, { type: 'appStatus', status: 'active', now: RELOCK_GRACE_MS - 1 });
    expect(s.phase).toBe('unlocked');
  });

  /**
   * The one that would have made the lock impossible to open: iOS reports
   * `inactive` while its own biometric dialog is up. Arming a re-lock there
   * would re-lock the app underneath the prompt that was about to unlock it,
   * and no sequence of taps would ever get in.
   */
  it('does not arm a re-lock for the biometric prompt itself', () => {
    let s = unlocked();
    s = lockReducer(s, { type: 'appStatus', status: 'inactive', now: 0 });
    expect(s.phase).toBe('covered');
    s = lockReducer(s, { type: 'appStatus', status: 'active', now: 60_000 });
    expect(s.phase).toBe('unlocked');
  });

  it('keeps a locked app locked through an inactive blip', () => {
    let s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    s = lockReducer(s, { type: 'appStatus', status: 'inactive', now: 0 });
    expect(s.phase).toBe('locked');
  });

  it('forgets area verifications when the app leaves the foreground', () => {
    let s = lockReducer(unlocked(), { type: 'areaVerified', area: 'reports' });
    expect(s.verifiedAreas).toContain('reports');
    s = lockReducer(s, { type: 'appStatus', status: 'background', now: 0 });
    expect(s.verifiedAreas).toEqual([]);
  });
});

describe('nobody can be trapped behind it', () => {
  /**
   * Preferences live on the server, so a patient whose sensor has failed would
   * sign out, sign back in with their password, and be locked out again by the
   * setting they were trying to escape — permanently unable to open their own
   * medication schedule from a phone that works. A password is a stronger
   * factor than a device biometric.
   */
  it('lets a password sign-in through', () => {
    let s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    expect(s.phase).toBe('locked');
    s = lockReducer(s, { type: 'signedIn' });
    expect(s.phase).toBe('unlocked');
  });

  it('drops the lock entirely when the patient turns it off', () => {
    let s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    s = lockReducer(s, { type: 'configure', enabled: false });
    expect(s).toEqual(INITIAL_LOCK_STATE);
  });

  /**
   * The paramedic view exists to be read while the owner cannot verify
   * anything. Gating it behind the owner's fingerprint removes its only
   * purpose, and discloses nothing the scanned URL does not already disclose.
   */
  it('never covers the emergency card', () => {
    expect(isLockExemptPath('/e/abc123')).toBe(true);
    expect(isLockExemptPath('/today')).toBe(false);
    expect(isLockExemptPath('/settings/emergency')).toBe(false);
  });
});

describe('the protected areas the settings screen offers are the ones enforced', () => {
  const AREAS = ['history', 'caregivers', 'personal', 'reports', 'emergency'] as const;

  it('offers exactly the five areas the settings screen lists', () => {
    const screen = readFileSync(join(ROOT, 'apps/mobile/app/settings/app-lock.tsx'), 'utf8');
    const listed = screen.match(/const LOCK_AREAS = \[([^\]]*)\]/)?.[1] ?? '';
    for (const area of AREAS) {
      expect(listed, `settings offers ${area}`).toContain(`'${area}'`);
    }
  });

  it('resolves each area from a real route', () => {
    expect(areaForPath('/history')).toBe('history');
    expect(areaForPath('/family')).toBe('caregivers');
    expect(areaForPath('/caregiver/dashboard')).toBe('caregivers');
    expect(areaForPath('/reports/adherence')).toBe('reports');
    expect(areaForPath('/settings/emergency')).toBe('emergency');
    expect(areaForPath('/settings/emergency-qr')).toBe('emergency');
    expect(areaForPath('/settings/privacy')).toBe('personal');
  });

  it('reaches every area the settings screen can tick', () => {
    const reachable = new Set(
      ['/history', '/family', '/caregiver/dashboard', '/reports/adherence',
        '/settings/emergency', '/settings/privacy'].map(areaForPath),
    );
    for (const area of AREAS) expect(reachable, area).toContain(area);
  });

  it('leaves ordinary screens alone', () => {
    expect(areaForPath('/today')).toBeNull();
    expect(areaForPath('/medications')).toBeNull();
    expect(areaForPath('/settings')).toBeNull();
  });

  it('asks only for the areas the patient chose', () => {
    const s = unlocked();
    expect(areaNeedsVerification(s, ['reports'], 'reports')).toBe(true);
    expect(areaNeedsVerification(s, ['reports'], 'history')).toBe(false);
  });

  it('does not ask twice in the same foreground session', () => {
    let s = unlocked();
    expect(areaNeedsVerification(s, ['reports'], 'reports')).toBe(true);
    s = lockReducer(s, { type: 'areaVerified', area: 'reports' });
    expect(areaNeedsVerification(s, ['reports'], 'reports')).toBe(false);
  });

  it('asks nothing at all when the lock is off', () => {
    expect(areaNeedsVerification(INITIAL_LOCK_STATE, ['reports'], 'reports')).toBe(false);
  });
});

/**
 * The structural half. A rule that is correct but not wired to anything is the
 * defect this whole change exists to fix, so the wiring is asserted too.
 */
describe('the rule is actually wired to the app', () => {
  const layout = readFileSync(join(ROOT, 'apps/mobile/app/_layout.tsx'), 'utf8');

  it('wraps the router, so no deep link or notification can route around it', () => {
    expect(layout).toContain('<AppLockGate>');
    const gate = layout.indexOf('<AppLockGate>');
    const stack = layout.indexOf('<Stack');
    expect(gate, 'the gate is outside the Stack').toBeGreaterThan(-1);
    expect(stack).toBeGreaterThan(gate);
  });

  it('loads biometrics through the single shared module, not a private copy', () => {
    const screen = readFileSync(join(ROOT, 'apps/mobile/app/settings/app-lock.tsx'), 'utf8');
    expect(screen).toContain("from '@/security/local-auth'");
    expect(screen).not.toContain("require('expo-local-authentication')");
  });
});
