import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getApp, initializeApp, deleteApp } from '@react-native-firebase/app';
import { getAuth, getIdToken, onAuthStateChanged, signInWithPhoneNumber, signOut } from '@react-native-firebase/auth';

export interface PhoneChallenge {
  confirm: (code: string) => Promise<void>;
  cancel: () => void;
}
export const phoneVerificationSupported = Platform.OS === 'android'
  && Constants.expoConfig?.android?.package === 'app.dawaee.mobile';
let nextAttempt = 0;

export async function startPhoneProof(
  phone: string, onProof: (idToken: string) => Promise<void>, onError?: (error: unknown) => void,
): Promise<PhoneChallenge> {
  if (!phoneVerificationSupported) throw new Error('Phone verification is unavailable on this build');
  // Isolate this short-lived proof from any other Firebase flow. No ID token
  // or confirmation code enters Dawaee's session storage or navigation state.
  const app = await initializeApp(getApp().options, { name: `DawaeePhoneProof${++nextAttempt}` });
  const auth = getAuth(app);
  let cancelled = false;
  let delivery: Promise<void> | null = null;
  let unsubscribe = () => {};
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe();
    void signOut(auth).catch(() => undefined).finally(() => deleteApp(app).catch(() => undefined));
  };
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
    const confirmation = await signInWithPhoneNumber(auth, phone);
    unsubscribe = onAuthStateChanged(auth, (user) => {
      // Android may complete verification automatically without manual entry.
      if (user) void deliver(user).catch((error) => onError?.(error));
    });
    return {
      cancel,
      confirm: async (code) => {
        if (cancelled) throw new Error('Phone verification expired');
        const credential = await confirmation.confirm(code);
        if (!credential?.user) throw new Error('Phone verification did not complete');
        await deliver(credential.user);
      },
    };
  } catch (error) {
    cancel();
    throw error;
  }
}
