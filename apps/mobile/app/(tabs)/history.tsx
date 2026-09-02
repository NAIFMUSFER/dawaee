import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, Divider, EmptyState, Loading, Row, SectionTitle, Txt,
} from '@/components/ui';
import { DoseCard } from '@/components/DoseCard';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import type { DoseView, MedicationView } from '@/api/types';
import { DOSE_STATUS_COLORS, errorMessageKey, type DoseStatus, type MessageKey } from '@dawaee/shared';
import { addDays, eachDate, weekdayOf } from '@dawaee/core';

/**
 * Dose history.
 *
 * One list, three lenses onto it: a single day, the week around it, and a real
 * month grid. The calendar is a *navigation* surface — it never states more
 * than the counts behind it, and every mark carries a glyph as well as a colour
 * so it survives colour blindness and a greyscale screenshot.
 *
 * The grid is authored in logical order (column 0 is Sunday). React Native
 * mirrors `flexDirection: 'row'` under RTL, so Arabic gets Sunday on the right
 * without a single positional style.
 */

type ViewMode = 'day' | 'week' | 'month';

/** The dominant state of a calendar day. Ordered from "nothing to say" upward. */
type DayMark = 'none' | 'upcoming' | 'skipped' | 'taken' | 'partial' | 'missed';

interface DayTally {
  scheduled: number;
  taken: number;
  missed: number;
  skipped: number;
  pending: number;
  mark: DayMark;
}

const MARK_GLYPH: Record<DayMark, string> = {
  none: '',
  upcoming: '•',
  skipped: '–',
  taken: '✓',
  partial: '◑',
  missed: '✕',
};

const MARK_COLORS: Record<Exclude<DayMark, 'none'>, { fg: string; bg: string }> = {
  upcoming: DOSE_STATUS_COLORS.upcoming,
  skipped: DOSE_STATUS_COLORS.skipped,
  taken: DOSE_STATUS_COLORS.taken,
  partial: DOSE_STATUS_COLORS.taken_late,
  missed: DOSE_STATUS_COLORS.missed,
};

const MARK_LABEL_KEY: Record<Exclude<DayMark, 'none'>, MessageKey> = {
  upcoming: 'history.markUpcoming',
  skipped: 'dose.status.skipped',
  taken: 'history.markTaken',
  partial: 'history.markPartial',
  missed: 'history.markMissed',
};

const FILTERABLE_STATUSES: DoseStatus[] = ['taken', 'taken_late', 'missed', 'skipped'];

const PENDING_STATUSES: ReadonlySet<DoseStatus> = new Set<DoseStatus>([
  'upcoming', 'due', 'pending_confirmation', 'snoozed',
]);

function tally(doses: readonly DoseView[]): DayTally {
  let taken = 0, missed = 0, skipped = 0, pending = 0;
  for (const d of doses) {
    if (d.status === 'taken' || d.status === 'taken_late') taken += 1;
    else if (d.status === 'missed') missed += 1;
    else if (d.status === 'skipped') skipped += 1;
    else if (PENDING_STATUSES.has(d.status)) pending += 1;
  }
  const scheduled = doses.length;
  const mark: DayMark =
    scheduled === 0 ? 'none'
      : missed > 0 && missed < scheduled ? 'partial'
        : missed > 0 ? 'missed'
          : pending > 0 ? 'upcoming'
            : taken > 0 ? 'taken'
              : 'skipped';
  return { scheduled, taken, missed, skipped, pending, mark };
}

