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
   * A password was presented to the server and accepted, just now.
   *
   * This is the recovery path, and it is the reason the lock cannot trap
   * anyone: a fingerprint that has stopped being recognised, or a sensor that
   * has failed, would otherwise leave a patient permanently unable to reach
   * their own medication schedule from a device that is working fine. A
   * password is a stronger factor than the device biometric, so presenting one
   * clears the lock for this session.
   *
   * Named for the credential, not the session, because the first draft of this
   * fired on the `signedIn` flag instead — and `signedIn` also becomes true
   * when a refresh token read from storage is exchanged for a session at cold
   * start, with nobody present. That version cleared the lock on every launch
   * and enforced nothing. A stored session, a cached credential, a token
   * refresh and a route change must all be insufficient; only a fresh
   * verification may dispatch this.
   */
  | { type: 'credentialVerified' };

export const INITIAL_LOCK_STATE: LockState = {
  enabled: false,
  phase: 'unlocked',
  pendingRelock: false,
  backgroundedAt: null,
  verifiedAreas: [],
};

/**
 * RE-LOCK GRACE WINDOW — a security policy, not a tuning constant.
 *
 * How long a trip out of the foreground may last before the lock re-engages.
 * Every number and exception below is deliberate; change this only as a policy
 * decision, and the tests reference this constant rather than the literal so a
 * change shows up as failures in the cases it actually affects.
 *
 * WHY TEN SECONDS. Not zero, and the reason is specific rather than a
 * convenience: photographing a medication box for OCR hands control to the
 * system camera or gallery, which backgrounds Dawaee on Android. With no grace
 * the patient returns holding the photo and must verify again before the
 * picker's result is processed, every single time — which is the friction that
 * makes people switch the lock off, and a lock that gets switched off protects
 * nothing. Ten seconds covers a returning picker and an accidental swipe. It is
 * far shorter than any plausible "I put my phone down and walked away", and
 * short enough that it does not meaningfully extend the window the device's own
 * screen lock already governs.
 *
 * WHAT RECEIVES GRACE. Exactly one transition: foreground → `background` →
 * foreground, where the round trip took less than this. Nothing else.
 *
 * WHAT DOES NOT.
 *  - Cold start. A launch enters through `configure`, never through
 *    `appStatus`, so a freshly started process is locked with no window at all,
 *    however recently the app was last open. Pinned by test.
 *  - Enabling the lock. Same path, same result: locked immediately.
 *  - `inactive`. It covers the screen but never arms a re-lock, so there is no
 *    window to grant — see the `appStatus` branch for why arming there would
 *    make the lock impossible to open.
 *  - Anything longer than the window, however the app got there.
 *
 * MANUAL DEVICE LOCK. Pressing the power button reaches the app as a plain
 * `background`, and neither iOS nor Android distinguishes it from an app switch
 * through React Native's `AppState`. So a device lock DOES receive the grace,
 * and this is an accepted, bounded risk rather than an oversight: returning to
 * Dawaee within those ten seconds requires getting past the phone's own lock
 * screen first, which is a stronger control than the one being waived. The
 * exposure is therefore limited to a device whose OS lock is disabled or set to
 * a delay — a device on which the medication data was already reachable by
 * anyone holding it.
 *
 * CONFIGURABLE? Not by the patient, deliberately. A visible "lock after…"
 * setting is a control people set to five minutes once and never revisit, which
 * converts a lock into a formality; and the OCR case it exists for is fixed, so
 * there is nothing for a user to tune. It is a named export so that changing
 * the policy is one line in one file, and so a future operator- or
 * enterprise-level policy can override it in one place rather than fifteen.
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
      // The grace window is valid only for a forward-moving wall clock. If the
      // device clock moves backwards while Dawaee is backgrounded, the elapsed
      // duration is unknowable; fail closed rather than treating a negative
      // duration as "less than ten seconds" and silently bypassing re-lock.
      if (away >= 0 && away < RELOCK_GRACE_MS) {
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

    case 'credentialVerified':
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
 * There are no exempt routes. Not one.
 *
 * An earlier draft exempted `/e/<token>`, the paramedic view of the emergency
 * card, reasoning that it exists to be read while the owner cannot verify
 * anything. Auditing what that screen actually renders killed the idea: with
 * the patient's flags on it displays their name, their allergies, their blood
 * type, the free-text conditions note, every active medication with its
 * strength, and each emergency contact's name, relation and phone number —
 * PHI and PII, on a route that asks for no authorization at all.
 *
 * The exemption also turned out to buy nothing. `enabled` requires a signed-in
 * session, and a paramedic scanning the QR opens the card on THEIR device or
 * in a browser, where nobody is signed in and the lock therefore never
 * engages. The only situation the exemption served was a paramedic using the
 * patient's own phone, already signed in as the patient — and to reach the app
 * at all they would first have to be past the phone's own lock screen.
 *
 * So the exemption protected no real flow and left a PHI-rendering route
 * reachable on a locked device. This function is kept, returning false for
 * everything, so that adding an exemption later is a deliberate edit to a
 * documented decision rather than a quiet new branch somewhere in the gate.
 */
export function isLockExemptPath(_pathname: string): boolean {
  return false;
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
