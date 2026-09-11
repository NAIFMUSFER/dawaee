import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Card, Divider, Field, Loading, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { Picker } from '@/components/Picker';
import { todayLocalDate } from '@/components/DateField';
import { clearSnooze, readSnooze, setSnooze } from '@/storage/low-stock-snooze';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { profileScopeKey } from '@/hooks/useRequestScope';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { DOSE_UNITS, type DoseUnit, type MessageKey, type StockForecast } from '@dawaee/shared';

/**
 * Stock and refills.
 *
 * Every number here is one the patient entered; nothing is inferred and no
 * quantity is ever adjusted on their behalf. The forecast is division —
 * remaining ÷ doses per day — and it is presented as an estimate rather than a
 * promise, because a skipped dose or a second box in the cupboard changes it.
 *
 * "Remind me tomorrow" is stored on the device rather than on the server: it
 * is a preference about this phone's banner, not a change to the medication.
 */

interface StockTransaction {
  delta: number;
  reason: string;
  balanceAfter: number | null;
  note: string | null;
  createdAt: string;
}

interface RefillEvent {
  id: string;
  quantityAdded: number;
  unit: DoseUnit;
  pharmacy: string | null;
  cost: number | null;
  note: string | null;
  refilledAt: string;
}

interface StockResponse {
  stock: {
    unit: DoseUnit;
    initialQuantity: number | null;
    remainingQuantity: number | null;
    trackingEnabled: boolean;
    lowStockThresholdDays: number | null;
    lastRefillAt: string | null;
  } | null;
  forecast: StockForecast | null;
  transactions: StockTransaction[];
  refills: RefillEvent[];
}

const THRESHOLD_CHOICES = ['3', '5', '7', '10', '14', '21', '30'] as const;

/**
 * The snooze used to be one AsyncStorage entry per medication, named
 * `dawaee.lowStockSnoozedUntil.<medicationId>`. The value was only a date; the
 * KEY was the leak — a directory listing told anyone reading the storage file
 * how many medications the person takes and which ones are running out.
 * It now lives encrypted, per account, with the ids inside the ciphertext.
 */
function nextDay(date: string): string {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return shifted.toISOString().slice(0, 10);
}

export default function StockScreen() {
  const params = useLocalSearchParams<{ medicationId?: string }>();
  const { user, activeProfile } = useApp();
  const key = `${profileScopeKey(user?.id, activeProfile)}:${params.medicationId ?? 'none'}`;
  return <StockProfileScreen key={key} />;
}

