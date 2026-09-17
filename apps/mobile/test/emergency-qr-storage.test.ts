import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ values: new Map<string, string>(), write: vi.fn() }));
vi.mock('../src/storage/secure-cache.js', () => ({
  readSlot: async (_slot: unknown, user: string) => store.values.get(user) ?? null,
  writeSlot: async (_slot: unknown, user: string, value: string) => {
    await store.write(); store.values.set(user, value); return { ok: true };
  },
  purgeAllSlots: async () => store.values.clear(),
}));
const { readEmergencyQr, saveEmergencyQr, purgeEmergencyQrs, EMERGENCY_QR_SLOT } = await import('../src/storage/emergency-qr.js');
const qr = { url: `https://example.invalid/e#${'A'.repeat(32)}`, rotatedAt: '2026-09-18T00:00:00Z' };
beforeEach(async () => { await purgeEmergencyQrs(); store.write.mockReset(); });
describe('emergency QR persistence', () => {
  it('redraws a saved code only for its account and profile, without plaintext migration', async () => {
    await saveEmergencyQr('one', 'patient', qr, () => true);
    expect(await readEmergencyQr('one', 'patient')).toEqual(qr);
    expect(await readEmergencyQr('two', 'patient')).toBeNull();
    expect(await readEmergencyQr('one', 'another')).toBeNull();
    expect(EMERGENCY_QR_SLOT.migratePlaintext).toBe(false);
    await saveEmergencyQr('one', 'patient', null, () => true);
    expect(await readEmergencyQr('one', 'patient')).toBeNull();
  });
  it('does not persist a stale screen write and purges an in-flight write on sign-out', async () => {
    expect(await saveEmergencyQr('one', 'patient', qr, () => false)).toBe(false);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    store.write.mockImplementationOnce(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
    const write = saveEmergencyQr('one', 'patient', qr, () => true);
    await started;
    const purge = purgeEmergencyQrs(); release(); await write; await purge;
    expect(await readEmergencyQr('one', 'patient')).toBeNull();
  });
});
