import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Field, Loading, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { inspectCapability, requestPermission, type NotificationCapability } from '@/notifications';

/**
 * Notification settings, and an honest diagnosis of what this device will
 * actually do.
 *
 * The capability block is read from the platform rather than from a stored
 * flag, because the user can revoke notification permission — or Android's
 * exact-alarm permission — long after the app last asked. When something is
 * degraded the screen says what will happen in practice ("a reminder may
 * arrive a few minutes late"), not that something is "disabled".
 *
 * What it deliberately does NOT promise: bypassing silent mode or Do Not
 * Disturb. Both need entitlements a medication reminder app is not granted, so
 * claiming it would be a lie a patient could rely on.
 */

const SNOOZE_OPTIONS = [5, 10, 15, 30, 60] as const;
const LOW_STOCK_OPTIONS = [3, 5, 7, 10] as const;
const EXPIRY_OPTIONS = [30, 14, 7] as const;
const QUIET_STEP_MINUTES = 30;

function minutesToLocalTime(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function localTimeToMinutes(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const [h, m] = value.split(':');
  const hours = Number(h);
  const mins = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return fallback;
  return hours * 60 + mins;
}

export default function NotificationSettingsScreen() {
  const { t, formatNumber, formatTime } = useI18n();
  const theme = useTheme();
  const { preferences, updatePreferences } = useApp();

  const [capability, setCapability] = useState<NotificationCapability | null>(null);
  const [checking, setChecking] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [customLowStock, setCustomLowStock] = useState(
    LOW_STOCK_OPTIONS.every((days) => days !== preferences.lowStockThresholdDays),
  );
  const [customDays, setCustomDays] = useState(String(preferences.lowStockThresholdDays));
  const [customError, setCustomError] = useState<string | null>(null);

  const inspect = useCallback(async () => {
    setChecking(true);
    try {
      setCapability(await inspectCapability());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void inspect(); }, [inspect]);

  const askPermission = async () => {
    setRequesting(true);
    try {
      await requestPermission();
      await inspect();
    } finally {
      setRequesting(false);
    }
  };

  const saveCustomLowStock = () => {
    const days = Number(customDays);
    if (!Number.isInteger(days) || days < 1 || days > 60) {
      setCustomError(t('error.validation_failed'));
      return;
    }
    setCustomError(null);
    void updatePreferences({ lowStockThresholdDays: days });
  };

  // A wall-clock time rendered in the user's locale and numerals; the anchor
  // date is irrelevant, so it is formatted as UTC to avoid shifting the hour.
  const showTime = (value: string) => formatTime(`1970-01-01T${value}:00Z`, 'UTC');

  const quietEnabled = preferences.quietHoursStart !== null && preferences.quietHoursEnd !== null;
  const quietStart = localTimeToMinutes(preferences.quietHoursStart, 22 * 60);
  const quietEnd = localTimeToMinutes(preferences.quietHoursEnd, 7 * 60);

  const shiftQuiet = (which: 'start' | 'end', deltaMinutes: number) => {
    const next = which === 'start'
      ? { quietHoursStart: minutesToLocalTime(quietStart + deltaMinutes), quietHoursEnd: minutesToLocalTime(quietEnd) }
      : { quietHoursStart: minutesToLocalTime(quietStart), quietHoursEnd: minutesToLocalTime(quietEnd + deltaMinutes) };
    void updatePreferences(next);
  };

  const Choice = ({
    label, selected, onPress, hint,
  }: { label: string; selected: boolean; onPress: () => void; hint?: string }) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => [{
        minHeight: theme.touch,
        paddingHorizontal: theme.spacing.lg,
        justifyContent: 'center',
        borderRadius: theme.radius.pill,
        borderWidth: 2,
        borderColor: selected ? theme.colors.primary600 : theme.colors.ink200,
        backgroundColor: selected ? theme.colors.primary100 : theme.colors.surface,
        opacity: pressed ? 0.85 : 1,
      }]}
    >
      <Txt
        variant="bodyLarge"
        weight={selected ? 'bold' : 'regular'}
        color={selected ? theme.colors.primary700 : theme.colors.ink700}
      >
        {label}
      </Txt>
    </Pressable>
  );

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('settings.notifications')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        <SectionTitle>{t('notifications.statusTitle')}</SectionTitle>

        {checking && !capability ? (
          <Loading label={t('common.loading')} />
        ) : !capability || !capability.supported ? (
          <Banner tone="info" title={t('notifications.unsupportedTitle')} body={t('notifications.unsupportedBody')} />
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            {capability.permissionGranted ? (
              <Banner tone="success" title={t('notifications.permissionGranted')} />
            ) : (
              <Banner
                tone="danger"
                title={t('notifications.disabledTitle')}
                body={t('notifications.disabledBody')}
                action={
                  <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
                    <Button
                      label={t('notifications.enableButton')}
                      loading={requesting}
                      onPress={() => void askPermission()}
                    />
                    <Button
                      label={t('notifications.openSettings')}
                      tone="secondary"
                      onPress={() => { void Linking.openSettings(); }}
                    />
                  </View>
                }
              />
            )}

            {capability.permissionGranted && !capability.canScheduleExact ? (
              <Banner
                tone="warning"
                title={t('notifications.exactAlarmsOff')}
                body={t('notifications.exactAlarmsOffBody')}
                action={
                  <View style={{ marginTop: theme.spacing.sm }}>
                    <Button
                      label={t('notifications.openSettings')}
                      tone="secondary"
                      onPress={() => { void Linking.openSettings(); }}
                    />
                  </View>
                }
              />
            ) : null}

            {capability.permissionGranted && capability.canScheduleExact ? (
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notifications.exactAlarmsOn')}</Txt>
            ) : null}

            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notifications.silentModeNote')}</Txt>
            <Button
              label={t('notifications.recheck')}
              tone="ghost"
              loading={checking}
              onPress={() => void inspect()}
            />
          </View>
        )}

        {/*
          Placed high, immediately under the delivery status, rather than in a
          sub-page. A privacy control nobody finds protects nobody, and this one
          is the difference between a lock screen that names a diagnosis and one
          that does not. The default is off; the switch is what turns disclosure
          ON, and the warning under it says plainly what that means.
        */}
        <SectionTitle>{t('settings.notificationPrivacy')}</SectionTitle>
        <Txt variant="bodySmall" color={theme.colors.ink500}>
          {t('settings.notificationPrivacyHint')}
        </Txt>
        <Card>
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <Txt variant={theme.elderlyMode ? 'h3' : 'bodyLarge'} weight="medium">
                {t('settings.showMedicationInNotifications')}
              </Txt>
              {preferences.showMedicationInNotifications ? (
                <Txt variant="bodySmall" color={theme.colors.warning700}>
                  {t('settings.showMedicationWarning')}
                </Txt>
              ) : null}
            </View>
            <Switch
              value={preferences.showMedicationInNotifications}
              onValueChange={(next) => void updatePreferences({ showMedicationInNotifications: next })}
              accessibilityRole="switch"
              accessibilityLabel={t('settings.showMedicationInNotifications')}
              accessibilityHint={t('settings.showMedicationWarning')}
              trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
            />
          </Row>
        </Card>

        <SectionTitle>{t('notifications.snoozeTitle')}</SectionTitle>
        <Row gap={theme.spacing.sm} wrap>
          {SNOOZE_OPTIONS.map((minutes) => (
            <Choice
              key={minutes}
              label={minutes === 60 ? t('snooze.hour') : t('snooze.minutes', { minutes: formatNumber(minutes) })}
              selected={preferences.defaultSnoozeMinutes === minutes}
              onPress={() => void updatePreferences({ defaultSnoozeMinutes: minutes })}
            />
          ))}
        </Row>

        <SectionTitle>{t('notifications.quietHours')}</SectionTitle>
        <Card>
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <Txt variant="bodyLarge" weight="medium">
                {quietEnabled
                  ? t('notifications.quietHoursRange', {
                    start: showTime(minutesToLocalTime(quietStart)),
                    end: showTime(minutesToLocalTime(quietEnd)),
                  })
                  : t('notifications.quietHoursOff')}
              </Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notifications.quietHoursHint')}</Txt>
            </View>
            <Switch
              value={quietEnabled}
              accessibilityRole="switch"
              accessibilityLabel={t('notifications.quietHours')}
              accessibilityHint={t('notifications.quietHoursHint')}
              trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
              onValueChange={(next) => {
                void updatePreferences(next
                  ? { quietHoursStart: minutesToLocalTime(quietStart), quietHoursEnd: minutesToLocalTime(quietEnd) }
                  : { quietHoursStart: null, quietHoursEnd: null });
              }}
            />
          </Row>

          {quietEnabled ? (
            <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.md }}>
              {(['start', 'end'] as const).map((which) => (
                <View key={which} style={{ gap: theme.spacing.xs }}>
                  <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>
                    {which === 'start' ? t('notifications.quietStart') : t('notifications.quietEnd')}
                  </Txt>
                  <Row gap={theme.spacing.md}>
                    <View style={{ flex: 1 }}>
                      <Button
                        label="−"
                        tone="secondary"
                        onPress={() => shiftQuiet(which, -QUIET_STEP_MINUTES)}
                        accessibilityHint={which === 'start' ? t('notifications.quietStart') : t('notifications.quietEnd')}
                      />
                    </View>
                    <Txt variant="h3" weight="bold">
                      {showTime(minutesToLocalTime(which === 'start' ? quietStart : quietEnd))}
                    </Txt>
                    <View style={{ flex: 1 }}>
                      <Button
                        label="+"
                        tone="secondary"
                        onPress={() => shiftQuiet(which, QUIET_STEP_MINUTES)}
                        accessibilityHint={which === 'start' ? t('notifications.quietStart') : t('notifications.quietEnd')}
                      />
                    </View>
                  </Row>
                </View>
              ))}
            </View>
          ) : null}
        </Card>

        <SectionTitle>{t('notifications.lowStockTitle')}</SectionTitle>
        <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notifications.lowStockHint')}</Txt>
        <Row gap={theme.spacing.sm} wrap>
          {LOW_STOCK_OPTIONS.map((days) => (
            <Choice
              key={days}
              label={t('notifications.days', { count: formatNumber(days) })}
              selected={!customLowStock && preferences.lowStockThresholdDays === days}
              onPress={() => { setCustomLowStock(false); void updatePreferences({ lowStockThresholdDays: days }); }}
            />
          ))}
          <Choice
            label={t('notifications.customDays')}
            selected={customLowStock}
            onPress={() => {
              setCustomDays(String(preferences.lowStockThresholdDays));
              setCustomError(null);
              setCustomLowStock(true);
            }}
          />
        </Row>
        {customLowStock ? (
          <Card>
            <Field
              label={t('notifications.customDays')}
              value={customDays}
              onChangeText={(v) => { setCustomDays(v.replace(/[^0-9]/g, '')); setCustomError(null); }}
              keyboardType="number-pad"
              hint={t('notifications.lowStockHint')}
              error={customError}
              maxLength={2}
            />
            <Button label={t('common.save')} onPress={saveCustomLowStock} />
          </Card>
        ) : null}

        <SectionTitle>{t('notifications.expiryTitle')}</SectionTitle>
        <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notifications.expiryHint')}</Txt>
        <Row gap={theme.spacing.sm} wrap>
          {EXPIRY_OPTIONS.map((days) => (
            <Choice
              key={days}
              label={t('notifications.days', { count: formatNumber(days) })}
              selected={preferences.expiryWarningDays === days}
              onPress={() => void updatePreferences({ expiryWarningDays: days })}
            />
          ))}
        </Row>
      </Screen>
    </SafeAreaView>
  );
}
