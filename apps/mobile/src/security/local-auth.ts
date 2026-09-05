import { Platform } from 'react-native';

/**
 * The one place `expo-local-authentication` is loaded.
 *
 * Lazily, inside a try/catch, for the same reason the notification layer does
 * it: on Expo Web, and in any build where the native module is not linked, a
 * top-level import throws at module load and takes the whole app down. The
 * settings screen had its own private copy of this loader; the gate needs the
 * same one, and two copies of a security primitive is one copy too many.
 *
 * Dawaee never receives biometric data. The operating system performs the
 * check and returns a boolean.
 */
export interface LocalAuthModule {
  hasHardwareAsync: () => Promise<boolean>;
  isEnrolledAsync: () => Promise<boolean>;
  authenticateAsync: (options: {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
  }) => Promise<{ success: boolean }>;
}

export function loadLocalAuthentication(): LocalAuthModule | null {
  if (Platform.OS === 'web') return null;
  try {
    return require('expo-local-authentication') as LocalAuthModule;
  } catch {
    return null;
  }
}

export type LocalAuthAvailability = 'ready' | 'web' | 'no-hardware' | 'not-enrolled';

export async function checkLocalAuth(): Promise<LocalAuthAvailability> {
  if (Platform.OS === 'web') return 'web';
  const auth = loadLocalAuthentication();
  if (!auth) return 'no-hardware';
  try {
    if (!(await auth.hasHardwareAsync())) return 'no-hardware';
    if (!(await auth.isEnrolledAsync())) return 'not-enrolled';
    return 'ready';
  } catch {
    return 'no-hardware';
  }
}

/**
 * Ask the OS to verify the person holding the phone.
 *
 * `disableDeviceFallback` is deliberately left off: if the sensor fails to read
 * a finger, the device passcode is a legitimate second route, and refusing it
 * would turn a wet thumb into a lockout from a medication schedule.
 */
export async function verifyLocally(promptMessage: string, cancelLabel: string): Promise<boolean> {
  const auth = loadLocalAuthentication();
  if (!auth) return false;
  try {
    const result = await auth.authenticateAsync({ promptMessage, cancelLabel });
    return result.success === true;
  } catch {
    return false;
  }
}
