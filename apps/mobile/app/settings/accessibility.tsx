import React, { useMemo } from 'react';
import { Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import type { DoseView } from '@/api/types';

/**
 * Accessibility.
 *
 * Every control here changes the screen it is on, immediately: the sample dose
 * card below the controls is the real component, rendered with the real theme,
 * so "is this readable?" is answered by looking rather than by imagining. The
 * preferences are written through the store, which applies them optimistically
 * — someone who enabled larger text because they could not read the small text
 * must not have to wait for a network round-trip to see it.
 *
 * The text-size control is stepped buttons rather than a drag slider on
 * purpose. A slider needs a sustained, accurate drag; a tremor turns that into
 * a random size. Two large buttons need one tap each and are reversible.
 */

const TEXT_SCALE_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;

export default function AccessibilityScreen() {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { preferences, updatePreferences } = useApp();

  const currentStep = useMemo(() => {
    let closest = 0;
    for (let i = 1; i < TEXT_SCALE_STEPS.length; i++) {
      const step = TEXT_SCALE_STEPS[i] ?? 1;
      const best = TEXT_SCALE_STEPS[closest] ?? 1;
      if (Math.abs(step - preferences.textScale) < Math.abs(best - preferences.textScale)) closest = i;
    }
    return closest;
  }, [preferences.textScale]);

  const setStep = (index: number) => {
    const clamped = Math.min(Math.max(index, 0), TEXT_SCALE_STEPS.length - 1);
    const value = TEXT_SCALE_STEPS[clamped];
    if (value === undefined || value === preferences.textScale) return;
    void updatePreferences({ textScale: value });
  };

  const sampleDose: DoseView = useMemo(() => {
    const at = new Date();
    at.setHours(20, 0, 0, 0);
    return {
      id: 'preview',
      medicationId: 'preview',
      scheduleId: 'preview',
      scheduledAt: at.toISOString(),
      scheduledLocalDate: at.toISOString().slice(0, 10),
      scheduledLocalTime: '20:00',
      scheduledTimezone: 'Asia/Riyadh',
      doseQuantity: 1,
      doseUnit: 'tablet',
      status: 'due',
      minutesLate: null,
      snoozedUntil: null,
      snoozeCount: 0,
      confirmedAt: null,
      escalationStage: 0,
      medication: {
        name: t('accessibility.sampleName'),
        form: 'tablet',
        imageKey: null,
        strengthValue: 500,
        strengthUnit: 'mg',
        foodInstruction: 'after_food',
        instructions: null,
      },
    };
  }, [t]);

  const ToggleRow = ({
    label, hint, value, onChange,
  }: { label: string; hint: string; value: boolean; onChange: (next: boolean) => void }) => (
    <Card>
      <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Txt variant={theme.elderlyMode ? 'h3' : 'bodyLarge'} weight="medium">{label}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{hint}</Txt>
        </View>
        <Switch
          value={value}
          onValueChange={onChange}
          accessibilityRole="switch"
          accessibilityLabel={label}
          accessibilityHint={hint}
          trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
        />
      </Row>
    </Card>
  );

  const percent = Math.round((TEXT_SCALE_STEPS[currentStep] ?? 1) * 100);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('settings.accessibility')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        <ToggleRow
          label={t('settings.elderlyMode')}
          hint={t('settings.elderlyModeHint')}
          value={preferences.elderlyMode}
          onChange={(next) => void updatePreferences({ elderlyMode: next })}
        />
        <Txt variant="bodySmall" color={theme.colors.ink500}>{t('accessibility.elderlyModeChanges')}</Txt>

        <SectionTitle>{t('settings.textSize')}</SectionTitle>
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Txt variant="bodyLarge" weight="medium">
              {t('accessibility.textSizeValue', { percent: formatNumber(percent) })}
            </Txt>
            <Txt variant="caption" color={theme.colors.ink500}>
              {formatNumber(currentStep + 1)} / {formatNumber(TEXT_SCALE_STEPS.length)}
            </Txt>
          </Row>

          <Row gap={theme.spacing.md}>
            <View style={{ flex: 1 }}>
              <Button
                label={t('accessibility.textSizeSmaller')}
                tone="secondary"
                size={theme.elderlyMode ? 'large' : 'regular'}
                disabled={currentStep === 0}
                onPress={() => setStep(currentStep - 1)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={t('accessibility.textSizeLarger')}
                tone="secondary"
                size={theme.elderlyMode ? 'large' : 'regular'}
                disabled={currentStep === TEXT_SCALE_STEPS.length - 1}
                onPress={() => setStep(currentStep + 1)}
              />
            </View>
          </Row>

          <Row gap={theme.spacing.xs}>
            {TEXT_SCALE_STEPS.map((step, index) => (
              <View
                key={step}
                style={{
                  flex: 1,
                  height: 8,
                  borderRadius: theme.radius.pill,
                  backgroundColor: index <= currentStep ? theme.colors.primary600 : theme.colors.ink100,
                }}
              />
            ))}
          </Row>

          <Txt variant="caption" color={theme.colors.ink500}>{t('accessibility.textSizeHint')}</Txt>
        </Card>

        <ToggleRow
          label={t('settings.highContrast')}
          hint={t('accessibility.highContrastHint')}
          value={preferences.highContrast}
          onChange={(next) => void updatePreferences({ highContrast: next })}
        />

        <ToggleRow
          label={t('settings.voiceReminders')}
          hint={t('accessibility.voiceRemindersHint')}
          value={preferences.voiceRemindersEnabled}
          onChange={(next) => void updatePreferences({ voiceRemindersEnabled: next })}
        />

        <ToggleRow
          label={t('settings.voiceConfirmation')}
          hint={t('accessibility.voiceConfirmationHint')}
          value={preferences.voiceConfirmationEnabled}
          onChange={(next) => void updatePreferences({ voiceConfirmationEnabled: next })}
        />

        <SectionTitle>{t('accessibility.livePreview')}</SectionTitle>
        {/* Inert on purpose: this is what a reminder will look like, not one to act on. */}
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <DoseCard dose={sampleDose} prominent />
        </View>
      </Screen>
    </SafeAreaView>
  );
}
