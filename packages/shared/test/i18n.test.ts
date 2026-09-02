import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/enums.js';
import { isRtl, MESSAGES, missingTranslationKeys, t } from '../src/i18n.js';

describe('translation catalogs', () => {
  it('defines the same key set in every locale', () => {
    const missing = missingTranslationKeys();
    for (const locale of LOCALES) {
      expect(missing[locale], `locale ${locale} has key drift: ${missing[locale].join(', ')}`).toEqual([]);
    }
  });

  it('has no empty Arabic strings where English is non-empty', () => {
    const empties: string[] = [];
    for (const [key, en] of Object.entries(MESSAGES.en)) {
      const ar = (MESSAGES.ar as Record<string, string>)[key];
      if (en.length > 0 && (ar === undefined || (ar.length === 0 && en.length > 0 && key !== 'food.no_preference'))) {
        empties.push(key);
      }
    }
    expect(empties).toEqual([]);
  });

  it('keeps every {placeholder} consistent between locales', () => {
    const drift: string[] = [];
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    for (const [key, en] of Object.entries(MESSAGES.en)) {
      const ar = (MESSAGES.ar as Record<string, string>)[key]!;
      if (placeholders(en) !== placeholders(ar)) drift.push(`${key}: en(${placeholders(en)}) vs ar(${placeholders(ar)})`);
    }
    expect(drift).toEqual([]);
  });
});

describe('t()', () => {
  it('substitutes parameters', () => {
    expect(t('en', 'greeting.morning', { name: 'Mohammed' })).toBe('Good morning, Mohammed');
    expect(t('ar', 'greeting.morning', { name: 'محمد' })).toBe('صباح الخير، محمد');
  });
  it('leaves unknown placeholders intact rather than printing undefined', () => {
    expect(t('en', 'greeting.morning', {})).toBe('Good morning, {name}');
  });
  it('falls back to English for a missing key', () => {
    // @ts-expect-error deliberately unknown key
    expect(t('ar', 'does.not.exist')).toBe('does.not.exist');
  });
  it('renders the medical-safety strings in both languages', () => {
    expect(t('ar', 'missed.guidance')).toContain('طبيبك');
    expect(t('en', 'missed.guidance')).toContain('doctor');
    expect(t('ar', 'adherence.disclaimer').length).toBeGreaterThan(20);
  });
});

describe('RTL', () => {
  it('marks Arabic RTL and English LTR', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });
});
