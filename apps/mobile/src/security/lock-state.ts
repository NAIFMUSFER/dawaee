/**
 * When the app lock is showing, and why.
 *
 * This is deliberately a pure reducer with no React and no React Native in it.
 * The lock is the only thing standing between someone holding an unlocked
 * phone and a patient's full medication history, so the rule that decides
 * "locked or not" has to be readable in one place and testable without a
 * device — the previous implementation had no rule at all: `appLockEnabled`
 * was written by the settings screen, read back by the settings screen to
 * display "On", and enforced by nothing anywhere in the app.
 *
 * Three phases rather than two, because hiding content is not only about the
 * unlock prompt:
 *
 *   unlocked — content visible.
 *   locked   — the unlock screen, after a cold start or a return from
 *              background.
 *   covered  — an opaque shield with no unlock affordance, shown while the app
 *              is leaving the foreground. iOS photographs the app for the task
 *              switcher at exactly that moment, and Android does the same for
 *              Recents; without this the switcher thumbnail shows today's
 *              doses to anyone who double-taps the home button on a locked
 *              phone. It is a separate phase because it must NOT offer an
 *              unlock button — nobody is there to press it, and drawing one
 *              into the snapshot is how you end up with a screenshot of a
 *              half-rendered lock screen.
 */
export type LockPhase = 'unlocked' | 'locked' | 'covered';

/** The OS-reported foreground state, narrowed to what the rule cares about. */
export type AppStatus = 'active' | 'inactive' | 'background';

export interface LockState {
  /** The lock is configured on AND there is a session worth protecting. */
  enabled: boolean;
  phase: LockPhase;
  /** Set when the app truly left the foreground; cleared by a verification. */
  pendingRelock: boolean;
  /** When the app went to background, epoch ms; null if it has not. */
  backgroundedAt: number | null;
  /** Areas verified since the last background, e.g. 'reports'. */
  verifiedAreas: readonly string[];
}

export type LockEvent =
  /** Preferences or session changed. `enabled` is (appLockEnabled && signedIn). */
  | { type: 'configure'; enabled: boolean }
  | { type: 'appStatus'; status: AppStatus; now: number }
  /** The OS said yes to a whole-app verification. */
  | { type: 'verified' }
  /** The OS said yes to an area verification. */
  | { type: 'areaVerified'; area: string }
  /**
   * A password sign-in completed. This is the recovery path, and it is the
   * reason the lock cannot trap anyone: a fingerprint that has stopped being
   * recognised, or a sensor that has failed, would otherwise leave a patient
   * permanently unable to reach their own medication schedule from a device
   * that is working fine. A password is a stronger factor than the device
   * biometric, so presenting one clears the lock for this session.
   */
  | { type: 'signedIn' };

export const INITIAL_LOCK_STATE: LockState = {
  enabled: false,
  phase: 'unlocked',
  pendingRelock: false,
  backgroundedAt: null,
  verifiedAreas: [],
};

/**
 * How long a trip out of the foreground may last before the lock re-engages.
 *
 * Not zero, and the reason is specific rather than a convenience: taking a
 * photo of a medication box for OCR hands control to the system camera or
 * gallery, which backgrounds Dawaee on Android. With no grace window the
 * patient returns holding the photo and is asked to verify again before the
 * picker's result can be processed, every single time — which is exactly the
 * friction that makes people turn the lock off.
 *
 * Ten seconds is short enough that the phone's own screen lock, which engages
 * on a far longer timer, is not the only thing covering this window, and long
 * enough for a returning picker. The residual risk is stated plainly in the
 * remediation notes: someone who takes the phone within ten seconds of it
 * being put down, while it is still unlocked at the OS level, gets in.
 */
export const RELOCK_GRACE_MS = 10_000;

