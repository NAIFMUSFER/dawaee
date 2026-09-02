import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, Divider, Row, SafetyNote, Screen, SectionTitle, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { dir } from '@/theme';
import type { Locale } from '@dawaee/shared';

/**
 * The settings hub.
 *
 * Two rules shape this screen. First, every row is a destination, not a
 * control: nothing here changes the patient's data by being tapped, which
 * matters on a screen an unsteady hand scrolls through. Language is the single
 * exception — burying it one level down is exactly the trap the app's first
 * screen exists to avoid.
 *
 * Second, elderly mode shows fewer rows rather than smaller ones. The advanced
 * rows are still reachable, behind one deliberate tap, so nothing is taken away
 * from a user who wants it.
 */

interface SettingsRow {
  key: string;
  label: string;
  hint?: string;
  value?: string;
  essential: boolean;
  onPress: () => void;
}

export default function SettingsScreen() {
  const { t, isRtl, bidi } = useI18n();
  const theme = useTheme();
  const {
    user, preferences, profiles, activeProfile, setActiveProfile,
    updatePreferences, restartRequiredForRtl, offline, signOut,
  } = useApp();

  const [showAll, setShowAll] = useState(false);
  const simplified = theme.elderlyMode && !showAll;

  const chooseLocale = async (locale: Locale) => {
    if (locale === preferences.locale) return;
    await updatePreferences({ locale });
  };

  const rowHeight = theme.elderlyMode ? theme.touch * 1.2 : theme.touch;

  const NavRow = ({ row }: { row: SettingsRow }) => (
    <Pressable
      onPress={row.onPress}
      accessibilityRole="button"
      accessibilityLabel={row.label}
      accessibilityHint={row.hint}
      style={({ pressed }) => [{
        minHeight: rowHeight,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surface,
        borderWidth: theme.hairline,
        borderColor: theme.colors.ink100,
        justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      }]}
    >
      <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant={theme.elderlyMode ? 'h3' : 'bodyLarge'} weight="medium">{row.label}</Txt>
          {row.hint && !simplified ? (
            <Txt variant="bodySmall" color={theme.colors.ink500}>{row.hint}</Txt>
          ) : null}
        </View>
        {row.value ? <Txt variant="bodySmall" color={theme.colors.ink500}>{row.value}</Txt> : null}
        <Txt variant="h3" color={theme.colors.ink300}>{dir.forwardIcon(isRtl)}</Txt>
      </Row>
    </Pressable>
  );

  const renderRows = (rows: SettingsRow[]) => {
    const visible = simplified ? rows.filter((r) => r.essential) : rows;
    if (visible.length === 0) return null;
    return (
      <View style={{ gap: theme.spacing.sm }}>
        {visible.map((row) => <NavRow key={row.key} row={row} />)}
      </View>
    );
  };

  const accessibilityRows: SettingsRow[] = [
    {
      key: 'accessibility',
      label: t('settings.accessibility'),
      hint: t('settings.accessibilityHint'),
      essential: true,
      onPress: () => router.push('/settings/accessibility'),
    },
    {
      key: 'app-lock',
      label: t('settings.appLock'),
      hint: t('settings.appLockHint'),
      value: preferences.appLockEnabled ? t('common.on') : t('common.off'),
      essential: false,
      onPress: () => router.push('/settings/app-lock'),
    },
  ];

  const notificationRows: SettingsRow[] = [
    {
      key: 'notifications',
      label: t('settings.notifications'),
      hint: t('settings.notificationsHint'),
      essential: true,
      onPress: () => router.push('/settings/notifications'),
    },
    {
      key: 'travel',
      label: t('settings.travelMode'),
      hint: t('settings.travelHint'),
      essential: false,
      onPress: () => router.push('/settings/travel'),
    },
  ];

  const familyRows: SettingsRow[] = [
    {
      key: 'family',
      label: t('family.title'),
      hint: t('settings.familyHint'),
      essential: true,
      onPress: () => router.push('/(tabs)/family'),
    },
    {
      key: 'emergency',
      label: t('emergency.title'),
      hint: t('settings.emergencyHint'),
      essential: true,
      onPress: () => router.push('/settings/emergency'),
    },
    {
      key: 'emergency-qr',
      label: t('emergency.qr'),
      hint: t('emergency.qrWhatIsShown'),
      essential: false,
      onPress: () => router.push('/settings/emergency-qr'),
    },
  ];

  const privacyRows: SettingsRow[] = [
    {
      key: 'privacy',
      label: t('settings.privacy'),
      hint: t('settings.privacyHint'),
      essential: false,
      onPress: () => router.push('/settings/privacy'),
    },
  ];

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h1" weight="bold" accessibilityRole="header">{t('settings.title')}</Txt>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {restartRequiredForRtl ? <Banner tone="info" title={t('settings.restartRequired')} /> : null}

        {profiles.length > 1 ? (
          <>
            <SectionTitle>{t('settings.profiles')}</SectionTitle>
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('settings.switchProfile')}</Txt>
            <View style={{ gap: theme.spacing.sm }}>
              {profiles.map((profile) => {
                const active = profile.id === activeProfile?.id;
                return (
                  <Card
                    key={profile.id}
                    onPress={() => setActiveProfile(profile.id)}
                    accessibilityLabel={t('settings.activeProfile', { name: profile.displayName })}
                    style={{
                      minHeight: rowHeight,
                      borderColor: active ? theme.colors.primary600 : theme.colors.ink100,
                      borderWidth: active ? 2 : theme.hairline,
                      justifyContent: 'center',
                    }}
                  >
                    <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                      <View style={{ flex: 1, gap: theme.spacing.xs }}>
                        <Txt variant={theme.elderlyMode ? 'h3' : 'bodyLarge'} weight="medium">
                          {profile.displayName}
                        </Txt>
                        {profile.isSelf ? (
                          <Badge label={t('settings.profileSelf')} fg={theme.colors.ink700} bg={theme.colors.ink100} />
                        ) : null}
                      </View>
                      {active ? (
                        <Badge label={t('common.on')} fg={theme.colors.primary700} bg={theme.colors.primary100} />
                      ) : null}
                    </Row>
                  </Card>
                );
              })}
            </View>
          </>
        ) : null}

        <SectionTitle>{t('settings.language')}</SectionTitle>
        <Row gap={theme.spacing.md}>
          <View style={{ flex: 1 }}>
            <Button
              label="العربية"
              size={theme.elderlyMode ? 'large' : 'regular'}
              tone={preferences.locale === 'ar' ? 'primary' : 'secondary'}
              onPress={() => void chooseLocale('ar')}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="English"
              size={theme.elderlyMode ? 'large' : 'regular'}
              tone={preferences.locale === 'en' ? 'primary' : 'secondary'}
              onPress={() => void chooseLocale('en')}
            />
          </View>
        </Row>

        <SectionTitle>{t('settings.accessibility')}</SectionTitle>
        {renderRows(accessibilityRows)}

        <SectionTitle>{t('settings.notifications')}</SectionTitle>
        {renderRows(notificationRows)}

        <SectionTitle>{t('family.title')}</SectionTitle>
        {renderRows(familyRows)}

        {simplified ? null : (
          <>
            <SectionTitle>{t('settings.privacy')}</SectionTitle>
            {renderRows(privacyRows)}
          </>
        )}

        <SectionTitle>{t('settings.account')}</SectionTitle>
        <Card>
          <Txt variant="body">{t('settings.signedInAs', { name: user?.displayName ?? '' })}</Txt>
          {user?.phoneE164 ? (
            <Txt variant="bodySmall" color={theme.colors.ink500}>{bidi(user.phoneE164 ?? "")}</Txt>
          ) : null}
          <Divider />
          <Button label={t('settings.signOut')} tone="secondary" onPress={() => void signOut()} />
        </Card>

        {theme.elderlyMode ? (
          <Button
            label={showAll ? t('settings.showFewerOptions') : t('settings.showAllOptions')}
            tone="ghost"
            onPress={() => setShowAll((v) => !v)}
            accessibilityHint={t('settings.simplifiedNotice')}
          />
        ) : null}

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </Screen>
    </SafeAreaView>
  );
}
