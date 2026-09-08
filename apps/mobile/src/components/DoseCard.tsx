import React from 'react';
import { View } from 'react-native';
import { Badge, Button, Card, Row, Txt } from './ui.js';
import { useTheme } from '../hooks/useTheme.js';
import { useI18n } from '../i18n/index.js';
import { statusColors } from '../theme/index.js';
import type { DoseView } from '../api/types.js';
import { canUndo } from '@dawaee/core';

export function DoseCard({
  dose, prominent = false, onTaken, onSnooze, onSkip, onUndo, onPress, busy,
}: {
  dose: DoseView;
  prominent?: boolean;
  onTaken?: () => void;
  onSnooze?: () => void;
  onSkip?: () => void;
  onUndo?: () => void;
  onPress?: () => void;
  busy?: boolean;
}) {
  const theme = useTheme();
  const { t, formatTime, formatMeasure } = useI18n();
  const colors = statusColors(dose.status);

  const doseText = formatMeasure(dose.doseQuantity, `unit.${dose.doseUnit}`);
  const strength = dose.medication.strengthValue
    ? formatMeasure(dose.medication.strengthValue, dose.medication.strengthUnit ? `strengthUnit.${dose.medication.strengthUnit}` : undefined)
    : null;
  const food = t(`food.${dose.medication.foodInstruction}` as never);
  const actionable = ['upcoming', 'due', 'pending_confirmation', 'snoozed'].includes(dose.status);
  const canAct = actionable && onTaken !== undefined;
  const undoable = onUndo !== undefined && canUndo(dose, new Date());

  const a11yLabel = [
    dose.medication.name,
    strength,
    doseText,
    formatTime(dose.scheduledAt, dose.scheduledTimezone),
    t(`dose.status.${dose.status}` as never),
  ].filter(Boolean).join('، ');

  if (prominent) {
    return (
      <Card style={{ gap: theme.spacing.lg, borderColor: colors.fg, borderWidth: 2 }} accessibilityLabel={a11yLabel}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Badge label={t(`dose.status.${dose.status}` as never)} fg={colors.fg} bg={colors.bg} />
          <Txt variant="h2" weight="bold" color={theme.colors.primary700}>
            {formatTime(dose.scheduledAt, dose.scheduledTimezone)}
          </Txt>
        </Row>

        <View
          accessible
          accessibilityLabel={a11yLabel}
          style={{
            alignItems: 'center', gap: theme.spacing.xs,
            paddingVertical: theme.elderlyMode ? theme.spacing.xl : theme.spacing.md,
          }}
        >
          <Txt variant="display" align="center">💊</Txt>
          <Txt variant={theme.elderlyMode ? 'h1' : 'h2'} weight="bold" align="center">{dose.medication.name}</Txt>
          {strength ? <Txt variant="h3" color={theme.colors.ink500} align="center">{strength}</Txt> : null}
          <Txt variant="h3" weight="medium" align="center">{doseText}</Txt>
          {food ? <Txt variant="body" color={theme.colors.ink500} align="center">{food}</Txt> : null}
        </View>

        {canAct ? (
          <View style={{ gap: theme.spacing.md }}>
            <Button
              label={t('today.taken')}
              tone="success"
              size="large"
              onPress={() => onTaken?.()}
              loading={busy}
              accessibilityHint={t('today.taken')}
              testID="dose-taken"
            />
            <Row gap={theme.spacing.md}>
              <View style={{ flex: 1 }}>
                {onSnooze ? <Button label={t('today.remindLater')} tone="secondary" onPress={onSnooze} /> : null}
              </View>
              {!theme.elderlyMode && onSkip ? (
                <View style={{ flex: 1 }}>
                  <Button label={t('today.skip')} tone="ghost" onPress={onSkip} />
                </View>
              ) : null}
            </Row>
          </View>
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            <Txt variant="body" color={colors.fg} align="center" weight="medium">
              {dose.confirmedAt
                ? t('dose.takenAt', { time: formatTime(dose.confirmedAt, dose.scheduledTimezone) })
                : t(`dose.status.${dose.status}` as never)}
            </Txt>
            {undoable ? (
              <Button label={t('today.undo')} tone="ghost" loading={busy} onPress={() => onUndo?.()} />
            ) : null}
          </View>
        )}
      </Card>
    );
  }

  return (
    <Card onPress={onPress} accessibilityLabel={a11yLabel} style={{ paddingVertical: theme.spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="bodyLarge" weight="bold" numberOfLines={1}>{dose.medication.name}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>
            {[strength, doseText].filter(Boolean).join(' · ')}
          </Txt>
        </View>
        <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
          <Txt variant="bodyLarge" weight="bold">{formatTime(dose.scheduledAt, dose.scheduledTimezone)}</Txt>
          <Badge label={t(`dose.status.${dose.status}` as never)} fg={colors.fg} bg={colors.bg} />
        </View>
      </Row>
      {dose.status === 'taken_late' && dose.minutesLate ? (
        <Txt variant="caption" color={theme.colors.warning700}>{t('dose.lateBy', { minutes: dose.minutesLate })}</Txt>
      ) : null}
      {undoable ? (
        <View style={{ alignItems: 'flex-start', marginTop: theme.spacing.xs }}>
          <Button label={t('today.undo')} tone="ghost" loading={busy} fullWidth={false}
            onPress={() => onUndo?.()} />
        </View>
      ) : null}
    </Card>
  );
}