/** First day of the month `date` falls in. */
function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function endOfMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(days).padStart(2, '0')}`;
}

/** Sunday of the week `date` falls in — the Saudi week convention used everywhere. */
function startOfWeek(date: string): string {
  return addDays(date, -weekdayOf(date));
}

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export default function HistoryScreen() {
  const { t, formatDate, formatWeekday, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile, offline, setOffline } = useApp();
  const timezone = activeProfile?.timezone ?? 'UTC';

  const [mode, setMode] = useState<ViewMode>('week');
  const [anchor, setAnchor] = useState<string>(() => todayIn(timezone));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [medicationId, setMedicationId] = useState<string | null>(null);
  const [status, setStatus] = useState<DoseStatus | null>(null);

  const [doses, setDoses] = useState<DoseView[]>([]);
  const [medications, setMedications] = useState<MedicationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    if (mode === 'day') return { from: anchor, to: anchor };
    if (mode === 'week') {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  }, [mode, anchor]);

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setError(null);
    try {
      // The medication filter goes to the server so the calendar marks describe
      // exactly the doses being listed. The status filter deliberately does not:
      // a month grid showing only missed days would misrepresent the month.
      const [doseRes, medRes] = await Promise.all([
        api.get<{ doses: DoseView[] }>('/v1/doses', {
          profileId: activeProfile.id,
          from: range.from,
          to: range.to,
          medicationId: medicationId ?? undefined,
        }),
        api.get<{ medications: MedicationView[] }>('/v1/medications', { profileId: activeProfile.id }),
      ]);
      setDoses(doseRes.doses);
      setMedications(medRes.medications);
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
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeProfile, range.from, range.to, medicationId, setOffline, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  // A day selected in one month must not survive a jump to another.
  useEffect(() => {
    if (selectedDate && (selectedDate < range.from || selectedDate > range.to)) setSelectedDate(null);
  }, [range.from, range.to, selectedDate]);

  const byDate = useMemo(() => {
    const map = new Map<string, DoseView[]>();
    for (const dose of doses) {
      const bucket = map.get(dose.scheduledLocalDate);
      if (bucket) bucket.push(dose);
      else map.set(dose.scheduledLocalDate, [dose]);
    }
    return map;
  }, [doses]);

  const listed = useMemo(() => {
    const inDay = selectedDate ? doses.filter((d) => d.scheduledLocalDate === selectedDate) : doses;
    return status ? inDay.filter((d) => d.status === status) : inDay;
  }, [doses, selectedDate, status]);

  const groups = useMemo(() => {
    const map = new Map<string, DoseView[]>();
    for (const dose of listed) {
      const bucket = map.get(dose.scheduledLocalDate);
      if (bucket) bucket.push(dose);
      else map.set(dose.scheduledLocalDate, [dose]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([date, items]) => ({
        date,
        items: [...items].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
      }));
  }, [listed]);

  const dateIso = useCallback((date: string) => `${date}T12:00:00Z`, []);

  const dayAccessibilityLabel = useCallback((date: string): string => {
    const day = byDate.get(date);
    const readable = formatDate(dateIso(date), timezone);
    if (!day || day.length === 0) return t('history.dayEmptyMark', { date: readable });
    const counts = tally(day);
    return t('history.dayMark', {
      date: readable,
      scheduled: formatNumber(counts.scheduled),
      taken: formatNumber(counts.taken),
      missed: formatNumber(counts.missed),
    });
  }, [byDate, dateIso, formatDate, formatNumber, t, timezone]);

  const shift = useCallback((direction: -1 | 1) => {
    setSelectedDate(null);
    setAnchor((current) => {
      if (mode === 'day') return addDays(current, direction);
      if (mode === 'week') return addDays(current, direction * 7);
      const first = startOfMonth(current);
      return direction === -1 ? startOfMonth(addDays(first, -1)) : addDays(endOfMonth(first), 1);
    });
  }, [mode]);

  const periodLabel = useMemo(() => {
    if (mode === 'day') return formatDate(dateIso(anchor), timezone, { weekday: 'long' });
    if (mode === 'week') {
      return t('common.dateRange', {
        from: formatDate(dateIso(range.from), timezone, { year: undefined }),
        to: formatDate(dateIso(range.to), timezone),
      });
    }
    return formatDate(dateIso(range.from), timezone, { day: undefined, month: 'long', year: 'numeric' });
  }, [mode, anchor, range.from, range.to, dateIso, formatDate, timezone, t]);

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title={t('history.title')} body={t('error.not_found')} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('history.title')}</Txt>

        {offline ? <Banner tone="warning" title={t('notifications.offlineBanner')} /> : null}
        {error ? (
          <Banner
            tone="danger"
            title={error}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => { setLoading(true); void load(); }} />}
          />
        ) : null}

        <Row gap={theme.spacing.sm}>
          {(['day', 'week', 'month'] as const).map((value) => (
            <View key={value} style={{ flex: 1 }}>
              <Chip
                label={t(value === 'day' ? 'history.viewDay' : value === 'week' ? 'history.viewWeek' : 'history.viewMonth')}
                selected={mode === value}
                onPress={() => { setMode(value); setSelectedDate(null); }}
                stretch
              />
            </View>
          ))}
        </Row>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
            <Button label={t('common.previous')} tone="ghost" fullWidth={false} onPress={() => shift(-1)} />
            <Txt variant="bodyLarge" weight="bold" align="center" style={{ flex: 1 }}>{periodLabel}</Txt>
            <Button label={t('common.next')} tone="ghost" fullWidth={false} onPress={() => shift(1)} />
          </Row>

          {loading ? (
            <Loading label={t('common.loading')} />
          ) : mode === 'month' ? (
            <MonthGrid
              from={range.from}
              to={range.to}
              selectedDate={selectedDate}
              onSelect={(date) => setSelectedDate((current) => (current === date ? null : date))}
              tallyFor={(date) => tally(byDate.get(date) ?? [])}
              labelFor={dayAccessibilityLabel}
            />
          ) : mode === 'week' ? (
            <WeekStrip
              from={range.from}
              selectedDate={selectedDate}
              onSelect={(date) => setSelectedDate((current) => (current === date ? null : date))}
              tallyFor={(date) => tally(byDate.get(date) ?? [])}
              labelFor={dayAccessibilityLabel}
            />
          ) : (
            <DaySummary counts={tally(byDate.get(anchor) ?? [])} />
          )}

          {mode !== 'day' ? <Legend /> : null}
        </Card>

        <SectionTitle>{t('history.filters')}</SectionTitle>
        <Row wrap gap={theme.spacing.sm}>
          <Chip label={t('history.allMedications')} selected={medicationId === null} onPress={() => setMedicationId(null)} />
          {medications.map((medication) => (
            <Chip
              key={medication.id}
              label={medication.name}
              selected={medicationId === medication.id}
              onPress={() => setMedicationId(medication.id)}
            />
          ))}
        </Row>
        <Row wrap gap={theme.spacing.sm}>
          <Chip label={t('history.allStatuses')} selected={status === null} onPress={() => setStatus(null)} />
          {FILTERABLE_STATUSES.map((value) => (
            <Chip
              key={value}
              label={t(`dose.status.${value}` as MessageKey)}
              selected={status === value}
              onPress={() => setStatus(value)}
            />
          ))}
        </Row>

        {selectedDate || medicationId || status ? (
          <Row wrap gap={theme.spacing.sm} style={{ justifyContent: 'space-between' }}>
            {selectedDate ? (
              <Txt variant="bodySmall" color={theme.colors.ink500}>
                {t('history.selectedDay', { date: formatDate(dateIso(selectedDate), timezone) })}
              </Txt>
            ) : <View />}
            <Button
              label={selectedDate ? t('history.showWholePeriod') : t('history.clearFilters')}
              tone="ghost"
              fullWidth={false}
              onPress={() => {
                if (selectedDate) setSelectedDate(null);
                else { setMedicationId(null); setStatus(null); }
              }}
            />
          </Row>
        ) : null}

        {loading ? (
          <Loading />
        ) : groups.length === 0 ? (
          <EmptyState
            title={doses.length === 0 ? t('history.noDoses') : t('history.noDosesFiltered')}
            action={
              doses.length > 0
                ? <Button label={t('history.clearFilters')} tone="secondary" fullWidth={false} onPress={() => { setStatus(null); setMedicationId(null); setSelectedDate(null); }} />
                : undefined
            }
          />
        ) : (
          groups.map((group) => (
            <View key={group.date} style={{ gap: theme.spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.sm}>
                <Txt variant="bodyLarge" weight="bold" accessibilityRole="header">
                  {formatWeekday(dateIso(group.date), timezone)}
                </Txt>
                <Txt variant="bodySmall" color={theme.colors.ink500}>
                  {formatDate(dateIso(group.date), timezone)}
                </Txt>
              </Row>
              {group.items.map((dose) => (
                <DoseCard
                  key={dose.id}
                  dose={dose}
                  onPress={() => router.push(`/medication/${dose.medicationId}`)}
                />
              ))}
              <Divider />
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ------------------------------------------------------------------ pieces

function Chip({
  label, selected, onPress, stretch,
}: { label: string; selected: boolean; onPress: () => void; stretch?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          minHeight: Math.max(44, theme.touch - 8),
          paddingHorizontal: theme.spacing.md,
          justifyContent: 'center',
          alignItems: 'center',
          alignSelf: stretch ? 'stretch' : 'flex-start',
          borderRadius: theme.radius.pill,
          borderWidth: 2,
          borderColor: selected ? theme.colors.primary700 : theme.colors.ink200,
          backgroundColor: selected ? theme.colors.primary100 : theme.colors.surface,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Txt
        variant="bodySmall"
        weight={selected ? 'bold' : 'regular'}
        align="center"
        color={selected ? theme.colors.primary700 : theme.colors.ink700}
        numberOfLines={1}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

function DayCell({
  date, counts, selected, onPress, accessibilityLabel, showWeekday,
}: {
  date: string;
  counts: DayTally;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  showWeekday?: boolean;
}) {
  const theme = useTheme();
  const { formatNumber, t } = useI18n();
  const palette = counts.mark === 'none' ? null : MARK_COLORS[counts.mark];
  const dayNumber = formatNumber(Number(date.slice(8, 10)));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          minHeight: Math.max(52, theme.touch),
          paddingVertical: theme.spacing.xs,
          borderRadius: theme.radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          backgroundColor: palette?.bg ?? theme.colors.surfaceAlt,
          borderWidth: selected ? 3 : theme.hairline,
          borderColor: selected ? theme.colors.primary700 : theme.colors.ink100,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      {showWeekday ? (
        <Txt variant="caption" color={theme.colors.ink500} align="center" numberOfLines={1}>
          {t(`weekday.short.${weekdayOf(date)}` as MessageKey)}
        </Txt>
      ) : null}
      <Txt variant="bodySmall" weight="bold" align="center" color={palette?.fg ?? theme.colors.ink700}>
        {dayNumber}
      </Txt>
      <Txt variant="caption" weight="bold" align="center" color={palette?.fg ?? theme.colors.ink300}>
        {counts.mark === 'none' ? ' ' : `${MARK_GLYPH[counts.mark]}${formatNumber(counts.scheduled)}`}
      </Txt>
    </Pressable>
  );
}

function MonthGrid({
  from, to, selectedDate, onSelect, tallyFor, labelFor,
}: {
  from: string;
  to: string;
  selectedDate: string | null;
  onSelect: (date: string) => void;
  tallyFor: (date: string) => DayTally;
  labelFor: (date: string) => string;
}) {
  const theme = useTheme();
  const { t, formatWeekday } = useI18n();

  const cells = useMemo<Array<string | null>>(() => {
    const leading: Array<string | null> = Array.from({ length: weekdayOf(from) }, () => null);
    const days: Array<string | null> = eachDate(from, to);
    const grid = [...leading, ...days];
    while (grid.length % 7 !== 0) grid.push(null);
    return grid;
  }, [from, to]);

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
          <View
            key={weekday}
            accessible
            // The column shows a fixed abbreviation so seven of them fit; the
            // full locale-formatted weekday is what a screen reader announces.
            // 2024-01-07 was a Sunday, which anchors the offset.
            accessibilityLabel={formatWeekday(`2024-01-${String(7 + weekday).padStart(2, '0')}T12:00:00Z`, 'UTC')}
            style={{ width: '14.285%', paddingVertical: theme.spacing.xs }}
          >
            <Txt variant="caption" weight="bold" align="center" color={theme.colors.ink500} numberOfLines={1}>
              {t(`weekday.short.${weekday}` as MessageKey)}
            </Txt>
          </View>
        ))}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((date, index) => (
          <View key={date ?? `blank-${index}`} style={{ width: '14.285%', padding: 2 }}>
            {date ? (
              <DayCell
                date={date}
                counts={tallyFor(date)}
                selected={selectedDate === date}
                onPress={() => onSelect(date)}
                accessibilityLabel={labelFor(date)}
              />
            ) : (
              <View style={{ minHeight: Math.max(52, theme.touch) }} />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

function WeekStrip({
  from, selectedDate, onSelect, tallyFor, labelFor,
}: {
  from: string;
  selectedDate: string | null;
  onSelect: (date: string) => void;
  tallyFor: (date: string) => DayTally;
  labelFor: (date: string) => string;
}) {
  const days = useMemo(() => eachDate(from, addDays(from, 6)), [from]);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {days.map((date) => (
        <View key={date} style={{ width: '14.285%', padding: 2 }}>
          <DayCell
            date={date}
            counts={tallyFor(date)}
            selected={selectedDate === date}
            onPress={() => onSelect(date)}
            accessibilityLabel={labelFor(date)}
            showWeekday
          />
        </View>
      ))}
    </View>
  );
}

function DaySummary({ counts }: { counts: DayTally }) {
  const theme = useTheme();
  const { t, formatNumber } = useI18n();
  if (counts.scheduled === 0) {
    return <Txt variant="body" color={theme.colors.ink500} align="center">{t('history.noDoses')}</Txt>;
  }
  return (
    <Txt variant="bodyLarge" weight="medium" align="center">
      {t('history.daySummary', { taken: formatNumber(counts.taken), scheduled: formatNumber(counts.scheduled) })}
    </Txt>
  );
}

function Legend() {
  const theme = useTheme();
  const { t } = useI18n();
  const marks: Array<Exclude<DayMark, 'none'>> = ['taken', 'partial', 'missed', 'upcoming', 'skipped'];
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="caption" weight="bold" color={theme.colors.ink500}>{t('history.legend')}</Txt>
      <Row wrap gap={theme.spacing.sm}>
        {marks.map((mark) => (
          <Row key={mark} gap={theme.spacing.xs}>
            <View style={{
              width: 20, height: 20, borderRadius: theme.radius.sm,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: MARK_COLORS[mark].bg,
            }}>
              <Txt variant="caption" weight="bold" color={MARK_COLORS[mark].fg}>{MARK_GLYPH[mark]}</Txt>
            </View>
            <Txt variant="caption" color={theme.colors.ink700}>{t(MARK_LABEL_KEY[mark])}</Txt>
          </Row>
        ))}
      </Row>
    </View>
  );
}
