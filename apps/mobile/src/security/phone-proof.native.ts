import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getApp, initializeApp, deleteApp } from '@react-native-firebase/app';
import { getAuth, getIdToken, onAuthStateChanged, signInWithPhoneNumber, signOut } from '@react-native-firebase/auth';

export interface PhoneChallenge {
  confirm: (code: string) => Promise<void>;
  cancel: () => void;
}
export const phoneVerificationSupported =
  (Platform.OS === 'android' && Constants.expoConfig?.android?.package === 'app.dawaee.mobile')
  || (Platform.OS === 'ios' && Constants.expoConfig?.ios?.bundleIdentifier === 'app.dawaee.mobile'
    && Constants.expoConfig?.extra?.iosPhoneVerificationEnabled === true);
let nextAttempt = 0;
let activeCancel: (() => void) | null = null;
let cleanup: Promise<unknown> = Promise.resolve();

export async function startPhoneProof(
  phone: string, onProof: (idToken: string) => Promise<void>, onError?: (error: unknown) => void,
): Promise<PhoneChallenge> {
  if (!phoneVerificationSupported) throw new Error('Phone verification is unavailable on this build');
  const attempt = ++nextAttempt;
  activeCancel?.();
  await cleanup;
  if (attempt !== nextAttempt) throw new Error('Phone verification superseded');
  // Use the configured iOS instance for the APNs/reCAPTCHA verification flow.
  // Dawaee login uses its own API session; Firebase Auth is used only for this
  // short-lived phone proof, which is signed out on completion/cancellation.
  const defaultApp = Platform.OS === 'ios';
  const app = defaultApp ? getApp()
    : await initializeApp(getApp().options, { name: `DawaeePhoneProof${attempt}` });
  if (attempt !== nextAttempt) {
    if (!defaultApp) await deleteApp(app);
    throw new Error('Phone verification superseded');
  }
  const auth = getAuth(app);
  let cancelled = false;
  let delivery: Promise<void> | null = null;
  let nativePending: Promise<unknown> = Promise.resolve();
  const native = <T,>(work: Promise<T>): Promise<T> => {
    nativePending = work.catch(() => undefined);
    return work;
  };
  let unsubscribe = () => {};
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe();
    // A cancelled native sign-in/confirmation can still mutate Auth. Drain it
    // before signing out and letting a later challenge reuse the iOS instance.
    const pending = nativePending;
    cleanup = cleanup.then(() => pending).then(() => signOut(auth)).catch(() => undefined)
      .then(() => defaultApp ? undefined : deleteApp(app)).catch(() => undefined);
    if (activeCancel === cancel) activeCancel = null;
  };
  activeCancel = cancel;
  const deliver = (user: NonNullable<typeof auth.currentUser>): Promise<void> => {
    if (cancelled || user.phoneNumber !== phone) return Promise.resolve();
    if (delivery) return delivery;
    delivery = (async () => {
      const idToken = await getIdToken(user, true);
      if (!cancelled) await onProof(idToken);
    })().finally(cancel);
    return delivery;
  };
  try {
    // Clear a proof left by an interrupted attempt before registering listeners.
    if (auth.currentUser) await native(signOut(auth));
    if (attempt !== nextAttempt) { cancel(); throw new Error('Phone verification superseded'); }
    const confirmation = await native(signInWithPhoneNumber(auth, phone));
    if (cancelled || attempt !== nextAttempt) { cancel(); throw new Error('Phone verification superseded'); }
    unsubscribe = onAuthStateChanged(auth, (user) => {
      // Android may complete verification automatically without manual entry.
      if (user) void deliver(user).catch((error) => onError?.(error));
    });
    return {
      cancel,
      confirm: async (code) => {
        if (cancelled) throw new Error('Phone verification expired');
        const credential = await native(confirmation.confirm(code));
        if (!credential?.user) throw new Error('Phone verification did not complete');
        await deliver(credential.user);
      },
    };
  } catch (error) {
    cancel();
    throw error;
  }
}