export function lockReducer(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case 'configure': {
      if (event.enabled === state.enabled) return state;
      // Turning the lock ON — including the first render after preferences
      // arrive from storage — starts locked. A cold start must never show a
      // dose before the verification: deriving the phase here, rather than in
      // an effect that runs after the first paint, is what makes that true.
      if (event.enabled) {
        return { ...state, enabled: true, phase: 'locked', pendingRelock: true, verifiedAreas: [] };
      }
      return { ...INITIAL_LOCK_STATE };
    }

    case 'appStatus': {
      if (!state.enabled) return state;
      if (event.status === 'background') {
        // The only transition that arms a re-lock. `inactive` deliberately does
        // not: iOS fires it for a notification banner, a control-centre pull,
        // and — the one that matters — for the biometric prompt itself. Arming
        // on `inactive` would re-lock the app underneath its own unlock dialog,
        // and no sequence of taps would ever get in.
        return {
          ...state,
          phase: 'covered',
          pendingRelock: true,
          backgroundedAt: event.now,
          verifiedAreas: [],
        };
      }
      if (event.status === 'inactive') {
        // Cover, but do not arm. If already locked, stay locked.
        return state.phase === 'unlocked' ? { ...state, phase: 'covered' } : state;
      }
      // active
      if (!state.pendingRelock) return { ...state, phase: 'unlocked' };
      const away = state.backgroundedAt === null ? Infinity : event.now - state.backgroundedAt;
      if (away < RELOCK_GRACE_MS) {
        return { ...state, phase: 'unlocked', pendingRelock: false, backgroundedAt: null };
      }
      return { ...state, phase: 'locked', backgroundedAt: null };
    }

    case 'verified':
      if (!state.enabled) return state;
      return { ...state, phase: 'unlocked', pendingRelock: false, backgroundedAt: null };

    case 'areaVerified':
      if (!state.enabled) return state;
      if (state.verifiedAreas.includes(event.area)) return state;
      return { ...state, verifiedAreas: [...state.verifiedAreas, event.area] };

    case 'signedIn':
      return { ...state, phase: 'unlocked', pendingRelock: false, backgroundedAt: null };

    default:
      return state;
  }
}

/**
 * Does this screen need its own verification right now?
 *
 * The settings screen offers per-area locks and promised "verification is asked
 * before opening these areas only". Nothing asked. This is the predicate the
 * gate uses, kept next to the reducer so both halves of the feature are
 * decided by the same file.
 */
export function areaNeedsVerification(state: LockState, areas: readonly string[], area: string): boolean {
  if (!state.enabled) return false;
  if (!areas.includes(area)) return false;
  return !state.verifiedAreas.includes(area);
}

/**
 * Routes that are never covered by the lock.
 *
 * `/e/<token>` is the paramedic view of the emergency card. It is anonymous by
 * design, reachable by anyone holding the scanned URL on any device, and shows
 * only the fields the patient explicitly published. Gating it behind the
 * owner's fingerprint removes its entire purpose — it exists to be read while
 * the owner cannot verify anything — and discloses nothing that the URL alone
 * does not already disclose to a browser.
 */
export function isLockExemptPath(pathname: string): boolean {
  return pathname === '/e' || pathname.startsWith('/e/');
}

/**
 * Which protected area a route belongs to, or null.
 *
 * Resolved centrally from the path rather than declared by each screen, and
 * that is the whole point: a per-screen `useAreaLock()` is a control that
 * fifteen files have to remember, and the sixteenth screen someone adds is a
 * hole nobody notices. Route groups are stripped by expo-router's
 * `usePathname`, so `/(tabs)/history` arrives here as `/history`.
 *
 * The names match the five keys the settings screen offers, so what the
 * patient ticks is what actually gets gated.
 */
const AREA_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['history', /^\/history(\/|$)/],
  ['caregivers', /^\/(family|caregiver)(\/|$)/],
  ['reports', /^\/reports(\/|$)/],
  ['emergency', /^\/settings\/emergency(-qr)?(\/|$)/],
  ['personal', /^\/settings\/privacy(\/|$)/],
];

export function areaForPath(pathname: string): string | null {
  for (const [area, pattern] of AREA_ROUTES) {
    if (pattern.test(pathname)) return area;
  }
  return null;
}
