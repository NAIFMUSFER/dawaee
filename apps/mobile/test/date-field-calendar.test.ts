import { describe, expect, it } from 'vitest';
import {
  dateFieldDisplayLocale,
  dateFieldGridLocale,
  formatDateFieldMonthTitle,
} from '../src/components/date-field-calendar.js';

describe('DateField calendar semantics', () => {
  it('keeps the picker grid Gregorian when the selected-date display uses Umm al-Qura', () => {
    expect(dateFieldDisplayLocale('ar', 'latn', 'islamic-umalqura'))
      .toBe('ar-SA-u-nu-latn-ca-islamic-umalqura');
    expect(dateFieldGridLocale('ar', 'latn'))
      .toBe('ar-SA-u-nu-latn-ca-gregory');

    const september = new Date(Date.UTC(2026, 8, 15, 12));
    const gridTitle = formatDateFieldMonthTitle(september, 'ar', 'latn');
    const ummAlQuraTitle = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-islamic-umalqura', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(september);

    expect(gridTitle).not.toBe(ummAlQuraTitle);
  });

  it('honours Arabic numeral preference without changing the grid calendar', () => {
    expect(dateFieldGridLocale('ar', 'arab'))
      .toBe('ar-SA-u-nu-arab-ca-gregory');
  });

  it('makes the English picker grid calendar explicit as Gregorian', () => {
    expect(dateFieldGridLocale('en', 'latn')).toBe('en-GB-u-ca-gregory');
  });
});
