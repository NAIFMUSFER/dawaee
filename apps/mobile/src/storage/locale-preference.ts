import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Locale } from '@dawaee/shared';

/**
 * The last language deliberately selected on this installation.
 *
 * This value is presentation-only: it contains no account, medication or
 * credential data, so plaintext AsyncStorage is intentional.  It must be
 * available before authentication in order for the first-run and sign-in
 * screens to keep the language a person already chose after a process restart.
 */
const LOCALE_KEY = 'dawaee.localePreference';

// Preserve call order when a user changes language twice before the first
// storage write settles. AsyncStorage itself does not promise completion order
// for independent writes, and the older choice must never land last.
let writeTail: Promise<void> = Promise.resolve();

function isLocale(value: string | null): value is Locale {
  return value === 'ar' || value === 'en';
}

export async function readLocalePreference(): Promise<Locale | null> {
  // If a caller reads while a live preference write is in flight, observe the
  // final serialized value rather than a transient predecessor.
  await writeTail.catch(() => undefined);
  const value = await AsyncStorage.getItem(LOCALE_KEY).catch(() => null);
  return isLocale(value) ? value : null;
}

export async function writeLocalePreference(locale: Locale): Promise<boolean> {
  let written = false;
  const work = writeTail
    .catch(() => undefined)
    .then(async () => {
      try {
        await AsyncStorage.setItem(LOCALE_KEY, locale);
        written = true;
      } catch {
        // Language changes still apply for this process when device storage is
        // temporarily unavailable. A later change/bootstrap can retry safely.
      }
    });
  writeTail = work;
  await work;
  return written;
}
