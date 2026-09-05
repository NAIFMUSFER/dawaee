import { gcm } from '@noble/ciphers/aes';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import * as Crypto from 'expo-crypto';

/**
 * Authenticated encryption for everything this app keeps on disk about a
 * patient's medication.
 *
 * ── THREAT MODEL ──────────────────────────────────────────────────────────
 *
 * IN SCOPE. An attacker with the storage but not the running app: a stolen or
 * lost phone, an `adb backup` from a device with USB debugging on, a rooted or
 * jailbroken handset, a forensic image, a repair shop, a resold device whose
 * factory reset was skipped, and a cloud backup that included app data. In all
 * of these the AsyncStorage database is a file that can simply be read, and
 * what was in it was a plain-text list of the medications a person takes, their
 * doses and their times — enough to infer a diagnosis, which is the category of
 * fact that costs people jobs, custody and insurance.
 *
 * OUT OF SCOPE, and stated so nobody mistakes this for more than it is:
 *  - A live device with the app unlocked and running. The key is in memory by
 *    definition; anything that can read process memory has already won.
 *  - Malware with root running WHILE the user is signed in. Same reason.
 *  - The server. Encryption here protects the device copy, not the account.
 *  - Traffic. That is TLS's job.
 *  - PHI the OS has already been handed — notification bodies in particular.
 *    Encrypting the cache does not retract a medication name from the lock
 *    screen or from Android's notification history. That is a separate finding
 *    with a separate fix and is NOT closed by this file.
 *
 * ── PRIMITIVE ─────────────────────────────────────────────────────────────
 *
 * AES-256-GCM, from `@noble/ciphers` — an audited, widely deployed
 * implementation of a NIST-standard AEAD. AEAD is required rather than
 * preferred: without authentication, someone who can write to the storage file
 * could flip bits in the ciphertext of a cached dose and change a status or a
 * quantity, and CBC padding oracles are a well-trodden road. GCM gives
 * confidentiality and integrity in one pass, and a modified tag makes
 * decryption fail loudly instead of returning attacker-chosen plaintext.
 *
 * No AES-CBC, no ECB, nothing home-grown, and no deterministic mode: two
 * identical caches encrypt to different ciphertexts, so an observer cannot tell
 * that today's medication list matches yesterday's.
 *
 * ── NONCE ─────────────────────────────────────────────────────────────────
 *
 * 96 bits (12 bytes), the size GCM is specified for, drawn per message from
 * `expo-crypto`'s CSPRNG — `SecRandomCopyBytes` on iOS, `SecureRandom` on
 * Android, `crypto.getRandomValues` on web. Never a counter and never a
 * timestamp: a counter that resets after a reinstall or a restored backup
 * repeats a nonce under the same key, and nonce reuse in GCM does not merely
 * leak — it leaks the XOR of two plaintexts and, worse, allows forging the
 * authentication tag for that key entirely.
 *
 * Random 96-bit nonces carry a birthday bound: the probability of any
 * collision reaches 2⁻³² at about 2³² messages under one key. This app writes
 * the queue on each dose action and the cache on each sync — realistically
 * fewer than 10⁵ writes over the life of an install, which is twelve orders of
 * magnitude below that bound. Stated rather than assumed, because the moment
 * something starts writing in a loop the analysis has to be redone.
 *
 * The nonce is stored beside the ciphertext in the envelope. It is not secret;
 * it must only be unique.
 */

/** GCM's specified nonce size. Not a tunable. */
export const NONCE_BYTES = 12;
/** AES-256. */
export const KEY_BYTES = 32;

/**
 * The envelope, versioned so a future migration never has to guess how old
 * ciphertext was produced.
 *
 * `v` is the envelope shape, `alg` the primitive, and `k` the key generation —
 * three separate numbers because they change independently: rotating a key is
 * not changing an algorithm, and adding a field is not either. A reader that
 * meets a combination it does not understand refuses rather than guesses.
 */
export const ENVELOPE_VERSION = 1;
export const ALGORITHM = 'AES-256-GCM';

export interface Envelope {
  v: number;
  alg: string;
  k: number;
  /** base64, NONCE_BYTES long. */
  n: string;
  /** base64, ciphertext with the GCM tag appended. */
  c: string;
}

/** Raised for every decryption failure. Carries no plaintext, key or ciphertext. */
export class DecryptionFailed extends Error {
  constructor(readonly reason: 'envelope' | 'version' | 'algorithm' | 'key' | 'integrity') {
    super(`stored data could not be decrypted (${reason})`);
    this.name = 'DecryptionFailed';
  }
}

// Base64 without pulling in a polyfill: React Native has global.btoa/atob via
// its own base64 module on both platforms, but Hermes does not guarantee it, so
// the conversion is done explicitly.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    const idx = B64.indexOf(ch);
    if (idx < 0) throw new DecryptionFailed('envelope');
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/** CSPRNG bytes. Platform-backed on all three platforms. */
export function randomBytes(length: number): Uint8Array {
  return Crypto.getRandomBytes(length);
}

/** A fresh AES-256 key. */
export function generateKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypt a UTF-8 string into a self-describing envelope.
 *
 * `keyVersion` is recorded so that ciphertext written under a key that has
 * since been replaced is recognised as undecryptable rather than reported as
 * corrupt — the difference between "this device was re-keyed, rebuild the
 * cache" and "something tampered with your data".
 */
export function seal(plaintext: string, key: Uint8Array, keyVersion: number): Envelope {
  if (key.length !== KEY_BYTES) throw new DecryptionFailed('key');
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = gcm(key, nonce).encrypt(utf8ToBytes(plaintext));
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    k: keyVersion,
    n: toBase64(nonce),
    c: toBase64(ciphertext),
  };
}

/**
 * Decrypt an envelope, refusing anything it does not fully recognise.
 *
 * Every rejection is a distinct reason, and none of them carries data. A
 * failure here is either a re-keyed device or an attempt at tampering; both
 * end the same way for the caller — discard and rebuild from the server — but
 * the reason is worth having in a bug report that contains no PHI.
 */
export function open(envelope: unknown, key: Uint8Array, keyVersion: number): string {
  const e = envelope as Partial<Envelope> | null;
  if (!e || typeof e !== 'object' || typeof e.n !== 'string' || typeof e.c !== 'string') {
    throw new DecryptionFailed('envelope');
  }
  if (e.v !== ENVELOPE_VERSION) throw new DecryptionFailed('version');
  if (e.alg !== ALGORITHM) throw new DecryptionFailed('algorithm');
  if (e.k !== keyVersion) throw new DecryptionFailed('key');
  if (key.length !== KEY_BYTES) throw new DecryptionFailed('key');

  const nonce = fromBase64(e.n);
  if (nonce.length !== NONCE_BYTES) throw new DecryptionFailed('envelope');

  try {
    // Throws when the tag does not verify — which is the whole point of using
    // an AEAD rather than a raw cipher.
    return bytesToUtf8(gcm(key, nonce).decrypt(fromBase64(e.c)));
  } catch {
    throw new DecryptionFailed('integrity');
  }
}
