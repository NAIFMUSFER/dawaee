import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Row, Screen, Txt } from '@/components/ui';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import type { MessageKey } from '@dawaee/shared';

interface Option {
  key: string;
  glyph: string;
  labelKey: MessageKey;
  hintKey: MessageKey;
  route: string;
}

const SECONDARY: readonly Option[] = [
  { key: 'upload', glyph: '🖼️', labelKey: 'medication.uploadImage', hintKey: 'medication.uploadImageHint', route: '/medication/capture?mode=upload' },
  { key: 'barcode', glyph: '🏷️', labelKey: 'medication.scanBarcode', hintKey: 'medication.scanBarcodeHint', route: '/medication/capture?mode=barcode' },
  { key: 'prescription', glyph: '📄', labelKey: 'medication.scanPrescription', hintKey: 'medication.scanPrescriptionHint', route: '/medication/capture?mode=prescription' },
];

export default function AddMedicationScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { activeProfile, preferences } = useApp();
  const arabic = preferences.locale === 'ar';
  const canAdd = Boolean(activeProfile && (activeProfile.isSelf || activeProfile.permissions?.includes('add_medication')));

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('medication.add')}</Txt>
        <ProfileSwitcher />
        {activeProfile ? (
          <Banner
            tone="info"
            title={arabic ? `إضافة الدواء إلى ملف: ${activeProfile.displayName}` : `Adding medication to: ${activeProfile.displayName}`}
            body={activeProfile.isSelf
              ? (arabic ? 'هذا هو ملفك الشخصي.' : 'This is your own profile.')
              : (arabic ? 'أنت تعمل الآن داخل ملف شخص تتابعه.' : 'You are working in a profile you care for.')}
          />
        ) : null}
        {!canAdd ? (
          <Banner
            tone="warning"
            title={arabic ? 'لا تملك صلاحية إضافة دواء لهذا الملف' : 'You cannot add medication to this profile'}
            body={arabic ? 'يمكنك عرض بيانات هذا المريض فقط حسب الصلاحيات الممنوحة لك.' : 'Your current caregiver permissions allow viewing only.'}
          />
        ) : null}
        <Txt variant="body" color={theme.colors.ink500}>{t('medication.addHow')}</Txt>

        {canAdd ? (
          <>
            <Card
              onPress={() => router.push('/medication/capture?mode=photo')}
              accessibilityLabel={`${t('medication.takePhoto')}. ${t('medication.takePhotoHint')}`}
              style={{
                backgroundColor: theme.colors.primary700,
                borderColor: theme.colors.primary700,
                paddingVertical: theme.spacing.xl,
                gap: theme.spacing.md,
              }}
            >
              <Txt variant="display" align="center">📷</Txt>
              <Txt variant="h2" weight="bold" align="center" color={theme.colors.surface}>{t('medication.takePhoto')}</Txt>
              <Txt variant="body" align="center" color={theme.colors.primary100}>{t('medication.takePhotoHint')}</Txt>
            </Card>

            {!theme.elderlyMode
              ? SECONDARY.map((option) => (
                <Card
                  key={option.key}
                  onPress={() => router.push(option.route)}
                  accessibilityLabel={`${t(option.labelKey)}. ${t(option.hintKey)}`}
                >
                  <Row gap={theme.spacing.md} align="center">
                    <Txt variant="h1">{option.glyph}</Txt>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt variant="bodyLarge" weight="bold">{t(option.labelKey)}</Txt>
                      <Txt variant="bodySmall" color={theme.colors.ink500}>{t(option.hintKey)}</Txt>
                    </View>
                  </Row>
                </Card>
              ))
              : null}

            <Card
              onPress={() => router.push('/medication/quick-create')}
              accessibilityLabel={`${t('medication.manualEntry')}. ${t('medication.manualEntryHint')}`}
            >
              <Row gap={theme.spacing.md} align="center">
                <Txt variant="h1">⌨️</Txt>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt variant="bodyLarge" weight="bold">{t('medication.manualEntry')}</Txt>
                  <Txt variant="bodySmall" color={theme.colors.ink500}>{t('medication.manualEntryHint')}</Txt>
                </View>
              </Row>
            </Card>
          </>
        ) : null}

        <Button label={t('common.cancel')} tone="ghost" onPress={() => router.back()} />
      </Screen>
    </SafeAreaView>
  );
}