function StockProfileScreen() {
  const params = useLocalSearchParams<{ medicationId?: string }>();
  const medicationId = params.medicationId;

  const { t, formatDate, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, preferences, updatePreferences, user } = useApp();

  const [data, setData] = useState<StockResponse | null>(null);
  const [medicationName, setMedicationName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snoozedUntil, setSnoozedUntil] = useState<string | null>(null);

  const [exactQuantity, setExactQuantity] = useState('');
  const [refillQuantity, setRefillQuantity] = useState('');
  const [refillUnit, setRefillUnit] = useState<DoseUnit>('tablet');
  const [pharmacy, setPharmacy] = useState('');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [refilling, setRefilling] = useState(false);

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof NetworkError) return t('notifications.offlineBanner');
    if (err instanceof ApiError) {
      const key = `error.${err.code}` as MessageKey;
      const message = t(key);
      return message === key ? t('error.internal_error') : message;
    }
    return t('error.internal_error');
  }, [t]);

  const load = useCallback(async () => {
    if (!medicationId) return;
    try {
      const [stockRes, detail] = await Promise.all([
        api.get<StockResponse>(`/v1/medications/${medicationId}/stock`),
        api.get<{ medication: { name: string } }>(`/v1/medications/${medicationId}`),
      ]);
      setData(stockRes);
      setMedicationName(detail.medication.name);
      if (stockRes.stock) setRefillUnit(stockRes.stock.unit);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [describeError, medicationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!medicationId) return;
    void (async () => {
      setSnoozedUntil(await readSnooze(user?.id ?? null, medicationId, todayLocalDate(activeProfile?.timezone)));
    })();
  }, [medicationId, user?.id, activeProfile?.timezone]);

  const thresholdOptions = useMemo(
    () => THRESHOLD_CHOICES.map((value) => ({ value, label: formatNumber(Number(value)) })),
    [formatNumber],
  );
  const unitOptions = useMemo(
    () => DOSE_UNITS.map((value) => ({ value, label: t(`unit.${value}` as MessageKey) })),
    [t],
  );

  const adjust = async (body: { delta: number } | { remainingQuantity: number }) => {
    if (!medicationId) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/v1/medications/${medicationId}/stock`, { ...body, reason: 'manual_correction' });
      setExactQuantity('');
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const saveRefill = async () => {
    if (!medicationId) return;
    const quantity = Number(refillQuantity.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError(t('error.validation_failed'));
      return;
    }
    const parsedCost = cost.trim() === '' ? null : Number(cost.replace(',', '.'));
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/medications/${medicationId}/refill`, {
        quantityAdded: quantity,
        unit: refillUnit,
        pharmacy: pharmacy.trim() || null,
        cost: parsedCost !== null && Number.isFinite(parsedCost) ? parsedCost : null,
        note: note.trim() || null,
      });
      setRefillQuantity('');
      setPharmacy('');
      setCost('');
      setNote('');
      setRefilling(false);
      // A refill clears the reason the banner was hidden in the first place.
      await clearSnooze(user?.id ?? null, medicationId, todayLocalDate(activeProfile?.timezone));
      setSnoozedUntil(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remindTomorrow = async () => {
    if (!medicationId) return;
    const today = todayLocalDate(activeProfile?.timezone);
    const until = nextDay(today);
    await setSnooze(user?.id ?? null, medicationId, until, today);
    setSnoozedUntil(until);
  };

  if (loading) return <SafeAreaView style={{ flex: 1 }}><Loading /></SafeAreaView>;

  if (!medicationId) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Banner tone="danger" title={t('error.not_found')} />
          <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
        </Screen>
      </SafeAreaView>
    );
  }

  const stock = data?.stock ?? null;
  const forecast = data?.forecast ?? null;
  const today = todayLocalDate(activeProfile?.timezone);
  const bannerHidden = snoozedUntil !== null && today < snoozedUntil;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('stock.title')}</Txt>
        {medicationName ? <Txt variant="body" color={theme.colors.ink500}>{medicationName}</Txt> : null}

        {error ? <Banner tone="danger" title={error} /> : null}

        {forecast?.isLow && !bannerHidden ? (
          <Banner
            tone="warning"
            title={t('stock.lowTitle')}
            body={t('stock.lowBody', {
              medication: medicationName,
              qty: formatNumber(forecast.remainingQuantity),
              unit: stock ? t(`unit.${stock.unit}` as MessageKey) : '',
              days: formatNumber(forecast.daysRemaining ?? 0),
            })}
            action={
              <Row wrap gap={theme.spacing.sm} style={{ marginTop: theme.spacing.sm }}>
                <Button
                  label={t('stock.markRefilled')}
                  fullWidth={false}
                  onPress={() => setRefilling(true)}
                />
                <Button
                  label={t('stock.remindTomorrow')}
                  tone="ghost"
                  fullWidth={false}
                  onPress={() => void remindTomorrow()}
                />
              </Row>
            }
          />
        ) : null}

        {bannerHidden ? (
          <Txt variant="caption" color={theme.colors.ink500}>{t('stock.remindTomorrowDone')}</Txt>
        ) : null}

        {!stock || !stock.trackingEnabled ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('stock.notTracked')}</Txt></Card>
        ) : (
          <>
            <Card>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('stock.currentQuantity')}</Txt>
              <Txt variant="display" weight="bold">
                {stock.remainingQuantity === null ? t('common.notSet') : formatNumber(stock.remainingQuantity)}
              </Txt>
              <Txt variant="body" color={theme.colors.ink500}>{t(`unit.${stock.unit}` as MessageKey)}</Txt>

              <Divider />

              {forecast && forecast.daysRemaining !== null ? (
                <Txt variant="bodyLarge" weight="medium" color={forecast.isLow ? theme.colors.warning700 : theme.colors.ink900}>
                  {t('stock.runsOutIn', { days: formatNumber(forecast.daysRemaining) })}
                </Txt>
              ) : (
                <Txt variant="bodySmall" color={theme.colors.ink500}>{t('stock.unknownDays')}</Txt>
              )}
              {forecast?.runoutDate ? (
                <Txt variant="bodySmall" color={theme.colors.ink500}>
                  {t('stock.runsOutOn', {
                    date: formatDate(`${forecast.runoutDate}T12:00:00Z`, activeProfile?.timezone),
                  })}
                </Txt>
              ) : null}
              {stock.lastRefillAt ? (
                <Txt variant="caption" color={theme.colors.ink500}>
                  {`${t('refill.title')}: ${formatDate(stock.lastRefillAt, activeProfile?.timezone)}`}
                </Txt>
              ) : null}
            </Card>

            <SectionTitle>{t('stock.adjustTitle')}</SectionTitle>
            <Card>
              <Row gap={theme.spacing.md}>
                <View style={{ flex: 1 }}>
                  <Button
                    label={`− ${formatNumber(1)}`}
                    tone="secondary"
                    loading={busy}
                    accessibilityHint={t('stock.decrease')}
                    onPress={() => void adjust({ delta: -1 })}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label={`+ ${formatNumber(1)}`}
                    tone="secondary"
                    loading={busy}
                    accessibilityHint={t('stock.increase')}
                    onPress={() => void adjust({ delta: 1 })}
                  />
                </View>
              </Row>
              <Divider />
              <Field
                label={t('stock.setExact')}
                value={exactQuantity}
                onChangeText={setExactQuantity}
                keyboardType="decimal-pad"
                placeholder={t('stock.enterNewQuantity')}
              />
              <Button
                label={t('common.save')}
                disabled={exactQuantity.trim() === '' || !Number.isFinite(Number(exactQuantity.replace(',', '.')))}
                loading={busy}
                onPress={() => void adjust({ remainingQuantity: Number(exactQuantity.replace(',', '.')) })}
              />
            </Card>

            <SectionTitle>{t('settings.notifications')}</SectionTitle>
            <Card>
              <Picker
                label={t('stock.thresholdLabel')}
                options={thresholdOptions}
                value={String(preferences.lowStockThresholdDays)}
                onChange={(value) => void updatePreferences({ lowStockThresholdDays: Number(value) })}
                hint={t('stock.thresholdHint')}
              />
            </Card>
          </>
        )}

        <SectionTitle>{t('refill.title')}</SectionTitle>
        {refilling ? (
          <Card>
            <Field
              label={t('refill.quantityAdded')}
              value={refillQuantity}
              onChangeText={setRefillQuantity}
              keyboardType="decimal-pad"
              placeholder={t('stock.enterNewQuantity')}
              autoFocus
            />
            <Picker label={t('schedule.doseUnit')} options={unitOptions} value={refillUnit} onChange={setRefillUnit} />
            <Field label={t('refill.pharmacy')} value={pharmacy} onChangeText={setPharmacy} />
            <Field label={t('refill.cost')} value={cost} onChangeText={setCost} keyboardType="decimal-pad" />
            <Field label={t('refill.note')} value={note} onChangeText={setNote} multiline />
            <Button label={t('refill.save')} size="large" loading={busy} onPress={() => void saveRefill()} />
            <Button label={t('common.cancel')} tone="ghost" onPress={() => setRefilling(false)} />
          </Card>
        ) : (
          <Button label={t('stock.markRefilled')} size="large" onPress={() => setRefilling(true)} />
        )}

        <SectionTitle>{t('refill.history')}</SectionTitle>
        {(data?.refills.length ?? 0) === 0 ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('refill.none')}</Txt></Card>
        ) : (
          <Card>
            {(data?.refills ?? []).map((refill, index) => (
              <View key={refill.id} style={{ gap: theme.spacing.xxs }}>
                {index > 0 ? <Divider /> : null}
                <Txt variant="body" weight="medium">
                  {t('refill.addedOn', {
                    qty: formatNumber(refill.quantityAdded),
                    unit: t(`unit.${refill.unit}` as MessageKey),
                    date: formatDate(refill.refilledAt, activeProfile?.timezone),
                  })}
                </Txt>
                {refill.pharmacy ? (
                  <Txt variant="bodySmall" color={theme.colors.ink500}>{refill.pharmacy}</Txt>
                ) : null}
                {refill.note ? (
                  <Txt variant="bodySmall" color={theme.colors.ink500}>{refill.note}</Txt>
                ) : null}
              </View>
            ))}
          </Card>
        )}

        <SectionTitle>{t('stock.history')}</SectionTitle>
        {(data?.transactions.length ?? 0) === 0 ? (
          <Card><Txt variant="body" color={theme.colors.ink500}>{t('stock.noHistory')}</Txt></Card>
        ) : (
          <Card>
            {(data?.transactions ?? []).map((transaction, index) => (
              <View key={`${transaction.createdAt}-${index}`} style={{ gap: theme.spacing.xxs }}>
                {index > 0 ? <Divider /> : null}
                <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
                  <View style={{ flex: 1 }}>
                    <Txt variant="body">{t(`stock.reason.${transaction.reason}` as MessageKey)}</Txt>
                    <Txt variant="caption" color={theme.colors.ink500}>
                      {formatDate(transaction.createdAt, activeProfile?.timezone)}
                    </Txt>
                  </View>
                  <Txt
                    variant="bodyLarge"
                    weight="bold"
                    color={transaction.delta < 0 ? theme.colors.ink700 : theme.colors.success700}
                  >
                    {`${transaction.delta < 0 ? '−' : '+'}${formatNumber(Math.abs(transaction.delta))}`}
                  </Txt>
                </Row>
              </View>
            ))}
          </Card>
        )}

        <Button label={t('common.back')} tone="ghost" onPress={() => router.back()} />
      </Screen>
    </SafeAreaView>
  );
}
