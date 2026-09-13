import type { Locale } from '@dawaee/shared';

export type DateFieldNumeralSystem = 'latn' | 'arab';
export type DateFieldCalendarSystem = 'gregory' | 'islamic-umalqura';

/**
 * Locale used for the value shown outside the picker.
 *
 * The selected value may be rendered in the user's preferred calendar even
 * though the API wire value remains an ISO/Gregorian YYYY-MM-DD date.
 */
export function dateFieldDisplayLocale(
  locale: Locale,
  numeralSystem: DateFieldNumeralSystem,
  calendarSystem: DateFieldCalendarSystem,
): string {
  return locale === 'ar'
    ? `ar-SA-u-nu-${numeralSystem}-ca-${calendarSystem}`
    : 'en-GB';
}

/**
 * Locale used by the picker grid itself.
 *
 * DateField's month arithmetic and day cells are Gregorian (`Date#getMonth`,
 * `Date#getDate`) and the value committed to the API is Gregorian YYYY-MM-DD.
 * Labelling that grid with an Umm al-Qura month name makes the visible heading
 * describe a different calendar from the numbered cells underneath it. Keep
 * the grid explicitly Gregorian while still honouring the user's numeral style.
 */
export function dateFieldGridLocale(
  locale: Locale,
  numeralSystem: DateFieldNumeralSystem,
): string {
  return locale === 'ar'
    ? `ar-SA-u-nu-${numeralSystem}-ca-gregory`
    : 'en-GB-u-ca-gregory';
}

export function formatDateFieldMonthTitle(
  date: Date,
  locale: Locale,
  numeralSystem: DateFieldNumeralSystem,
): string {
  return new Intl.DateTimeFormat(dateFieldGridLocale(locale, numeralSystem), {
    month: 'long',
    year: 'numeric',
  }).format(date);
}
