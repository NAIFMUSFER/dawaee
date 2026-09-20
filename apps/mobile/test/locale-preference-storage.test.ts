import { beforeEach, describe, expect, it, vi } from 'vitest';

const getItem = vi.fn();
const setItem = vi.fn();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem, setItem },
}));

describe('pre-authentication locale persistence', () => {
  beforeEach(() => {
    getItem.mockReset();
    setItem.mockReset();
    vi.resetModules();
  });

  it.each(['ar', 'en'] as const)('restores the reviewed locale %s', async (locale) => {
    getItem.mockResolvedValue(locale);
    const { readLocalePreference } = await import('../src/storage/locale-preference.js');
    await expect(readLocalePreference()).resolves.toBe(locale);
    expect(getItem).toHaveBeenCalledWith('dawaee.localePreference');
  });

  it('fails closed to device language for corrupt or unavailable storage', async () => {
    getItem.mockResolvedValueOnce('fr').mockRejectedValueOnce(new Error('unavailable'));
    const { readLocalePreference } = await import('../src/storage/locale-preference.js');
    await expect(readLocalePreference()).resolves.toBeNull();
    await expect(readLocalePreference()).resolves.toBeNull();
  });

  it('reports a failed write without throwing into the language screen', async () => {
    setItem.mockRejectedValue(new Error('unavailable'));
    const { writeLocalePreference } = await import('../src/storage/locale-preference.js');
    await expect(writeLocalePreference('en')).resolves.toBe(false);
  });

  it('serializes rapid choices so the newest language is written last', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    setItem.mockImplementationOnce(() => first).mockResolvedValueOnce(undefined);
    const { writeLocalePreference } = await import('../src/storage/locale-preference.js');

    const english = writeLocalePreference('en');
    const arabic = writeLocalePreference('ar');
    await Promise.resolve();
    await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenNthCalledWith(1, 'dawaee.localePreference', 'en');

    releaseFirst();
    await expect(Promise.all([english, arabic])).resolves.toEqual([true, true]);
    expect(setItem).toHaveBeenNthCalledWith(2, 'dawaee.localePreference', 'ar');
  });
});
