import React, { useMemo, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Button, Card, Row, Txt } from './ui.js';
import { useI18n } from '../i18n/index.js';
import { useTheme } from '../hooks/useTheme.js';

/** Accepts a complete, real Gregorian calendar date only. */
export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function todayLocalDate(timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
  }).format(new Date());
}

function wireDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function initialMonth(value: string): Date {
  if (isValidLocalDate(value)) {
    const [y, m] = value.split('-').map(Number);
    return new Date(y!, m! - 1, 1);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function DateField({ label, value, onChange, hint, error, optional }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  optional?: boolean;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => initialMonth(value));

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells: Array<Date | null> = Array.from({ length: first.getDay() }, () => null);
    for (let day = 1; day <= count; day += 1) cells.push(new Date(month.getFullYear(), month.getMonth(), day));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [month]);

  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month);
  const display = value && isValidLocalDate(value)
    ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${value}T12:00:00`))
    : (optional ? t('common.none') : t('schedule.startDate'));

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="bold">{optional ? `${label} · ${t('common.optional')}` : label}</Txt>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => { setMonth(initialMonth(value)); setOpen(true); }}
        style={{ borderWidth: 1, borderColor: error ? theme.colors.danger600 : theme.colors.ink200, borderRadius: theme.radius.md, padding: theme.spacing.md, minHeight: 48, justifyContent: 'center' }}
      >
        <Row align="center" justify="between">
          <Txt variant="body">📅 {display}</Txt>
          <Txt variant="body" color={theme.colors.primary700}>›</Txt>
        </Row>
      </Pressable>
      {hint ? <Txt variant="bodySmall" color={theme.colors.ink500}>{hint}</Txt> : null}
      {error ? <Txt variant="bodySmall" color={theme.colors.danger600}>{error}</Txt> : null}

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'center', padding: theme.spacing.lg }}>
          <Pressable onPress={(e) => e.stopPropagation()}>
            <Card style={{ gap: theme.spacing.md }}>
              <Row align="center" justify="between">
                <Button label="‹" tone="ghost" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
                <Txt variant="h3" weight="bold">{monthTitle}</Txt>
                <Button label="›" tone="ghost" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
              </Row>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {days.map((day, index) => {
                  const selected = day ? wireDate(day) === value : false;
                  return (
                    <View key={`${index}-${day?.getDate() ?? 'x'}`} style={{ width: '14.285%', padding: 2 }}>
                      {day ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => { onChange(wireDate(day)); setOpen(false); }}
                          style={{ minHeight: 42, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? theme.colors.primary700 : theme.colors.surface }}
                        >
                          <Txt variant="body" weight={selected ? 'bold' : 'regular'} color={selected ? theme.colors.surface : theme.colors.ink900}>{day.getDate()}</Txt>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
              </View>
              <Row gap={theme.spacing.sm}>
                <View style={{ flex: 1 }}><Button label={t('common.cancel')} tone="secondary" onPress={() => setOpen(false)} /></View>
                {optional ? <View style={{ flex: 1 }}><Button label={t('common.none')} tone="ghost" onPress={() => { onChange(''); setOpen(false); }} /></View> : null}
              </Row>
            </Card>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
