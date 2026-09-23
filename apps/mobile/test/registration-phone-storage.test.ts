import { beforeEach, describe, expect, it, vi } from 'vitest';
const secure = new Map<string, string>();
let platform = 'ios';
vi.mock('react-native', () => ({ Platform: { get OS() { return platform; } } }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secure.set(key, value); },
  deleteItemAsync: async (key: string) => { secure.delete(key); },
}));
const { saveRegistrationPhone, readRegistrationPhone, clearRegistrationPhone } = await import('../src/storage/registration-phone.js');
beforeEach(() => { secure.clear(); platform = 'ios'; vi.useRealTimers(); });
describe('registration contact draft', () => {
  it('survives native signup/login while isolating mailboxes and keeping passwords out of storage', async () => {
    await saveRegistrationPhone(' Recipient@Example.test ', '+966500001234');
    expect(await readRegistrationPhone('recipient@example.test')).toMatchObject({ email: 'recipient@example.test', phone: '+966500001234' });
    expect(await readRegistrationPhone('other@example.test')).toBeNull();
    await clearRegistrationPhone('other@example.test'); expect(secure.size).toBe(1);
    expect(Object.keys(JSON.parse([...secure.values()][0]!)).sort()).toEqual(['createdAt', 'email', 'phone']);
    await clearRegistrationPhone('recipient@example.test'); expect(secure.size).toBe(0);
  });
  it('expires the draft after one day', async () => {
    vi.useFakeTimers(); await saveRegistrationPhone('recipient@example.test', '+966500001234');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(await readRegistrationPhone('recipient@example.test')).toBeNull(); expect(secure.size).toBe(0);
    vi.useRealTimers();
  });
  it('does not persist contact drafts in a browser', async () => {
    platform = 'web'; await saveRegistrationPhone('recipient@example.test', '+966500001234');
    expect(secure.size).toBe(0); expect(await readRegistrationPhone('recipient@example.test')).toBeNull();
  });
});
