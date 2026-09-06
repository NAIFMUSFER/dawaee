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

/**
 * The grace window is a security policy with named exceptions, so each
 * exception is asserted rather than described. Every case below references
 * RELOCK_GRACE_MS rather than the literal, so changing the policy fails
 * exactly the cases the change affects.
 */
describe('the re-lock grace window applies where policy says and nowhere else', () => {
  it('is granted only to a background round trip shorter than the window', () => {
    let s = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 0 });
    s = lockReducer(s, { type: 'appStatus', status: 'active', now: RELOCK_GRACE_MS - 1 });
    expect(s.phase).toBe('unlocked');
  });

  it('expires exactly at the window, not a millisecond later', () => {
    let s = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 0 });
    s = lockReducer(s, { type: 'appStatus', status: 'active', now: RELOCK_GRACE_MS });
    expect(s.phase).toBe('locked');
  });

  /**
   * A launch enters through `configure`, never through `appStatus`. However
   * recently the app was last open, a fresh process is locked with no window —
   * the case where the phone has been taken and relaunched.
   */
  it('gives a cold start no grace at all', () => {
    const s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    expect(s.phase).toBe('locked');
    expect(s.backgroundedAt).toBeNull();
    // And a subsequent 'active' — which is what a launch reports — must not
    // find a window to honour.
    expect(lockReducer(s, { type: 'appStatus', status: 'active', now: 1 }).phase).toBe('locked');
  });

  it('gives no grace when the lock is switched on', () => {
    const on = lockReducer(unlocked(), { type: 'configure', enabled: false });
    const s = lockReducer(on, { type: 'configure', enabled: true });
    expect(s.phase).toBe('locked');
  });

  /**
   * A manual device lock reaches the app as a plain `background` — neither
   * platform distinguishes it through AppState — so it receives the same
   * window. Asserted rather than left implicit, because it is an accepted risk
   * and a reader should find it stated, not infer it: getting back within the
   * window requires passing the phone's own lock screen first.
   */
  it('treats a manual device lock like any other background, by documented policy', () => {
    let s = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 0 });
    expect(s.phase).toBe('covered');
    s = lockReducer(s, { type: 'appStatus', status: 'active', now: RELOCK_GRACE_MS + 1 });
    expect(s.phase).toBe('locked');
  });

  it('keeps the window a single named constant rather than a literal', () => {
    const src = readFileSync(join(ROOT, 'apps/mobile/src/security/lock-state.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function lockReducer'));
    expect(body).toContain('RELOCK_GRACE_MS');
    expect(body).not.toMatch(/10_000|10000/);
  });
});

