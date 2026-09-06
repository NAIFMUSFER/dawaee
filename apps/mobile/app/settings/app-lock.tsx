import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Loading, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import type { MessageKey } from '@dawaee/shared';
import { loadLocalAuthentication } from '@/security/local-auth';

/**
 * Biometric app lock.
 *
 * `expo-local-authentication` is loaded lazily inside a try/catch, exactly like
 * the notification layer: on Expo Web, or in a build without the module, the
 * screen still renders and says why the lock cannot be offered instead of
 * throwing on import.
 *
 * The app never receives biometric data. The operating system performs the
 * check and returns a boolean; nothing is stored by Dawaee, on the device or on
 * the server, and the screen says so where the user can read it.
 *
 * Turning the lock ON requires a successful verification — otherwise it is
 * possible to lock yourself out with a sensor that does not actually work.
 * Turning it OFF does not, because someone already holding an unlocked phone
 * gains nothing from the second prompt, while a patient whose fingerprint has
 * stopped being recognised would be trapped by it.
 */

const LOCK_AREAS = ['history', 'caregivers', 'personal', 'reports', 'emergency'] as const;
type LockArea = (typeof LOCK_AREAS)[number];

const AREA_LABEL_KEYS: Record<LockArea, MessageKey> = {
  history: 'applock.area.history',
  caregivers: 'applock.area.caregivers',
  personal: 'applock.area.personal',
  reports: 'applock.area.reports',
  emergency: 'applock.area.emergency',
};

type Availability =
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'unavailable'; reasonKey: MessageKey };

export default function AppLockScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { preferences, updatePreferences } = useApp();

  const [availability, setAvailability] = useState<Availability>({ state: 'checking' });
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setAvailability({ state: 'checking' });
    const auth = loadLocalAuthentication();
    if (!auth) {
      setAvailability({
        state: 'unavailable',
        reasonKey: Platform.OS === 'web' ? 'applock.unavailableWeb' : 'applock.noHardware',
      });
      return;
    }
    try {
      if (!(await auth.hasHardwareAsync())) {
        setAvailability({ state: 'unavailable', reasonKey: 'applock.noHardware' });
        return;
      }
      if (!(await auth.isEnrolledAsync())) {
        setAvailability({ state: 'unavailable', reasonKey: 'applock.notEnrolled' });
        return;
      }
      setAvailability({ state: 'ready' });
    } catch {
      setAvailability({ state: 'unavailable', reasonKey: 'applock.noHardware' });
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const toggleLock = async (next: boolean) => {
    setVerifyError(null);
    if (!next) {
      await updatePreferences({ appLockEnabled: false });
      return;
    }
    const auth = loadLocalAuthentication();
    if (!auth) {
      setVerifyError(t('applock.unavailableTitle'));
      return;
    }
    setVerifying(true);
    try {
      const result = await auth.authenticateAsync({
        promptMessage: t('applock.testPrompt'),
        cancelLabel: t('common.cancel'),
      });
      if (!result.success) {
        setVerifyError(t('applock.testFailed'));
        return;
      }
      await updatePreferences({ appLockEnabled: true });
    } catch {
      setVerifyError(t('applock.testFailed'));
    } finally {
      setVerifying(false);
    }
  };

  const toggleArea = (area: LockArea, enabled: boolean) => {
    const current = preferences.appLockAreas.filter((a): a is LockArea =>
      (LOCK_AREAS as readonly string[]).includes(a));
    const next = enabled ? [...new Set([...current, area])] : current.filter((a) => a !== area);
    void updatePreferences({ appLockAreas: next });
  };

  const areaSelected = (area: LockArea) => preferences.appLockAreas.includes(area);
  const unavailable = availability.state === 'unavailable';

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('settings.appLock')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {availability.state === 'checking' ? <Loading label={t('common.loading')} /> : null}

        {unavailable ? (
          <Banner
            tone="info"
            title={t('applock.unavailableTitle')}
            body={t(availability.reasonKey)}
            action={<Button label={t('notifications.recheck')} tone="ghost" onPress={() => void check()} />}
          />
        ) : null}

        {verifyError ? <Banner tone="danger" title={verifyError} /> : null}

        <Card>
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <Txt variant={theme.elderlyMode ? 'h3' : 'bodyLarge'} weight="medium">{t('settings.biometric')}</Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('applock.requireBiometric')}</Txt>
            </View>
            <Switch
              value={preferences.appLockEnabled}
              disabled={unavailable || verifying || availability.state === 'checking'}
              onValueChange={(next) => void toggleLock(next)}
              accessibilityRole="switch"
              accessibilityLabel={t('settings.biometric')}
              accessibilityHint={t('applock.requireBiometric')}
              trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
            />
          </Row>
        </Card>

        <Banner tone="info" title={t('applock.neverStored')} />

        <SectionTitle>{t('applock.areasTitle')}</SectionTitle>
        <Txt variant="bodySmall" color={theme.colors.ink500}>
          {preferences.appLockEnabled ? t('applock.areasHint') : t('applock.enableFirst')}
        </Txt>

        <View style={{ gap: theme.spacing.sm }}>
          {LOCK_AREAS.map((area) => (
            <Card key={area}>
              <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                <Txt variant="bodyLarge" style={{ flex: 1 }}>{t(AREA_LABEL_KEYS[area])}</Txt>
                <Switch
                  value={areaSelected(area)}
                  disabled={!preferences.appLockEnabled}
                  onValueChange={(next) => toggleArea(area, next)}
                  accessibilityRole="switch"
                  accessibilityLabel={t(AREA_LABEL_KEYS[area])}
                  accessibilityHint={t('applock.areasHint')}
                  trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
                />
              </Row>
              {area === 'emergency' && areaSelected('emergency') ? (
                <Txt variant="bodySmall" color={theme.colors.warning700}>{t('applock.emergencyWarning')}</Txt>
              ) : null}
            </Card>
          ))}
        </View>
      </Screen>
    </SafeAreaView>
  );
}
