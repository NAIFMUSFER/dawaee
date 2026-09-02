import React, { useState } from 'react';
import { Field } from './ui.js';
import { useI18n } from '../i18n/index.js';

/**
 * A calendar date entered as text.
 *
 * Deliberately not a native date-picker dependency: the app has to run on the
 * web export as well as on both native platforms, and every native picker
 * disagrees about Hijri calendars and RTL. A masked `YYYY-MM-DD` field behaves
 * identically everywhere, and the value it produces is already the wire format
 * (`LocalDate`) the API expects.
 *
 * Digits are forced left-to-right by `Field` because the keyboard type is a
 * numeric pad, so the mask reads correctly in an Arabic UI too.
 */

const EXAMPLE = '2026-09-02';

/** Accepts a complete, real calendar date only — 2026-02-31 is rejected. */
export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

export function todayLocalDate(timeZone?: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is exactly the wire format, and the
  // timezone argument keeps "today" meaning today where the patient is.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
  }).format(new Date());
}

function mask(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

export function DateField({
  label, value, onChange, hint, error, optional,
}: {
  label: string;
  /** Empty string means "not set". */
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  optional?: boolean;
}) {
  const { t } = useI18n();
  const [touched, setTouched] = useState(false);

  const incomplete = value.length > 0 && !isValidLocalDate(value);
  const missing = !optional && touched && value.length === 0;
  const shownError = error ?? (incomplete || missing ? t('date.invalid') : null);

  return (
    <Field
      label={optional ? `${label} · ${t('common.optional')}` : label}
      value={value}
      onChangeText={(next) => {
        setTouched(true);
        onChange(mask(next));
      }}
      placeholder={EXAMPLE}
      keyboardType="number-pad"
      maxLength={10}
      hint={hint ?? t('date.hint', { example: EXAMPLE })}
      error={shownError}
    />
  );
}
