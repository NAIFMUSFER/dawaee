import React from 'react';
import { Image, Modal, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Banner, Button, Card, Divider, Row, SafetyNote, SectionTitle, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import type { DoseView, MedicationScheduleView, MedicationView } from '@/api/types';
import { statusColors } from '@/theme';
import type { DoseUnit, MessageKey, ScheduleRule, StockForecast } from '@dawaee/shared';

export type MedicationDetail = Omit<MedicationView, 'schedules' | 'stock' | 'stockForecast'> & {
  manufacturer: string | null;
  barcode: string | null;
};

export interface StockResponse {
  stock: {
    unit: DoseUnit;
    remainingQuantity: number | null;
    lowStockThresholdDays: number | null;
    lastRefillAt: string | null;
  } | null;
  forecast: StockForecast | null;
}

interface Props {
  medication: MedicationDetail | null;
  schedules: MedicationScheduleView[];
  stock: StockResponse | null;
  doses: DoseView[];
  imageUrl: string | null;
  refreshing: boolean;
  busy: boolean;
  error: string | null;
  confirmingDelete: boolean;
  onConfirmingDeleteChange: (value: boolean) => void;
  onRefresh: () => void;
  onSetStatus: (status: MedicationView['status']) => Promise<void>;
  onRemove: (force: boolean) => Promise<void>;
  summarize: (rule: ScheduleRule) => string;
}

export function MedicationDetailView({
  medication,
  schedules,
  stock,
  doses,
  imageUrl,
  refreshing,
  busy,
  error,
  confirmingDelete,
  onConfirmingDeleteChange,
  onRefresh,
  onSetStatus,
  onRemove,
  summarize,
}: Props) {
  const { t, formatDate, formatNumber, formatTime, formatMeasure } = useI18n();
  const theme = useTheme();
  const { activeProfile } = useApp();

  if (!medication) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
          <Banner tone="danger" title={error ?? t('error.not_found')} />
          <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const strength = medication.strengthValue !== null
    ? formatMeasure(medication.strengthValue, medication.strengthUnit ? `strengthUnit.${medication.strengthUnit}` : undefined)
    : null;
  const forecast = stock?.forecast ?? null;
  const hasHistory = doses.length > 0;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Txt variant="h2" weight="bold" accessibilityRole="header">{medication.name}</Txt>

        {error ? <Banner tone="danger" title={error} /> : null}

        <Card>
          {imageUrl ? (
            <Image
              source={{ uri: imageUrl }}
              accessibilityLabel={t('medication.imageAlt', { name: medication.name })}
              resizeMode="cover"
              style={{
                width: '100%',
                height: theme.elderlyMode ? 260 : 200,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.ink100,
              }}
            />
          ) : (
            <View style={{
              height: theme.elderlyMode ? 160 : 120,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceAlt,
            }}>
              <Txt variant="h1">💊</Txt>
              <Txt variant="caption" color={theme.colors.ink500}>{t('medication.noImage')}</Txt>
            </View>
          )}

          <Row wrap gap={theme.spacing.sm}>
            <Badge
              label={t(`medication.status.${medication.status}` as MessageKey)}
              fg={medication.status === 'active' ? theme.colors.success700 : theme.colors.ink700}
              bg={medication.status === 'active' ? theme.colors.success100 : theme.colors.ink100}
            />
            {forecast?.isLow ? (
              <Badge label={t('stock.lowBadge')} fg={theme.colors.warning700} bg={theme.colors.warning100} />
            ) : null}
          </Row>
        </Card>

        <SectionTitle>{t('medication.identity')}</SectionTitle>
        <Card>
          <DetailRow label={t('medication.form')} value={t(`form.${medication.form}` as MessageKey)} />
          {strength ? <DetailRow label={t('medication.strength')} value={strength} /> : null}
          {medication.brandName ? <DetailRow label={t('medication.brandName')} value={medication.brandName} /> : null}
          {medication.genericName ? <DetailRow label={t('medication.genericName')} value={medication.genericName} /> : null}
          {medication.manufacturer ? <DetailRow label={t('medication.manufacturer')} value={medication.manufacturer} /> : null}
          {medication.barcode ? <DetailRow label={t('medication.barcode')} value={medication.barcode} /> : null}
          {medication.foodInstruction !== 'no_preference' ? (
            <DetailRow label={t('medication.foodInstruction')} value={t(`food.${medication.foodInstruction}` as MessageKey)} />
          ) : null}
          {medication.instructions ? <DetailRow label={t('medication.instructions')} value={medication.instructions} /> : null}
          {medication.doctorInstructions ? (
            <DetailRow label={t('medication.doctorInstructions')} value={medication.doctorInstructions} />
          ) : null}
          {medication.expiryDate ? (
            <DetailRow
              label={t('medication.expiryDate')}
              value={formatDate(`${medication.expiryDate}T12:00:00Z`, activeProfile?.timezone)}
            />
          ) : null}
          <Divider />
          <Txt variant="caption" color={theme.colors.ink500}>{t('medication.provenance')}</Txt>
          <Badge
            label={t(`medication.source.${medication.identitySource}` as MessageKey)}
            fg={theme.colors.info700}
            bg={theme.colors.info100}
          />
        </Card>

        <SectionTitle
          action={
            <Button
              label={schedules.length > 0 ? t('schedule.change') : t('schedule.add')}
              tone="ghost"
              fullWidth={false}
              onPress={() => router.push(
                schedules.length > 0
                  ? `/medication/schedule?medicationId=${medication.id}&mode=edit`
                  : `/medication/schedule?medicationId=${medication.id}&mode=create`,
              )}
            />
          }
        >
          {t('schedule.title')}
        </SectionTitle>
        {schedules.length === 0 ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('schedule.none')}</Txt></Card>
        ) : (
          schedules.map((schedule) => (
            <Card
              key={schedule.id}
              onPress={() => router.push(`/medication/schedule?medicationId=${medication.id}&mode=edit&scheduleId=${schedule.id}`)}
              accessibilityLabel={summarize(schedule.rule)}
            >
              <Txt variant="bodyLarge" weight="medium">{summarize(schedule.rule)}</Txt>
              <Txt variant="bodySmall" color={theme.colors.ink500}>
                {t('schedule.dosePerTime', {
                  qty: formatNumber(schedule.doseQuantity),
                  unit: t(`unit.${schedule.doseUnit}` as MessageKey),
                })}
              </Txt>
              {!schedule.active ? (
                <Badge label={t('schedule.inactive')} fg={theme.colors.ink700} bg={theme.colors.ink100} />
              ) : null}
            </Card>
          ))
        )}

        <SectionTitle
          action={
            <Button
              label={t('stock.markRefilled')}
              tone="ghost"
              fullWidth={false}
              onPress={() => router.push(`/medication/stock?medicationId=${medication.id}`)}
            />
          }
        >
          {t('stock.title')}
        </SectionTitle>
        <Card>
          {stock?.stock && stock.stock.remainingQuantity !== null ? (
            <>
              <Txt variant="h3" weight="bold">
                {t('stock.remaining', {
                  qty: formatNumber(stock.stock.remainingQuantity),
                  unit: t(`unit.${stock.stock.unit}` as MessageKey),
                })}
              </Txt>
              {forecast?.daysRemaining !== null && forecast !== null ? (
                <Txt variant="body" color={forecast.isLow ? theme.colors.warning700 : theme.colors.ink500}>
                  {t('stock.runsOutIn', { days: formatNumber(forecast.daysRemaining) })}
                </Txt>
              ) : (
                <Txt variant="bodySmall" color={theme.colors.ink500}>{t('stock.unknownDays')}</Txt>
              )}
              {forecast?.runoutDate ? (
                <Txt variant="bodySmall" color={theme.colors.ink500}>
                  {t('stock.runsOutOn', { date: formatDate(`${forecast.runoutDate}T12:00:00Z`, activeProfile?.timezone) })}
                </Txt>
              ) : null}
            </>
          ) : (
            <Txt variant="body" color={theme.colors.ink500}>{t('stock.notTracked')}</Txt>
          )}
        </Card>

        <SectionTitle>{t('medication.recentDoses')}</SectionTitle>
        {doses.length === 0 ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('medication.noDoseHistory')}</Txt></Card>
        ) : (
          <Card>
            {doses.map((dose, index) => {
              const colors = statusColors(dose.status);
              return (
                <View key={dose.id} style={{ gap: theme.spacing.xs }}>
                  {index > 0 ? <Divider /> : null}
                  <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                    <View style={{ flex: 1 }}>
                      <Txt variant="body" weight="medium">
                        {formatDate(dose.scheduledAt, dose.scheduledTimezone, { day: 'numeric', month: 'short' })}
                      </Txt>
                      <Txt variant="bodySmall" color={theme.colors.ink500}>
                        {formatTime(dose.scheduledAt, dose.scheduledTimezone)}
                      </Txt>
                    </View>
                    <Badge label={t(`dose.status.${dose.status}` as MessageKey)} fg={colors.fg} bg={colors.bg} />
                  </Row>
                </View>
              );
            })}
          </Card>
        )}

        <SectionTitle>{t('common.edit')}</SectionTitle>
        <Button label={t('common.edit')} onPress={() => router.push(`/medication/edit?mode=edit&id=${medication.id}`)} />
        <Button label={t('refill.title')} tone="secondary" onPress={() => router.push(`/medication/stock?medicationId=${medication.id}`)} />
        <Button
          label={medication.status === 'paused' ? t('medication.resume') : t('medication.pause')}
          tone="secondary"
          loading={busy}
          onPress={() => void onSetStatus(medication.status === 'paused' ? 'active' : 'paused')}
        />
        {medication.status !== 'archived' ? (
          <Button label={t('medication.archive')} tone="secondary" loading={busy} onPress={() => void onSetStatus('archived')} />
        ) : null}
        <Button label={t('medication.deleteTitle')} tone="danger" onPress={() => onConfirmingDeleteChange(true)} />

        <SafetyNote textKey="safety.notMedicalAdvice" />
      </ScrollView>

      {confirmingDelete ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => onConfirmingDeleteChange(false)}>
          <Pressable
            onPress={() => onConfirmingDeleteChange(false)}
            accessibilityLabel={t('common.close')}
            style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'center', padding: theme.spacing.lg }}
          >
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xl,
                padding: theme.spacing.lg,
                gap: theme.spacing.md,
              }}
            >
              <Txt variant="h3" weight="bold" accessibilityRole="header">{t('medication.deleteTitle')}</Txt>
              <Txt variant="body">
                {hasHistory
                  ? t('medication.deleteConfirm', { name: medication.name })
                  : t('medication.deleteSimpleConfirm', { name: medication.name })}
              </Txt>
              {hasHistory ? (
                <Button
                  label={t('medication.archiveInstead')}
                  size="large"
                  loading={busy}
                  onPress={() => { onConfirmingDeleteChange(false); void onSetStatus('archived'); }}
                />
              ) : null}
              <Button label={t('common.delete')} tone="danger" loading={busy} onPress={() => void onRemove(hasHistory)} />
              <Button label={t('common.cancel')} tone="ghost" onPress={() => onConfirmingDeleteChange(false)} />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md} align="flex-start">
      <Txt variant="bodySmall" color={theme.colors.ink500}>{label}</Txt>
      <View style={{ flex: 1 }}>
        <Txt variant="body" weight="medium" align="end">{value}</Txt>
      </View>
    </Row>
  );
}