describe('nobody can be trapped behind it, and nothing weaker than a password gets out', () => {
  /**
   * Preferences live on the server, so a patient whose sensor has failed would
   * sign out, sign back in with their password, and be locked out again by the
   * setting they were trying to escape — permanently unable to open their own
   * medication schedule from a phone that works. A password is a stronger
   * factor than a device biometric.
   */
  it('lets a freshly verified password through', () => {
    let s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    expect(s.phase).toBe('locked');
    s = lockReducer(s, { type: 'credentialVerified' });
    expect(s.phase).toBe('unlocked');
  });

  /**
   * The bypass this whole item exists to rule out, and it was real: the first
   * implementation dispatched the escape on the `signedIn` flag. `signedIn`
   * also flips false → true during the cold-start bootstrap, when a refresh
   * token read from storage is exchanged for a session with nobody present —
   * so the lock cleared itself on every launch and enforced nothing.
   *
   * The reducer has no event a restored session could dispatch. This asserts
   * the wiring that guarantees it: the gate must key off `credentialVerifiedAt`
   * and must not key off `signedIn`, and the store must set that value in
   * exactly one place — after the server accepted a password.
   */
  it('cannot be opened by a session restored from storage', () => {
    const gate = readFileSync(join(ROOT, 'apps/mobile/src/security/AppLockGate.tsx'), 'utf8');

    expect(gate, 'the escape keys off a fresh credential').toContain(
      "dispatch({ type: 'credentialVerified' })",
    );
    // The dispatch must be guarded by the credential timestamp, never by the
    // session flag.
    const guard = gate.slice(
      gate.indexOf('const seenCredential'),
      gate.indexOf("dispatch({ type: 'credentialVerified' })"),
    );
    expect(guard).toContain('credentialVerifiedAt');
    expect(guard, 'the session flag must not gate the escape').not.toContain('signedIn');
  });

  it('marks a fresh credential in exactly one place, and that place is a password sign-in', () => {
    const store = readFileSync(join(ROOT, 'apps/mobile/src/state/app-store.tsx'), 'utf8');
    const sets = [...store.matchAll(/credentialVerifiedAt:\s*Date\.now\(\)/g)];
    expect(sets, 'exactly one assignment of a real timestamp').toHaveLength(1);

    // ...and it sits inside signInWithTokens, which both auth screens call
    // immediately after the server accepted a password.
    const start = store.indexOf('signInWithTokens: async');
    const end = store.indexOf('signOut: async');
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start, end);
    expect(body).toContain('credentialVerifiedAt: Date.now()');

    // The bootstrap that restores a stored session must not set it.
    const bootstrap = store.slice(store.indexOf('const hasSession = await loadStoredSession'), start);
    expect(bootstrap).not.toContain('credentialVerifiedAt');
  });

  it('is called only from the two screens that post a password', () => {
    for (const screen of ['sign-in', 'sign-up']) {
      const src = readFileSync(join(ROOT, `apps/mobile/app/(auth)/${screen}.tsx`), 'utf8');
      const call = src.indexOf('signInWithTokens(tokens)');
      expect(call, `${screen} calls it`).toBeGreaterThan(-1);
      // The tokens it passes came from an auth POST in the same function.
      expect(src.slice(0, call)).toMatch(/api\.anonymous\.post<AuthTokens>\('\/v1\/auth\/(login|register)'/);
    }
  });

  it('drops the lock entirely when the patient turns it off', () => {
    let s = lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true });
    s = lockReducer(s, { type: 'configure', enabled: false });
    expect(s).toEqual(INITIAL_LOCK_STATE);
  });
});

/**
 * The emergency card route used to be exempt from the lock. Auditing what it
 * renders ended that: with the patient's flags on it displays their name,
 * allergies, blood type, the free-text conditions note, every active
 * medication with its strength, and each emergency contact's name, relation
 * and phone number — PHI and PII on a route that asks for no authorization.
 */
describe('no route is exempt, least of all the one that renders PHI', () => {
  it('exempts nothing', () => {
    for (const p of ['/e/abc123', '/e', '/today', '/settings/emergency', '/reports/adherence']) {
      expect(isLockExemptPath(p), p).toBe(false);
    }
  });

  it('the gate holds no second exemption of its own', () => {
    const gate = readFileSync(join(ROOT, 'apps/mobile/src/security/AppLockGate.tsx'), 'utf8');
    // One call site, one source of truth. A new `pathname === '/x'` branch in
    // the gate is how an exemption comes back without anyone noticing.
    expect([...gate.matchAll(/isLockExemptPath\(/g)], 'exactly one call site').toHaveLength(1);
    expect(gate).not.toMatch(/pathname\s*===\s*'/);
    expect(gate).not.toMatch(/pathname\?*\.?startsWith\(/);
  });

  /**
   * The disclosure this route can make, pinned so that widening it is a test
   * failure rather than a quiet change. Every one of these fields reaches the
   * screen with no authenticated authorization; the only gate is the patient's
   * own per-field include flags, which default to false.
   */
  it('still renders each PHI field it was audited for, so the finding stays true', () => {
    const screen = readFileSync(join(ROOT, 'apps/mobile/app/e/[token].tsx'), 'utf8');
    for (const field of [
      'patientName', 'allergies', 'bloodType', 'conditionsNote', 'medications',
      'emergencyContacts', 'phoneE164',
    ]) {
      expect(screen, `renders ${field}`).toContain(field);
    }
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
