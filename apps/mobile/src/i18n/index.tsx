import React, { createContext, useContext, useMemo } from 'react';
import { I18nManager } from 'react-native';
import { isRtl, t as translate, type Locale, type MessageKey } from '@dawaee/shared';

/**
 * Localization.
 *
 * Two things this does that a naive implementation gets wrong:
 *  - Numbers are formatted with `Intl`, honouring the user's numeral-system
 *    preference, so an Arabic UI can still show Latin digits (which many Gulf
 *    users prefer for times and quantities).
 *  - Dates are formatted in the PATIENT's timezone, not the device's, so a
 *    caregiver abroad reads "8:00 PM" meaning 8 PM where the patient is.
 */

export interface I18nValue {
  locale: Locale;
  isRtl: boolean;
  numeralSystem: 'latn' | 'arab';
  calendar: 'gregory' | 'islamic-umalqura';
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatTime: (iso: string, timeZone?: string) => string;
  formatDate: (iso: string, timeZone?: string, opts?: Intl.DateTimeFormatOptions) => string;
  formatWeekday: (iso: string, timeZone?: string) => string;
  formatRelativeMinutes: (minutes: number) => string;
  /**
   * A quantity with its unit, e.g. "500 ملغم" or "1 tablet".
   *
   * Mixed-script measurements are the classic bidi trap: a Latin unit next to
   * a number inside an Arabic paragraph gets visually reordered into
   * "mg 500". Wrapping the pair in a first-strong isolate (U+2068…U+2069)
   * pins its internal order while still letting it flow with the surrounding
   * RTL text — which is what "real RTL, not reversed layout" actually means.
   */
  formatMeasure: (value: number, unitKey?: string) => string;
  /**
   * Wraps a fragment whose internal order must survive an RTL paragraph —
   * phone numbers, percentages, versions, IDs. Without this a number followed
   * by a Latin symbol visually reorders and "+966…397" reads back as
   * "397…966+".
   */
  bidi: (text: string) => string;
  /** A percentage that keeps its sign attached to its number. */
  formatPercent: (value: number, fractionDigits?: number) => string;
}

const FSI = '\u2068';
const PDI = '\u2069';

const I18nContext = createContext<I18nValue | null>(null);

export interface I18nProviderProps {
  locale: Locale;
  numeralSystem?: 'latn' | 'arab';
  calendar?: 'gregory' | 'islamic-umalqura';
  children: React.ReactNode;
}

export function I18nProvider({ locale, numeralSystem = 'latn', calendar = 'gregory', children }: I18nProviderProps) {
  const rtl = isRtl(locale);

  const value = useMemo<I18nValue>(() => {
    const bcp = locale === 'ar' ? `ar-SA-u-nu-${numeralSystem}-ca-${calendar}` : 'en-GB';

    const formatNumber = (n: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(bcp, options).format(n);

    const formatTime = (iso: string, timeZone?: string) =>
      new Intl.DateTimeFormat(bcp, {
        hour: '2-digit', minute: '2-digit', hour12: locale === 'en', timeZone,
      }).format(new Date(iso));

    const formatDate = (iso: string, timeZone?: string, opts?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(bcp, { day: 'numeric', month: 'long', year: 'numeric', timeZone, ...opts })
        .format(new Date(iso));

    const formatWeekday = (iso: string, timeZone?: string) =>
      new Intl.DateTimeFormat(bcp, { weekday: 'long', timeZone }).format(new Date(iso));

    const formatRelativeMinutes = (minutes: number) => {
      const rtf = new Intl.RelativeTimeFormat(locale === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
      if (Math.abs(minutes) < 60) return rtf.format(Math.round(minutes), 'minute');
      if (Math.abs(minutes) < 1440) return rtf.format(Math.round(minutes / 60), 'hour');
      return rtf.format(Math.round(minutes / 1440), 'day');
    };

    const formatMeasure = (value: number, unitKey?: string) => {
      const number = formatNumber(value);
      if (!unitKey) return `${FSI}${number}${PDI}`;
      const unit = translate(locale, unitKey as never);
      // An unknown key falls back to the raw token rather than printing the key.
      const label = unit === unitKey ? unitKey.split('.').pop() ?? '' : unit;
      return `${FSI}${number} ${label}${PDI}`;
    };

    const bidi = (text: string) => `${FSI}${text}${PDI}`;
    const formatPercent = (value: number, fractionDigits = 0) =>
      bidi(formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: fractionDigits }) + '%');

    return {
      locale,
      isRtl: rtl,
      numeralSystem,
      calendar,
      t: (key, params) => translate(locale, key, params),
      formatNumber,
      formatTime,
      formatDate,
      formatWeekday,
      formatRelativeMinutes,
      formatMeasure,
      bidi,
      formatPercent,
    };
  }, [locale, numeralSystem, calendar, rtl]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

/**
 * Applies the platform RTL flag.
 *
 * React Native needs `forceRTL` to mirror layout natively, and on native it
 * only takes effect after a reload — so the caller is told whether a restart
 * is required rather than the app silently rendering half-mirrored.
 */
export function applyNativeDirection(locale: Locale): { restartRequired: boolean } {
  const want = isRtl(locale);
  if (I18nManager.isRTL === want) return { restartRequired: false };
  I18nManager.allowRTL(want);
  I18nManager.forceRTL(want);
  return { restartRequired: true };
}

export function useT() {
  return useI18n().t;
}
