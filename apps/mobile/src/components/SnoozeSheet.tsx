import React, { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Button, Field, Row, Txt } from './ui.js';
import { useTheme } from '../hooks/useTheme.js';
import { useI18n } from '../i18n/index.js';

/** Snooze durations from the brief, plus a custom value. */
const PRESETS = [5, 10, 15, 30, 60];

export function SnoozeSheet({
  defaultMinutes, onSelect, onClose,
}: { defaultMinutes: number; onSelect: (minutes: number) => void; onClose: () => void }) {
  const theme = useTheme();
  const { t, formatNumber } = useI18n();
  const [custom, setCustom] = useState('');

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} visible>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t('common.close')}
        style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
          }}
        >
          <Txt variant="h3" weight="bold" accessibilityRole="header">{t('snooze.title')}</Txt>

          <Row wrap gap={theme.spacing.sm}>
            {PRESETS.map((m) => (
              <View key={m} style={{ minWidth: '30%', flexGrow: 1 }}>
                <Button
                  label={m === 60 ? t('snooze.hour') : t('snooze.minutes', { minutes: formatNumber(m) })}
                  tone={m === defaultMinutes ? 'primary' : 'secondary'}
                  onPress={() => onSelect(m)}
                />
              </View>
            ))}
          </Row>

          <Field
            label={t('snooze.custom')}
            value={custom}
            onChangeText={setCustom}
            keyboardType="number-pad"
            maxLength={3}
          />
          <Button
            label={t('common.confirm')}
            disabled={!custom || Number(custom) < 1 || Number(custom) > 720}
            onPress={() => onSelect(Number(custom))}
          />
          <Button label={t('common.cancel')} tone="ghost" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
