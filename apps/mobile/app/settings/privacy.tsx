import React, { useCallback, useEffect, useState } from 'react';
import { Share, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, Divider, Loading, Row, SafetyNote, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { MESSAGES, type ConsentType, type MessageKey } from '@dawaee/shared';

/**
 * Privacy, consent and the account itself.
 *
 * Each switch says what granting it actually causes — which service receives
 * what — rather than a category name. A consent the user cannot picture is not
 * consent, and every one of these can be withdrawn here with the same tap that
 * granted it; the server reads the current value on every send.
 *
 * The deletion flow is two deliberate steps with the consequences stated
 * between them, and the export is offered right next to it, because the moment
 * someone decides to leave is the moment their data matters most to them.
 */

/**
 * Server error codes map to a localized message when we have one, and to the
 * generic message when the API grows a code this build has never heard of —
 * showing a raw code like `dose_already_resolved` to a patient is not an error
 * message.
 */
function useApiErrorText(): (err: ApiError) => string {
  const { t } = useI18n();
  return useCallback((err: ApiError) => {
    const key = `error.${err.code}`;
    return key in MESSAGES.en ? t(key as MessageKey) : t('error.internal_error');
  }, [t]);
}

const CONSENT_VERSION = '1.0';

interface ConsentRow {
  type: ConsentType;
  labelKey: MessageKey;
  hintKey: MessageKey;
}

const CONSENT_ROWS: ConsentRow[] = [
  // No WhatsApp or SMS rows: neither channel exists. Asking someone to consent
  // to a channel that cannot carry a message is a consent that means nothing,
  // and a toggle that changes nothing is worse than an absent one.
  { type: 'ocr_image_processing', labelKey: 'privacy.ocr', hintKey: 'privacy.ocrHint' },
  { type: 'caregiver_data_sharing', labelKey: 'privacy.caregiverSharing', hintKey: 'privacy.caregiverSharingHint' },
  { type: 'analytics', labelKey: 'privacy.analytics', hintKey: 'privacy.analyticsHint' },
];

interface MeResponse {
  consents: Array<{ type: string; granted: boolean; patientProfileId?: string | null }>;
}

interface FileSystemModule {
  Paths: { document: unknown };
  File: new (base: unknown, name: string) => {
    uri: string;
    write: (contents: string) => void;
  };
}

interface SharingModule {
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (url: string, options?: { mimeType?: string; dialogTitle?: string; UTI?: string }) => Promise<void>;
}

/**
 * Optional native modules, loaded the same way the notification layer does it:
 * inside a try/catch, so Expo Web — where neither exists — still renders this
 * screen and simply offers the share sheet instead.
 */
function optionalModule<T>(load: () => unknown): T | null {
  try {
    return load() as T;
  } catch {
    return null;
  }
}

export default function PrivacyScreen() {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { user, activeProfile, signOut } = useApp();
  const apiErrorText = useApiErrorText();
  const profileKey = profileScopeKey(user?.id, activeProfile);
  const { begin: beginConsentLoad } = useRequestScope(profileKey);
  const { begin: beginExport } = useRequestScope(profileKey);

  const [consentState, setConsentState] = useState<{
    scopeKey: string;
    values: Record<string, boolean>;
  } | null>(null);
  const consents = consentState?.scopeKey === profileKey ? consentState.values : null;
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConsent, setPendingConsent] = useState<ConsentType | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [deleteStep, setDeleteStep] = useState<0 | 1>(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const isCurrent = beginConsentLoad();
    const patientProfileId = activeProfile?.id ?? null;
    setLoading(true);
    setError(null);
    try {
      const me = await api.get<MeResponse>('/v1/me');
      if (!isCurrent()) return;

      // Account-level rows are a backwards-compatible default. A decision for
      // the selected profile overrides that default, while sibling profile rows
      // are ignored entirely regardless of database return order.
      const map: Record<string, boolean> = {};
      for (const consent of me.consents) {
        if (consent.patientProfileId == null) map[consent.type] = consent.granted;
      }
      if (patientProfileId) {
        for (const consent of me.consents) {
          if (consent.patientProfileId === patientProfileId) map[consent.type] = consent.granted;
        }
      }
      setConsentState({ scopeKey: profileKey, values: map });
      setOffline(false);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError) setError(apiErrorText(err));
      else setError(t('error.internal_error'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [activeProfile?.id, apiErrorText, beginConsentLoad, profileKey, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    // Export state belongs to the selected patient. A profile switch invalidates
    // both an in-flight export and any success/error state left by the old one.
    setExporting(false);
    setExportNotice(null);
    setExportError(null);
  }, [profileKey]);

  const setConsent = async (type: ConsentType, granted: boolean) => {
    if (!activeProfile) return;
    const consentScopeKey = profileKey;
    const patientProfileId = activeProfile.id;
    setPendingConsent(type);
    setError(null);
    // Optimistic: withdrawing a consent should look instant. Keep the state
    // attached to the profile that initiated the write so a late failure from
    // profile A can never overwrite profile B after a switch.
    setConsentState((current) => current?.scopeKey === consentScopeKey
      ? { scopeKey: consentScopeKey, values: { ...current.values, [type]: granted } }
      : current);
    try {
      await api.put('/v1/me/consents', {
        type, granted, version: CONSENT_VERSION, patientProfileId,
      });
    } catch (err) {
      setConsentState((current) => current?.scopeKey === consentScopeKey
        ? { scopeKey: consentScopeKey, values: { ...current.values, [type]: !granted } }
        : current);
      if (err instanceof NetworkError) setOffline(true);
      else setError(t('privacy.consentFailed'));
    } finally {
      setPendingConsent(null);
    }
  };

  const exportData = async () => {
    if (!activeProfile) return;
    const isCurrent = beginExport();
    const patientProfileId = activeProfile.id;
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const payload = await api.get<unknown>('/v1/reports/export', { profileId: patientProfileId });
      if (!isCurrent()) return;
      const json = JSON.stringify(payload, null, 2);
      const kilobytes = Math.max(1, Math.round(json.length / 1024));
      const fileName = `dawaee-export-${patientProfileId}.json`;

      const fileSystem = optionalModule<FileSystemModule>(() => require('expo-file-system'));
      const sharing = optionalModule<SharingModule>(() => require('expo-sharing'));
      const canShareFile = fileSystem?.Paths?.document && fileSystem?.File && sharing
        ? await sharing.isAvailableAsync()
        : false;
      if (!isCurrent()) return;

      if (canShareFile && fileSystem?.Paths?.document && fileSystem?.File && sharing) {
        // SDK 55's File/Paths API replaces documentDirectory + writeAsStringAsync.
        // Using the current API avoids a runtime throw from the legacy surface.
        const file = new fileSystem.File(fileSystem.Paths.document, fileName);
        file.write(json);
        if (!isCurrent()) return;
        await sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: t('settings.exportData') });
        if (!isCurrent()) return;
        setExportNotice(t('privacy.exportReady', { size: `${formatNumber(kilobytes)} KB` }));
        return;
      }

      // No file system to write to (Expo Web, or a build without the module):
      // hand the JSON to the platform share sheet instead of pretending a file
      // was saved.
      if (!isCurrent()) return;
      const result = await Share.share({ message: json, title: fileName });
      if (!isCurrent()) return;
      if (result.action === Share.dismissedAction) setExportNotice(null);
      else setExportNotice(t('privacy.exportReady', { size: `${formatNumber(kilobytes)} KB` }));
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError) setExportError(t('privacy.exportFailed'));
      else setExportError(t('privacy.exportShareUnavailable'));
    } finally {
      if (isCurrent()) setExporting(false);
    }
  };

  const requestDeletion = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.post('/v1/me/deletion-request', { confirm: true });
      setDeleteRequested(true);
      setDeleteStep(0);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setDeleteError(t('privacy.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('settings.privacy')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        {offline ? (
          <Banner
            tone="warning"
            title={t('notifications.offlineBanner')}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
          />
        ) : null}
        {error ? <Banner tone="danger" title={error} /> : null}

        <SectionTitle>{t('privacy.consents')}</SectionTitle>

        {loading && !consents ? (
          <Loading label={t('common.loading')} />
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {CONSENT_ROWS.map((row) => {
              const granted = consents?.[row.type] ?? false;
              return (
                <Card key={row.type}>
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                    <View style={{ flex: 1, gap: theme.spacing.xs }}>
                      <Txt variant="bodyLarge" weight="medium">{t(row.labelKey)}</Txt>
                      <Txt variant="bodySmall" color={theme.colors.ink500}>{t(row.hintKey)}</Txt>
                    </View>
                    <Switch
                      value={granted}
                      disabled={pendingConsent === row.type}
                      onValueChange={(next) => void setConsent(row.type, next)}
                      accessibilityRole="switch"
                      accessibilityLabel={t(row.labelKey)}
                      accessibilityHint={t(row.hintKey)}
                      trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
                    />
                  </Row>
                </Card>
              );
            })}
          </View>
        )}

        <SectionTitle>{t('privacy.storedTitle')}</SectionTitle>
        <Card>
          <Txt variant="body">{t('privacy.storedBody')}</Txt>
          <Divider />
          <Txt variant="bodySmall" weight="bold">{t('privacy.pdplTitle')}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('privacy.pdplBody')}</Txt>
        </Card>

        <SectionTitle>{t('settings.exportData')}</SectionTitle>
        <Card>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('privacy.exportHint')}</Txt>
          <Button
            label={exporting ? t('privacy.exporting') : t('settings.exportData')}
            tone="secondary"
            loading={exporting}
            disabled={!activeProfile}
            onPress={() => void exportData()}
          />
          {exportNotice ? <Banner tone="success" title={exportNotice} /> : null}
          {exportError ? <Banner tone="danger" title={exportError} /> : null}
        </Card>

        <SectionTitle>{t('settings.deleteAccount')}</SectionTitle>
        <Card>
          <Txt variant="body">{t('privacy.deleteWhat')}</Txt>
          <Txt variant="body" weight="bold" color={theme.colors.danger700}>{t('privacy.deleteCannotUndo')}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('privacy.deleteExportFirst')}</Txt>

          {deleteRequested ? (
            <>
              <Banner tone="success" title={t('privacy.deleteRequested')} />
              <Button label={t('settings.signOut')} tone="secondary" onPress={() => void signOut()} />
            </>
          ) : deleteStep === 0 ? (
            <Button
              label={t('privacy.deleteStep1')}
              tone="secondary"
              onPress={() => { setDeleteError(null); setDeleteStep(1); }}
            />
          ) : (
            <View style={{ gap: theme.spacing.sm }}>
              <Button
                label={t('privacy.deleteStep2')}
                tone="danger"
                loading={deleting}
                onPress={() => void requestDeletion()}
                accessibilityHint={t('privacy.deleteCannotUndo')}
              />
              <Button label={t('common.cancel')} tone="ghost" onPress={() => setDeleteStep(0)} />
            </View>
          )}

          {deleteError ? <Banner tone="danger" title={deleteError} /> : null}
        </Card>

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </Screen>
    </SafeAreaView>
  );
}
