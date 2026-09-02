import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Field, Row, SafetyNote, Screen, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { ProfileSummary } from '@/api/types';
import { inspectCapability, requestPermission } from '@/notifications';
import { typeSize } from '@dawaee/shared';

/**
 * First-run setup.
 *
 * One question per screen, in the order that determines what the rest of the
 * app looks like: who it is for, what to call them, how big everything should
 * be, and whether reminders may reach the phone. Nothing is asked that the app
 * can infer, and nothing that can wait until it is actually needed.
 *
 * The elderly-mode step applies immediately rather than on "next", so the
 * answer to "is this big enough?" is the screen the user is already looking at.
 */

type Step = 'who' | 'name' | 'elderly' | 'notifications' | 'done';
const STEPS: Step[] = ['who', 'name', 'elderly', 'notifications', 'done'];

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh';
  } catch {
    return 'Asia/Riyadh';
  }
}

export default function OnboardingScreen() {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { user, profiles, preferences, updatePreferences, refreshProfiles, setActiveProfile } = useApp();

  const [step, setStep] = useState<Step>('who');
  const [forSelf, setForSelf] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionOutcome, setPermissionOutcome] = useState<'granted' | 'denied' | 'unsupported' | null>(null);
  const [requesting, setRequesting] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  const goTo = (next: Step) => {
    setError(null);
    setStep(next);
  };

  /**
   * Creates whatever profiles the answers imply: always one for the account
   * holder, plus a second one when they are setting the app up for someone
   * else. The cared-for profile becomes the active one, because that is whose
   * medication the next screens are about.
   */
  const createProfiles = useCallback(async () => {
    const timezone = deviceTimezone();
    const trimmed = name.trim();
    let selected: ProfileSummary | null = null;

    const existingSelf = profiles.find((p) => p.isSelf) ?? null;
    if (!existingSelf) {
      const res = await api.post<{ profile: ProfileSummary }>('/v1/profiles', {
        displayName: forSelf ? trimmed : (user?.displayName ?? trimmed),
        timezone,
        isSelf: true,
      });
      selected = res.profile;
    } else {
      selected = existingSelf;
    }

    if (!forSelf) {
      const res = await api.post<{ profile: ProfileSummary }>('/v1/profiles', {
        displayName: trimmed,
        timezone,
        isSelf: false,
      });
      selected = res.profile;
    }

    await refreshProfiles();
    if (selected) setActiveProfile(selected.id);
  }, [forSelf, name, profiles, refreshProfiles, setActiveProfile, user?.displayName]);

  const submitName = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError(t('onboarding.nameRequired'));
      return;
    }
    setNameError(null);
    setSaving(true);
    setError(null);
    try {
      await createProfiles();
      goTo('elderly');
    } catch (err) {
      if (err instanceof NetworkError) setError(t('notifications.offlineBanner'));
      else if (err instanceof ApiError) setError(t('onboarding.profileFailed'));
      else setError(t('error.internal_error'));
    } finally {
      setSaving(false);
    }
  };

  const askForNotifications = async () => {
    setRequesting(true);
    try {
      const capability = await inspectCapability();
      if (!capability.supported) {
        setPermissionOutcome('unsupported');
        return;
      }
      const granted = capability.permissionGranted ? true : await requestPermission();
      setPermissionOutcome(granted ? 'granted' : 'denied');
    } finally {
      setRequesting(false);
    }
  };

  // The preview renders at the size the choice would produce, without waiting
  // for the preference round-trip.
  const previewSizes = useMemo(() => ({
    title: typeSize('h2', { elderlyMode: preferences.elderlyMode, textScale: preferences.textScale }),
    body: typeSize('body', { elderlyMode: preferences.elderlyMode, textScale: preferences.textScale }),
  }), [preferences.elderlyMode, preferences.textScale]);

  const progress = (
    <View style={{ gap: theme.spacing.sm }}>
      <Txt variant="caption" color={theme.colors.ink500}>
        {t('onboarding.stepOf', { current: formatNumber(stepIndex + 1), total: formatNumber(STEPS.length) })}
      </Txt>
      <Row gap={theme.spacing.xs}>
        {STEPS.map((s, index) => (
          <View
            key={s}
            style={{
              flex: 1,
              height: 6,
              borderRadius: theme.radius.pill,
              backgroundColor: index <= stepIndex ? theme.colors.primary600 : theme.colors.ink100,
            }}
          />
        ))}
      </Row>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        {progress}

        {error ? <Banner tone="danger" title={error} /> : null}

        {step === 'who' ? (
          <View style={{ gap: theme.spacing.lg }}>
            <Txt variant="h1" weight="bold" accessibilityRole="header">{t('onboarding.whoTitle')}</Txt>
            <Txt variant="body" color={theme.colors.ink500}>{t('onboarding.whoBody')}</Txt>
            <Button
              label={t('onboarding.forMyself')}
              size="large"
              tone={forSelf === true ? 'primary' : 'secondary'}
              onPress={() => { setForSelf(true); setName(user?.displayName ?? ''); goTo('name'); }}
            />
            <Button
              label={t('onboarding.forSomeoneElse')}
              size="large"
              tone={forSelf === false ? 'primary' : 'secondary'}
              onPress={() => { setForSelf(false); setName(''); goTo('name'); }}
            />
          </View>
        ) : null}

        {step === 'name' ? (
          <View style={{ gap: theme.spacing.lg }}>
            <Txt variant="h1" weight="bold" accessibilityRole="header">
              {forSelf ? t('onboarding.nameTitleSelf') : t('onboarding.nameTitleOther')}
            </Txt>
            <Field
              label={forSelf ? t('onboarding.nameTitleSelf') : t('onboarding.nameTitleOther')}
              value={name}
              onChangeText={(v) => { setName(v); if (nameError) setNameError(null); }}
              hint={t('onboarding.nameHint')}
              error={nameError}
              autoFocus
              maxLength={80}
            />
            <Button
              label={saving ? t('onboarding.creatingProfile') : t('common.next')}
              size="large"
              loading={saving}
              onPress={() => void submitName()}
            />
            <Button label={t('common.back')} tone="ghost" onPress={() => goTo('who')} />
          </View>
        ) : null}

        {step === 'elderly' ? (
          <View style={{ gap: theme.spacing.lg }}>
            <Txt variant="h1" weight="bold" accessibilityRole="header">{t('onboarding.elderlyTitle')}</Txt>
            <Txt variant="body" color={theme.colors.ink500}>{t('settings.elderlyModeHint')}</Txt>

            <Card>
              <Txt variant="caption" color={theme.colors.ink500}>{t('accessibility.livePreview')}</Txt>
              <Txt style={{ fontSize: previewSizes.title, lineHeight: theme.lineHeight(previewSizes.title) }} weight="bold">
                {t('accessibility.sampleName')}
              </Txt>
              <Txt
                style={{ fontSize: previewSizes.body, lineHeight: theme.lineHeight(previewSizes.body) }}
                color={theme.colors.ink500}
              >
                {t('today.nextMedication')}
              </Txt>
            </Card>

            <Button
              label={t('onboarding.elderlyOn')}
              size="large"
              tone={preferences.elderlyMode ? 'primary' : 'secondary'}
              onPress={() => void updatePreferences({ elderlyMode: true })}
            />
            <Button
              label={t('onboarding.elderlyOff')}
              size="large"
              tone={preferences.elderlyMode ? 'secondary' : 'primary'}
              onPress={() => void updatePreferences({ elderlyMode: false })}
            />
            <Button label={t('common.next')} onPress={() => goTo('notifications')} />
          </View>
        ) : null}

        {step === 'notifications' ? (
          <View style={{ gap: theme.spacing.lg }}>
            <Txt variant="h1" weight="bold" accessibilityRole="header">{t('onboarding.notificationsTitle')}</Txt>
            <Txt variant="body">{t('onboarding.notificationsBody')}</Txt>
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notifications.silentModeNote')}</Txt>

            {permissionOutcome === 'granted' ? (
              <Banner tone="success" title={t('notifications.permissionGranted')} />
            ) : null}
            {permissionOutcome === 'denied' ? (
              <Banner
                tone="warning"
                title={t('notifications.disabledTitle')}
                body={t('onboarding.notificationsDenied')}
              />
            ) : null}
            {permissionOutcome === 'unsupported' ? (
              <Banner
                tone="info"
                title={t('notifications.unsupportedTitle')}
                body={t('onboarding.notificationsUnsupported')}
              />
            ) : null}

            {permissionOutcome === null ? (
              <Button
                label={t('onboarding.notificationsAllow')}
                size="large"
                loading={requesting}
                onPress={() => void askForNotifications()}
              />
            ) : null}
            <Button
              label={permissionOutcome === null ? t('common.notNow') : t('common.next')}
              tone={permissionOutcome === null ? 'ghost' : 'primary'}
              onPress={() => goTo('done')}
            />
          </View>
        ) : null}

        {step === 'done' ? (
          <View style={{ gap: theme.spacing.lg }}>
            <Txt variant="h1" weight="bold" accessibilityRole="header">{t('onboarding.doneTitle')}</Txt>
            <Txt variant="body" color={theme.colors.ink500}>{t('onboarding.doneBody')}</Txt>
            <Button
              label={t('onboarding.finish')}
              size="large"
              onPress={() => router.replace('/(tabs)/today')}
            />
          </View>
        ) : null}

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </Screen>
    </SafeAreaView>
  );
}
