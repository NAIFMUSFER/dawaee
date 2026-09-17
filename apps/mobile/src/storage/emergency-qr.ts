import { purgeAllSlots, readSlot, writeSlot, type CacheSlot } from './secure-cache.js';

export const EMERGENCY_QR_SLOT: CacheSlot = { plaintextKey: 'dawaee.emergencyQr', migratePlaintext: false };
export interface SavedEmergencyQr { url: string; rotatedAt: string }
let generation = 0;
let tail: Promise<unknown> = Promise.resolve();

export function validSavedQr(value: unknown): value is SavedEmergencyQr {
  if (!value || typeof value !== 'object') return false;
  const item = value as SavedEmergencyQr;
  if (typeof item.rotatedAt !== 'string' || !Number.isFinite(Date.parse(item.rotatedAt))) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/e' && !url.search && /^#[A-Za-z0-9_-]{32}$/.test(url.hash);
  } catch { return false; }
}

async function readMap(userId: string): Promise<Record<string, SavedEmergencyQr>> {
  const raw = await readSlot(EMERGENCY_QR_SLOT, userId);
  if (!raw) return {};
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(Object.entries(data).filter(([, value]) => validSavedQr(value)));
}

export async function readEmergencyQr(userId: string, profileId: string): Promise<SavedEmergencyQr | null> {
  const revision = generation;
  await tail;
  const map = await readMap(userId).catch(() => ({} as Record<string, SavedEmergencyQr>));
  return revision === generation ? map[profileId] ?? null : null;
}

export function saveEmergencyQr(
  userId: string, profileId: string, value: SavedEmergencyQr | null, isCurrent: () => boolean,
): Promise<boolean> {
  const revision = generation;
  const work = tail.then(async () => {
    if (revision !== generation || !isCurrent()) return false;
    const map = await readMap(userId);
    if (revision !== generation || !isCurrent()) return false;
    if (value && validSavedQr(value)) map[profileId] = value;
    else delete map[profileId];
    const stored = await writeSlot(EMERGENCY_QR_SLOT, userId, JSON.stringify(map));
    return stored.ok;
  });
  tail = work.catch(() => undefined);
  return work;
}

/** Await writes before sign-out destroys ciphertext and the account's key. */
export async function purgeEmergencyQrs(): Promise<void> {
  generation++;
  await tail;
  await purgeAllSlots([EMERGENCY_QR_SLOT]);
}
