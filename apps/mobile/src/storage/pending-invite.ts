import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * A caregiver invitation waiting for the recipient to sign in.
 *
 * Opening an invitation link is almost always the first time this person has
 * touched the app, so the token has to survive a detour through sign-up. It
 * was already being stashed — and nothing ever read it back on the way out:
 * the recipient signed in, landed on Today, and the invitation sat in storage
 * forever. The care circle could not be formed, which means every escalation
 * past the patient had nobody to reach.
 *
 * Kept here rather than inside the accept screen so the auth screens can ask
 * "is someone waiting to be let in?" without importing a caregiver screen.
 */
const KEY = 'dawaee.pendingInvitationToken';

/**
 * Tokens this app process has already tried to redeem.
 *
 * Module scope, not component state, and deliberately so. The accept screen is
 * mounted twice during the invitation flow — once before the sign-in detour,
 * once after the return — and BOTH instances become eligible the moment
 * `signedIn` flips. A guard held inside the component gives each instance its
 * own, so both fired: an invitation is single-use, the first call burned the
 * token, the second got "invitation not found", and the caregiver was shown
 * "this invitation link is not valid" for one they had just accepted. They
 * would have asked the patient to send another, which would fail the same way.
 */
const attempted = new Set<string>();

/**
 * Take the token for one redemption attempt, or null if something already has.
 *
 * Claiming is what makes this safe rather than merely reading — two callers
 * racing here get one token between them.
 */
export function claimInviteAttempt(token: string): boolean {
  if (attempted.has(token)) return false;
  attempted.add(token);
  return true;
}

export async function stashPendingInvite(token: string): Promise<void> {
  await AsyncStorage.setItem(KEY, token).catch(() => undefined);
}

/** The waiting token, if any. Does not consume it. */
export async function peekPendingInvite(): Promise<string | null> {
  return AsyncStorage.getItem(KEY).catch(() => null);
}

/**
 * Forget it.
 *
 * Called once the invitation has been accepted, and also when it is refused
 * or expired — a token that cannot be used again must not follow someone
 * around, sending them back to the same dead end after every sign-in.
 */
export async function clearPendingInvite(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
}

/**
 * Where to go after signing in.
 *
 * The invitation wins over the normal landing screen: this person opened a
 * link to be let into someone's care circle, and finishing that is what they
 * came for.
 */
export async function landingAfterAuth(): Promise<'/caregiver/accept' | '/(tabs)/today'> {
  return (await peekPendingInvite()) ? '/caregiver/accept' : '/(tabs)/today';
}
