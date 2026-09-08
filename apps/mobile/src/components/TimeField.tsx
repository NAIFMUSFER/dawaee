import React, { useMemo, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Button, Card, Row, Txt } from './ui.js';
import { useTheme } from '../hooks/useTheme.js';
import { useI18n } from '../i18n/index.js';

export function isValidTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

export function TimeField({ label, value, onChange, optional, error }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  error?: string | null;
}) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const initial = isValidTime(value) ? value.split(':') : ['08', '00'];
  const [open, setOpen] = useState(false);
  const [hour, setHour] = useState(initial[0] ?? '08');
  const [minute, setMinute] = useState(initial[1] ?? '00');
  const display = useMemo(() => isValidTime(value) ? value : (optional ? '—' : '08:00'), [optional, value]);
  const hourLabel = locale === 'ar' ? 'الساعة' : 'Hour';
  const minuteLabel = locale === 'ar' ? 'الدقائق' : 'Minutes';

  const openPicker = () => {
    const parts = isValidTime(value) ? value.split(':') : ['08', '00'];
    setHour(parts[0] ?? '08');
    setMinute(parts[1] ?? '00');
    setOpen(true);
  };

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{label}</Txt>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={openPicker}
        style={{ minHeight: theme.touch, borderWidth: 2, borderColor: error ? theme.colors.danger700 : theme.colors.ink200, borderRadius: theme.radius.md, paddingHorizontal: theme.spacing.md, justifyContent: 'center', backgroundColor: theme.colors.surface }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="bodyLarge">⏰ {display}</Txt><Txt color={theme.colors.primary700}>›</Txt>
        </Row>
      </Pressable>
      {error ? <Txt variant="caption" color={theme.colors.danger700}>{error}</Txt> : null}
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'center', padding: theme.spacing.lg }}>
          <Pressable onPress={(e) => e.stopPropagation()}>
            <Card>
              <Txt variant="h3" weight="bold" align="center">{label}</Txt>
              <Txt variant="display" weight="bold" align="center">{hour}:{minute}</Txt>
              <Txt variant="bodySmall" weight="bold">{hourLabel}</Txt>
              <Row wrap>{HOURS.map((h) => <Button key={h} label={h} tone={h === hour ? 'primary' : 'secondary'} fullWidth={false} onPress={() => setHour(h)} />)}</Row>
              <Txt variant="bodySmall" weight="bold">{minuteLabel}</Txt>
              <Row wrap>{MINUTES.map((m) => <Button key={m} label={m} tone={m === minute ? 'primary' : 'secondary'} fullWidth={false} onPress={() => setMinute(m)} />)}</Row>
              <Button label={t('common.done')} onPress={() => { onChange(`${hour}:${minute}`); setOpen(false); }} />
              {optional ? <Button label={t('common.none')} tone="ghost" onPress={() => { onChange(''); setOpen(false); }} /> : null}
              <Button label={t('common.cancel')} tone="ghost" onPress={() => setOpen(false)} />
            </Card>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
