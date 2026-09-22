import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const { createHarness } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const root = resolve(import.meta.dirname, '../../..');

describe('history calendar headings describe the fetched month', () => {
  for (const numerals of ['latn', 'arab']) {
    it(`keeps the month grid Gregorian with Umm al-Qura preference and ${numerals} numerals`, async () => {
      const locale = `ar-SA-u-ca-islamic-umalqura-nu-${numerals}`;
      const formatted: Array<{ iso: string; result: string; opts: Intl.DateTimeFormatOptions }> = [];
      const h = createHarness(resolve(root, 'apps/mobile/app/(tabs)/history.tsx'),
        resolve(root, 'apps/mobile/src/hooks/useRequestScope.ts'), {}, {
          '@/i18n': { useI18n: () => ({
            t: (key: string) => key,
            formatNumber: (value: number) => new Intl.NumberFormat(locale).format(value),
            formatWeekday: (iso: string) => new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(iso)),
            formatDate: (iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions = {}) => {
              const result = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone, ...opts }).format(new Date(iso));
              formatted.push({ iso, result, opts });
              return result;
            },
          }) },
        });
      try {
        await h.flush();
        h.find('Chip', (p: any) => p.label === 'history.viewMonth').onPress();
        await h.flush();
        const title = formatted.filter(value => Object.hasOwn(value.opts, 'day') && value.opts.day === undefined).at(-1)!;
        expect(title).toBeDefined();
        const request = h.batch().filter((r: any) => r.route === '/v1/doses').at(-1);
        expect(request.payload.from.slice(8, 10)).toBe('01');
        expect(title.iso.slice(0, 10)).toBe(request.payload.from);
        const expected = new Intl.DateTimeFormat(locale, { calendar: 'gregory', month: 'long', year: 'numeric', timeZone: h.app.activeProfile.timezone }).format(new Date(title.iso));
        expect(title.result).toBe(expected);
        expect(h.text()).toContain(expected);
        formatted.length = 0;
        h.find('Chip', (p: any) => p.label === 'history.viewDay').onPress();
        await h.flush();
        const dayTitle = formatted.find(value => value.opts.weekday === 'long')!;
        expect(dayTitle.opts.calendar).toBeUndefined(); // Detailed dates retain the preferred calendar.
      } finally { h.unmount(); }
    });
  }
});
