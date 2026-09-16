import React, { useMemo, useState } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Row, Txt } from './ui.js';
import { useTheme } from '../hooks/useTheme.js';
import { useI18n } from '../i18n/index.js';

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

export function TimeField({ label, value, onChange, optional, error }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  error?: string | null;
}) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [hour, setHour] = useState('08');
  const [minute, setMinute] = useState('00');
  const display = useMemo(() => isValidTime(value) ? value : '—', [value]);
  const hourLabel = locale === 'ar' ? 'الساعة (24 ساعة)' : 'Hour (24-hour clock)';
  const minuteLabel = locale === 'ar' ? 'الدقائق' : 'Minutes';

  const openPicker = () => {
    Keyboard.dismiss();
    const parts = isValidTime(value) ? value.split(':') : ['08', '00'];
    setHour(parts[0]!);
    setMinute(parts[1]!);
    setOpen(true);
  };
  const cancel = () => setOpen(false);

  // Two bounded scroll regions, with a footer outside them. A full-screen safe
  // area avoids an over-height centered card and nested Pressables intercepting
  // gestures. Cancel/hardware Back never commits an unconfirmed draft.
  const column = (title: string, values: string[], selected: string, change: (v: string) => void) => (
    <View style={{ flex: 1, minHeight: 0, gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="bold" align="center">{title}</Txt>
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
        accessibilityLabel={title} showsVerticalScrollIndicator
        contentContainerStyle={{ gap: theme.spacing.sm, padding: theme.spacing.xs }}>
        {values.map((entry) => (
          <Pressable key={entry} onPress={() => change(entry)} accessibilityRole="radio"
            accessibilityLabel={`${title}: ${entry}`} accessibilityState={{ selected: selected === entry }}
            style={{ minHeight: theme.touch, padding: theme.spacing.sm, justifyContent: 'center',
              borderWidth: 2, borderRadius: theme.radius.md,
              borderColor: theme.colors.primary200,
              backgroundColor: selected === entry ? theme.colors.primary700 : theme.colors.surface }}>
            <Txt align="center" weight="bold" color={selected === entry ? theme.colors.surface : theme.colors.primary700}
              style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}>{entry}</Txt>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{label}</Txt>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${display}`} onPress={openPicker}
        style={{ minHeight: theme.touch, borderWidth: 2, borderColor: error ? theme.colors.danger700 : theme.colors.ink200,
          borderRadius: theme.radius.md, padding: theme.spacing.md, justifyContent: 'center', backgroundColor: theme.colors.surface }}>
        <Txt variant="bodyLarge" style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}>{display}</Txt>
      </Pressable>
      {error ? <Txt variant="caption" color={theme.colors.danger700}>{error}</Txt> : null}
      <Modal visible={open} animationType="slide" onRequestClose={cancel} presentationStyle="fullScreen">
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.surface }}>
          <View accessibilityViewIsModal style={{ flex: 1, padding: theme.spacing.md, gap: theme.spacing.sm }}>
            <Txt variant="h3" weight="bold" align="center" accessibilityRole="header">{label}</Txt>
            <Txt variant="h2" weight="bold" align="center" style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}>{hour}:{minute}</Txt>
            <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', gap: theme.spacing.md }}>
              {column(hourLabel, HOURS, hour, setHour)}
              {column(minuteLabel, MINUTES, minute, setMinute)}
            </View>
            <View style={{ gap: theme.spacing.xs }}>
              <Button label={t('common.done')} onPress={() => { onChange(`${hour}:${minute}`); setOpen(false); }} />
              <Row wrap>
                <Button label={t('common.cancel')} tone="secondary" fullWidth={false} onPress={cancel} />
                {optional ? <Button label={t('common.none')} tone="ghost" fullWidth={false} onPress={() => { onChange(''); setOpen(false); }} /> : null}
              </Row>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
