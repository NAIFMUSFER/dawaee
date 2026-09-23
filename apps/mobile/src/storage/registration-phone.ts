import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// A contact draft, never an identity claim. Only phone proof at the existing
// authenticated API can link it. No password or Firebase token is persisted.
const KEY = 'app.dawaee.mobile.registrationPhone.v1';
const MAX_AGE = 24 * 60 * 60 * 1000;
export interface RegistrationPhone { email: string; phone: string; createdAt: number }

export async function saveRegistrationPhone(email: string, phone: string): Promise<void> {
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(KEY, JSON.stringify({
    email: email.trim().toLowerCase(), phone, createdAt: Date.now(),
  }), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

export async function readRegistrationPhone(email: string): Promise<RegistrationPhone | null> {
  if (Platform.OS === 'web') return null;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as RegistrationPhone;
    if (!Number.isFinite(value.createdAt) || value.createdAt > Date.now()
      || Date.now() - value.createdAt > MAX_AGE) {
      await SecureStore.deleteItemAsync(KEY); return null;
    }
    return value.email === email.trim().toLowerCase() && /^\+[1-9]\d{7,14}$/.test(value.phone)
      ? value : null;
  } catch { return null; }
}

export async function clearRegistrationPhone(email: string): Promise<void> {
  // Do not erase another registration started on this device.
  if (await readRegistrationPhone(email)) await SecureStore.deleteItemAsync(KEY);
}
