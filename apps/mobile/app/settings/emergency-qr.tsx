import React, { useCallback, useEffect, useState } from 'react';
import { Clipboard, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, EmptyState, Loading, Row, SafetyNote, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { QrCode, encodeQr } from '@/components/QrCode';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { profileScopeKey } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { MESSAGES, type MessageKey } from '@dawaee/shared';

/**
 * The emergency QR.
 *
 * This is the only surface in the product that anyone can read without signing
 * in, so the screen is built around informed consent: what a scan returns is
 * spelled out before the code can be created, the disable button is present and
 * prominent whenever the code is live, and rotating says plainly that every
 * printed copy stops working.
 *
 * The link itself is shown exactly once, at creation. The server stores only a
 * hash of the token, which is what keeps a database read from becoming a
 * scannable card — the honest consequence is that a code cannot be re-displayed
 * later, only replaced.
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

interface EmergencyCardState {
  includeMedications: boolean;
  includeAllergies: boolean;
  includeContacts: boolean;
  qrEnabled: boolean;
  qrViewCount: number;
  qrLastViewedAt: string | null;
}

export default function EmergencyQrScreen() {
  const { user, activeProfile } = useApp();
  return <EmergencyQrView key={profileScopeKey(user?.id, activeProfile)} />;
}

function EmergencyQrView() {
  const { t, formatNumber, formatDate } = useI18n();
  const theme = useTheme();
  const { activeProfile } = useApp();
  const apiErrorText = useApiErrorText();

  const [card, setCard] = useState<EmergencyCardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ card: EmergencyCardState | null }>('/v1/emergency/card', {
        profileId: activeProfile.id,
      });
      setCard(res.card);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError) setError(apiErrorText(err));
      else setError(t('error.internal_error'));
    } finally {
      setLoading(false);
    }
  }, [activeProfile, apiErrorText, t]);

  useEffect(() => { void load(); }, [load]);

  const enable = async () => {
    if (!activeProfile) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api.post<{ enabled: boolean; qrUrl: string }>(
        '/v1/emergency/qr/enable', undefined, { profileId: activeProfile.id },
      );
      setQrUrl(res.qrUrl);
      setCard((current) => (current ? { ...current, qrEnabled: true, qrViewCount: 0, qrLastViewedAt: null } : current));
      await load();
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(t('emergency.qrEnableFailed'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!activeProfile) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/emergency/qr/disable', undefined, { profileId: activeProfile.id });
      setQrUrl(null);
      setCard((current) => (current ? { ...current, qrEnabled: false } : current));
      await load();
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else setError(t('error.internal_error'));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    if (!qrUrl) return;
    Clipboard.setString(qrUrl);
    setCopied(true);
  };

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen><EmptyState title={t('settings.switchProfile')} /></Screen>
      </SafeAreaView>
    );
  }

  const enabled = card?.qrEnabled ?? false;
  const qrSize = theme.elderlyMode ? 300 : 248;
  const drawable = qrUrl !== null && encodeQr(qrUrl) !== null;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('emergency.qr')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        <Banner tone="info" title={t('emergency.userProvided')} />

        {offline ? (
          <Banner
            tone="warning"
            title={t('notifications.offlineBanner')}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
          />
        ) : null}
        {error ? <Banner tone="danger" title={error} /> : null}

        {loading && !card ? <Loading label={t('common.loading')} /> : null}

        <SectionTitle>{t('emergency.qrWhatIsShown')}</SectionTitle>
        <Card>
          <Txt variant="body">{t('emergency.qrWhatIsShownBody')}</Txt>
          {card ? (
            <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.sm }}>
              <Txt variant="bodySmall" color={card.includeMedications ? theme.colors.ink900 : theme.colors.ink300}>
                {`${t('emergency.includeMedications')} — ${card.includeMedications ? t('common.on') : t('common.off')}`}
              </Txt>
              <Txt variant="bodySmall" color={card.includeAllergies ? theme.colors.ink900 : theme.colors.ink300}>
                {`${t('emergency.includeAllergies')} — ${card.includeAllergies ? t('common.on') : t('common.off')}`}
              </Txt>
              <Txt variant="bodySmall" color={card.includeContacts ? theme.colors.ink900 : theme.colors.ink300}>
                {`${t('emergency.includeContacts')} — ${card.includeContacts ? t('common.on') : t('common.off')}`}
              </Txt>
              <Button
                label={t('common.edit')}
                tone="ghost"
                fullWidth={false}
                onPress={() => router.push('/settings/emergency')}
              />
            </View>
          ) : null}
        </Card>

        <SectionTitle>{enabled ? t('emergency.qrEnabledState') : t('emergency.qrDisabledState')}</SectionTitle>

        {enabled ? (
          <Card>
            <Txt variant="body">
              {t('emergency.qrViews', { count: formatNumber(card?.qrViewCount ?? 0) })}
            </Txt>
            <Txt variant="bodySmall" color={theme.colors.ink500}>
              {card?.qrLastViewedAt
                ? t('emergency.qrLastViewed', {
                  time: formatDate(card.qrLastViewedAt, activeProfile.timezone, {
                    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
                  }),
                })
                : t('emergency.qrNeverViewed')}
            </Txt>
          </Card>
        ) : null}

        {qrUrl ? (
          <Card style={{ alignItems: 'center', gap: theme.spacing.md }}>
            {drawable ? (
              <QrCode
                value={qrUrl}
                size={qrSize}
                accessibilityLabel={t('emergency.qr')}
              />
            ) : (
              <Banner tone="warning" title={t('emergency.qrImageUnavailable')} />
            )}

            <Txt variant="caption" color={theme.colors.ink500}>{t('emergency.qrLink')}</Txt>
            <Text
              selectable
              accessibilityLabel={t('emergency.qrLink')}
              style={{
                fontSize: theme.font.bodyLarge,
                lineHeight: theme.lineHeight(theme.font.bodyLarge),
                color: theme.colors.ink900,
                textAlign: 'center',
                // A URL reads left-to-right even inside an Arabic layout.
                writingDirection: 'ltr',
              }}
            >
              {qrUrl}
            </Text>

            <Button label={t('emergency.qrCopy')} tone="secondary" onPress={copyLink} />
            {copied ? <Txt variant="bodySmall" color={theme.colors.success700}>{t('emergency.qrCopied')}</Txt> : null}
            <Txt variant="caption" color={theme.colors.ink500}>{t('emergency.qrTokenOnce')}</Txt>
          </Card>
        ) : enabled ? (
          <Banner tone="info" title={t('emergency.qrTokenOnce')} body={t('emergency.qrRotateWarning')} />
        ) : null}

        {enabled ? (
          <>
            <Button
              label={t('emergency.qrDisable')}
              tone="danger"
              size="large"
              loading={busy}
              onPress={() => void disable()}
              accessibilityHint={t('emergency.qrDisabledState')}
            />
            <Button
              label={t('emergency.qrRotate')}
              tone="secondary"
              loading={busy}
              onPress={() => void enable()}
              accessibilityHint={t('emergency.qrRotateWarning')}
            />
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('emergency.qrRotateWarning')}</Txt>
          </>
        ) : (
          <Button
            label={t('emergency.qrEnable')}
            size="large"
            loading={busy}
            onPress={() => void enable()}
            accessibilityHint={t('emergency.qrWhatIsShownBody')}
          />
        )}

        <SafetyNote textKey="emergency.userProvided" />
      </Screen>
    </SafeAreaView>
  );
}
