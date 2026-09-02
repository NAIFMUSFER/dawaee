import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, Divider, EmptyState, Loading, Row, SafetyNote, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { errorMessageKey, type MessageKey } from '@dawaee/shared';
import { addDays } from '@dawaee/core';

/**
 * The reports hub.
 *
 * Three reports, three different readers: the family who want a weekly gist,
 * the clinician who wants the record, and the patient exercising their right to
 * a copy of their own data. Each card says in one line what it contains and who
 * it is for, because "report" on its own tells nobody what they are about to
 * hand over.
 */

const EXPORT_SECTIONS: Array<{ key: string; labelKey: MessageKey }> = [
  { key: 'profile', labelKey: 'export.profile' },
  { key: 'medications', labelKey: 'export.medications' },
  { key: 'schedules', labelKey: 'export.schedules' },
  { key: 'doses', labelKey: 'export.doses' },
  { key: 'doseEvents', labelKey: 'export.doseEvents' },
  { key: 'stock', labelKey: 'export.stock' },
  { key: 'stockTransactions', labelKey: 'export.stockTransactions' },
  { key: 'refills', labelKey: 'export.refills' },
  { key: 'caregivers', labelKey: 'export.caregivers' },
  { key: 'notes', labelKey: 'export.notes' },
  { key: 'measurements', labelKey: 'export.measurements' },
  { key: 'emergencyCard', labelKey: 'export.emergencyCard' },
  { key: 'auditLog', labelKey: 'export.auditLog' },
];

const CLINICIAN_PRESETS = [30, 90] as const;

interface ExportResponse {
  exportedAt: string;
  profileId: string;
  data: Record<string, unknown[] | undefined>;
}

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export default function ReportsHubScreen() {
  const { t, formatDate, formatNumber, formatTime } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();
  const timezone = activeProfile?.timezone ?? 'UTC';

  const [exportData, setExportData] = useState<ExportResponse | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openClinician = useCallback((days: number) => {
    const to = todayIn(timezone);
    router.push({ pathname: '/reports/clinician', params: { from: addDays(to, -(days - 1)), to } });
  }, [timezone]);

  const runExport = useCallback(async () => {
    if (!activeProfile) return;
    setExporting(true);
    setError(null);
    try {
      const res = await api.get<ExportResponse>('/v1/reports/export', { profileId: activeProfile.id });
      setExportData(res);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) {
        setOffline(true);
      } else if (err instanceof ApiError) {
        const key = errorMessageKey(err.code);
        setError(key ? t(key) : err.message);
      } else {
        setError(t('error.internal_error'));
      }
    } finally {
      setExporting(false);
    }
  }, [activeProfile, setOffline, t]);

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('reports.title')} body={t('error.not_found')} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
      >
        <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
          <Txt variant="h2" weight="bold" accessibilityRole="header">{t('reports.title')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>
        <Txt variant="bodySmall" color={theme.colors.ink500}>{t('reports.hubSubtitle')}</Txt>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? <Banner tone="danger" title={error} /> : null}

        <Card style={{ gap: theme.spacing.md }}>
          <Txt variant="h3" weight="bold" accessibilityRole="header">{t('reports.weeklyFamily')}</Txt>
          <Txt variant="body" color={theme.colors.ink700}>{t('reports.weeklyFamilyDescription')}</Txt>
          <Button label={t('reports.generate')} onPress={() => router.push('/reports/weekly')} />
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Txt variant="h3" weight="bold" accessibilityRole="header">{t('reports.doctor')}</Txt>
          <Txt variant="body" color={theme.colors.ink700}>{t('reports.doctorDescription')}</Txt>
          <Row wrap gap={theme.spacing.sm}>
            {CLINICIAN_PRESETS.map((days) => (
              <View key={days} style={{ flex: 1, minWidth: 140 }}>
                <Button
                  label={t('common.lastDays', { days: formatNumber(days) })}
                  tone="secondary"
                  onPress={() => openClinician(days)}
                />
              </View>
            ))}
          </Row>
          <Button label={t('reports.generate')} onPress={() => router.push('/reports/clinician')} />
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Txt variant="h3" weight="bold" accessibilityRole="header">{t('reports.dataExport')}</Txt>
          <Txt variant="body" color={theme.colors.ink700}>{t('reports.dataExportDescription')}</Txt>
          <Button label={t('reports.prepareExport')} onPress={() => void runExport()} loading={exporting} />

          {exporting ? <Loading label={t('common.loading')} /> : null}

          {exportData ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Divider />
              <Txt variant="bodySmall" weight="bold">{t('reports.exportReady')}</Txt>
              <Txt variant="caption" color={theme.colors.ink500}>
                {t('reports.generatedAt', {
                  datetime: `${formatDate(exportData.exportedAt, timezone)} ${formatTime(exportData.exportedAt, timezone)}`,
                })}
              </Txt>
              {EXPORT_SECTIONS.map((section) => {
                const rows = exportData.data[section.key];
                if (!rows) return null;
                return (
                  <Row key={section.key} style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
                    <Txt variant="bodySmall" color={theme.colors.ink700}>{t(section.labelKey)}</Txt>
                    <Txt variant="bodySmall" weight="medium">
                      {t('reports.records', { count: formatNumber(rows.length) })}
                    </Txt>
                  </Row>
                );
              })}
              <Banner tone="info" title={t('reports.exportNotice')} />
            </View>
          ) : null}
        </Card>

        <SectionTitle>{t('notes.hubTitle')}</SectionTitle>
        <Card onPress={() => router.push('/reports/notes')} accessibilityLabel={t('notes.hubTitle')}>
          <Txt variant="bodyLarge" weight="bold">{t('notes.hubTitle')}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('notes.hubDescription')}</Txt>
        </Card>

        <Card onPress={() => router.push('/reports/adherence')} accessibilityLabel={t('adherence.title')}>
          <Txt variant="bodyLarge" weight="bold">{t('adherence.title')}</Txt>
          <Txt variant="bodySmall" color={theme.colors.ink500}>{t('adherence.disclaimer')}</Txt>
        </Card>

        <SafetyNote textKey="reports.disclaimer" />
      </ScrollView>
    </SafeAreaView>
  );
}
