import {
  DEFAULT_ESCALATION_STAGES, addDays, applyDoseToStock, applyRefill, consecutiveMissed, dailyBreakdown,
  deriveStatus, expandSchedule, forecastStock, localDateInZone, summarizeAdherence, viewOf,
} from '@dawaee/core';
import type { DoseStatus, MedicationSchedule } from '@dawaee/shared';

/**
 * The preview backend.
 *
 * This exists so the published web preview is something a person can actually
 * walk through — Today, the medication list, history, the care circle, elderly
 * mode — rather than a login screen that fails because no server is attached.
 *
 * It is NOT a reimplementation of the product logic. Schedules are expanded,
 * statuses derived, stock decremented and adherence summarised by the exact
 * same functions from `@dawaee/core` that the real API calls. What is faked is
 * only the transport and the storage: an in-memory object instead of
 * PostgreSQL. That means the preview demonstrates real behaviour — a dose
 * confirmed late really is recorded as `taken_late`, and the stock really does
 * fall by one.
 *
 * Everything here is inert without `EXPO_PUBLIC_DEMO=1` at build time.
 */

const TZ = 'Asia/Riyadh';
const PROFILE_ID = 'demo-profile-0000-0000-000000000001';
const USER_ID = 'demo-user-0000-0000-000000000001';

interface DemoMedication {
  id: string;
  name: string;
  brandName: string | null;
  genericName: string | null;
  form: string;
  strengthValue: number | null;
  strengthUnit: string | null;
  foodInstruction: string;
  instructions: string | null;
  doctorInstructions: string | null;
  notes: string | null;
  status: string;
  startDate: string;
  endDate: string | null;
  expiryDate: string | null;
  identitySource: string;
  imageKey: string | null;
  barcode: string | null;
  manufacturer: string | null;
  schedule: MedicationSchedule;
  stock: { unit: string; initialQuantity: number; remainingQuantity: number; trackingEnabled: boolean; lowStockThresholdDays: number | null; lastRefillAt: string | null };
  refills: Array<{ id: string; quantityAdded: number; unit: string; pharmacy: string | null; cost: number | null; note: string | null; refilledAt: string }>;
  transactions: Array<{ delta: number; reason: string; balanceAfter: number; note: string | null; createdAt: string }>;
}

interface DemoDose {
  id: string;
  medicationId: string;
  scheduleId: string;
  scheduledAt: string;
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  scheduledTimezone: string;
  doseQuantity: number;
  doseUnit: string;
  status: DoseStatus;
  notifiedAt: string | null;
  snoozedUntil: string | null;
  snoozeCount: number;
  confirmedAt: string | null;
  confirmationMethod: string | null;
  escalationStage: number;
  events: Array<{ type: string; at: string; method: string | null; metadata: Record<string, unknown> }>;
}

const THRESHOLDS = { lateAfterMinutes: 15, missedAfterMinutes: 180 };

function schedule(id: string, medicationId: string, times: string[], startDate: string): MedicationSchedule {
  return {
    id, medicationId, patientProfileId: PROFILE_ID,
    rule: { kind: 'fixed_times', times },
    ruleKind: 'fixed_times', doseQuantity: 1, doseUnit: 'tablet', timezone: TZ,
    startDate, endDate: null,
    missedAfterMinutes: THRESHOLDS.missedAfterMinutes, lateAfterMinutes: THRESHOLDS.lateAfterMinutes,
    active: true, createdBy: USER_ID, createdAt: '', updatedAt: '',
  };
}

interface DemoState {
  medications: DemoMedication[];
  doses: DemoDose[];
  caregivers: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  measurements: Array<Record<string, unknown>>;
  preferences: Record<string, unknown>;
  consents: Array<{ type: string; granted: boolean; version: string; grantedAt: string | null }>;
  emergency: Record<string, unknown> | null;
  escalation: { enabled: boolean; stages: unknown; quietHoursStart: string | null; quietHoursEnd: string | null };
}

let state: DemoState | null = null;

function seed(): DemoState {
  const now = new Date();
  const today = localDateInZone(now, TZ);
  const start = addDays(today, -14);

  const meds: DemoMedication[] = [
    {
      id: 'demo-med-1', name: 'بنادول', brandName: 'Panadol', genericName: 'Paracetamol',
      form: 'tablet', strengthValue: 500, strengthUnit: 'mg', foodInstruction: 'after_food',
      instructions: 'قرص واحد بعد الأكل', doctorInstructions: null, notes: null,
      status: 'active', startDate: start, endDate: null, expiryDate: addDays(today, 420),
      identitySource: 'ocr_confirmed_by_user', imageKey: null, barcode: '6281000123456', manufacturer: 'GSK',
      schedule: schedule('demo-sch-1', 'demo-med-1', ['08:00', '14:00', '22:00'], start),
      stock: { unit: 'tablet', initialQuantity: 60, remainingQuantity: 24, trackingEnabled: true, lowStockThresholdDays: null, lastRefillAt: null },
      refills: [], transactions: [],
    },
    {
      id: 'demo-med-2', name: 'Metformin', brandName: null, genericName: 'ميتفورمين',
      form: 'tablet', strengthValue: 850, strengthUnit: 'mg', foodInstruction: 'with_food',
      instructions: null, doctorInstructions: 'مع الوجبة مباشرة', notes: null,
      status: 'active', startDate: start, endDate: null, expiryDate: addDays(today, 200),
      identitySource: 'user', imageKey: null, barcode: null, manufacturer: null,
      schedule: schedule('demo-sch-2', 'demo-med-2', ['08:00', '20:00'], start),
      // Deliberately low, so the low-stock and refill paths are visible.
      stock: { unit: 'tablet', initialQuantity: 30, remainingQuantity: 7, trackingEnabled: true, lowStockThresholdDays: null, lastRefillAt: null },
      refills: [], transactions: [],
    },
    {
      id: 'demo-med-3', name: 'Atorvastatin', brandName: null, genericName: null,
      form: 'tablet', strengthValue: 20, strengthUnit: 'mg', foodInstruction: 'no_preference',
      instructions: null, doctorInstructions: null, notes: null,
      status: 'active', startDate: start, endDate: null, expiryDate: null,
      identitySource: 'user', imageKey: null, barcode: null, manufacturer: null,
      schedule: schedule('demo-sch-3', 'demo-med-3', ['21:00'], start),
      stock: { unit: 'tablet', initialQuantity: 90, remainingQuantity: 76, trackingEnabled: true, lowStockThresholdDays: null, lastRefillAt: null },
      refills: [], transactions: [],
    },
  ];

  // Real expansion, not hand-written rows.
  const doses: DemoDose[] = [];
  for (const med of meds) {
    const planned = expandSchedule(med.schedule, {
      from: new Date(now.getTime() - 14 * 86_400_000),
      to: new Date(now.getTime() + 7 * 86_400_000),
    });
    planned.forEach((p, i) => {
      doses.push({
        id: `${med.id}-dose-${i}`, medicationId: med.id, scheduleId: med.schedule.id,
        scheduledAt: p.scheduledAt.toISOString(),
        scheduledLocalDate: p.scheduledLocalDate, scheduledLocalTime: p.scheduledLocalTime,
        scheduledTimezone: p.scheduledTimezone,
        doseQuantity: p.doseQuantity, doseUnit: p.doseUnit,
        status: 'upcoming', notifiedAt: null, snoozedUntil: null, snoozeCount: 0,
        confirmedAt: null, confirmationMethod: null, escalationStage: 0, events: [],
      });
    });
  }

  // A believable adherence record: mostly taken, a few late, a couple missed.
  let n = 0;
  for (const dose of doses) {
    const at = new Date(dose.scheduledAt).getTime();
    if (at >= now.getTime()) continue;
    n += 1;
    if (n % 11 === 0) continue;                       // left to derive as missed
    const lateMinutes = n % 7 === 0 ? 45 : 4;
    const confirmedAt = new Date(at + lateMinutes * 60_000).toISOString();
    dose.status = lateMinutes > THRESHOLDS.lateAfterMinutes ? 'taken_late' : 'taken';
    dose.confirmedAt = confirmedAt;
    dose.confirmationMethod = 'app';
    dose.events = [
      { type: 'notified', at: dose.scheduledAt, method: null, metadata: {} },
      { type: 'taken', at: confirmedAt, method: 'app', metadata: { minutesLate: lateMinutes } },
    ];
  }

  return {
    medications: meds,
    doses,
    caregivers: [
      {
        id: 'demo-rel-1', name: 'أحمد', phone: '+966500000002', role: 'son', status: 'active',
        permissions: ['view_medications', 'view_schedule', 'view_adherence', 'view_history', 'receive_notifications'],
        escalationPriority: 1, invitationExpiresAt: null, acceptedAt: new Date(now.getTime() - 6 * 86_400_000).toISOString(),
        isYou: false,
        notificationRules: [
          { channel: 'whatsapp', mode: 'missed_only', consecutiveMissedThreshold: 2, summaryTime: null, quietHoursStart: null, quietHoursEnd: null, enabled: true },
          { channel: 'push', mode: 'missed_only', consecutiveMissedThreshold: 2, summaryTime: null, quietHoursStart: null, quietHoursEnd: null, enabled: true },
        ],
      },
      {
        id: 'demo-rel-2', name: 'نورة', phone: '+966500000003', role: 'daughter', status: 'active',
        permissions: ['view_adherence', 'receive_notifications'],
        escalationPriority: 5, invitationExpiresAt: null, acceptedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
        isYou: false,
        notificationRules: [
          { channel: 'whatsapp', mode: 'daily_summary', consecutiveMissedThreshold: 2, summaryTime: '21:00', quietHoursStart: null, quietHoursEnd: null, enabled: true },
        ],
      },
    ],
    notes: [
      { id: 'demo-note-1', tags: ['feeling_normal'], text: null, recordedAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(), doseOccurrenceId: null, medicationName: 'بنادول' },
    ],
    measurements: [],
    preferences: {
      locale: 'ar', numeralSystem: 'latn', calendarSystem: 'gregory', elderlyMode: false,
      textScale: 1, highContrast: false, voiceRemindersEnabled: false, voiceConfirmationEnabled: false,
      appLockEnabled: false, appLockAreas: [], quietHoursStart: null, quietHoursEnd: null,
      defaultSnoozeMinutes: 10, lowStockThresholdDays: 7, expiryWarningDays: 30,
    },
    consents: [
      { type: 'whatsapp_notifications', granted: true, version: '1.0', grantedAt: new Date(now.getTime() - 6 * 86_400_000).toISOString() },
      { type: 'ocr_image_processing', granted: true, version: '1.0', grantedAt: new Date(now.getTime() - 14 * 86_400_000).toISOString() },
    ],
    emergency: {
      id: 'demo-card-1', patientDisplayName: 'محمد', bloodType: 'O+',
      allergies: ['البنسلين'], conditionsNote: null,
      emergencyContacts: [{ name: 'أحمد', phoneE164: '+966500000002', relation: 'الابن' }],
      includeMedications: true, includeAllergies: true, includeContacts: true,
      qrEnabled: false, qrRotatedAt: null, qrViewCount: 0, qrLastViewedAt: null,
      updatedAt: new Date().toISOString(),
    },
    escalation: { enabled: true, stages: DEFAULT_ESCALATION_STAGES, quietHoursStart: null, quietHoursEnd: null },
  };
}

function db(): DemoState {
  if (!state) state = seed();
  return state;
}

function medById(id: string): DemoMedication | undefined {
  return db().medications.find((m) => m.id === id);
}

function consumption(med: DemoMedication) {
  return [{ rule: med.schedule.rule, doseQuantity: med.schedule.doseQuantity, doseUnit: med.schedule.doseUnit, active: med.schedule.active }];
}

function forecast(med: DemoMedication) {
  return forecastStock({
    medicationId: med.id,
    stock: {
      remainingQuantity: med.stock.remainingQuantity,
      trackingEnabled: med.stock.trackingEnabled,
      lowStockThresholdDays: med.stock.lowStockThresholdDays,
    },
    sources: consumption(med),
    defaultThresholdDays: 7,
    now: new Date(),
    timezone: TZ,
  });
}

function doseView(d: DemoDose, now: Date) {
  const med = medById(d.medicationId)!;
  const view = viewOf(
    { id: d.id, status: d.status, scheduledAt: d.scheduledAt, snoozedUntil: d.snoozedUntil, notifiedAt: d.notifiedAt, confirmedAt: d.confirmedAt } as never,
    now, THRESHOLDS,
  );
  return {
    id: d.id, medicationId: d.medicationId, scheduleId: d.scheduleId,
    scheduledAt: d.scheduledAt, scheduledLocalDate: d.scheduledLocalDate,
    scheduledLocalTime: d.scheduledLocalTime, scheduledTimezone: d.scheduledTimezone,
    doseQuantity: d.doseQuantity, doseUnit: d.doseUnit,
    status: view.status, storedStatus: d.status, minutesLate: view.minutesLate,
    snoozedUntil: d.snoozedUntil, snoozeCount: d.snoozeCount,
    confirmedAt: d.confirmedAt, confirmationMethod: d.confirmationMethod,
    escalationStage: d.escalationStage,
    medication: {
      name: med.name, form: med.form, imageKey: med.imageKey,
      strengthValue: med.strengthValue, strengthUnit: med.strengthUnit,
      foodInstruction: med.foodInstruction, instructions: med.instructions,
    },
    thresholds: THRESHOLDS,
  };
}

function medicationView(med: DemoMedication) {
  return {
    id: med.id, patientProfileId: PROFILE_ID, name: med.name, brandName: med.brandName,
    genericName: med.genericName, form: med.form, strengthValue: med.strengthValue,
    strengthUnit: med.strengthUnit, manufacturer: med.manufacturer, barcode: med.barcode,
    imageKey: med.imageKey, instructions: med.instructions, doctorInstructions: med.doctorInstructions,
    foodInstruction: med.foodInstruction, notes: med.notes, status: med.status,
    startDate: med.startDate, endDate: med.endDate, expiryDate: med.expiryDate,
    prescriptionId: null, identitySource: med.identitySource,
    createdAt: med.startDate, updatedAt: med.startDate, archivedAt: null,
    schedules: [{
      id: med.schedule.id, rule: med.schedule.rule, ruleKind: med.schedule.ruleKind,
      doseQuantity: med.schedule.doseQuantity, doseUnit: med.schedule.doseUnit,
      timezone: med.schedule.timezone, startDate: med.schedule.startDate, endDate: med.schedule.endDate,
      missedAfterMinutes: med.schedule.missedAfterMinutes, lateAfterMinutes: med.schedule.lateAfterMinutes,
      active: med.schedule.active,
    }],
    stock: med.stock,
    stockForecast: forecast(med),
  };
}

function occurrencesFor(from?: string, to?: string, medicationId?: string) {
  return db().doses.filter((d) =>
    (!from || d.scheduledLocalDate >= from) &&
    (!to || d.scheduledLocalDate <= to) &&
    (!medicationId || d.medicationId === medicationId));
}

/** A single dispatch table so the shape of the preview stays obvious. */
export function handleDemoRequest(method: string, path: string, query: URLSearchParams, body: unknown): unknown {
  const now = new Date();
  const s = db();
  const seg = path.replace(/^\/v1\//, '').split('/');
  const b = (body ?? {}) as Record<string, never>;

  // ------------------------------------------------------------ account
  if (path === '/v1/me' && method === 'GET') {
    return {
      user: { id: USER_ID, phoneE164: '+966500000001', email: null, displayName: 'محمد', locale: 'ar', timezone: TZ, createdAt: new Date(now.getTime() - 30 * 86_400_000).toISOString() },
      preferences: s.preferences,
      consents: s.consents,
    };
  }
  if (path === '/v1/me' && method === 'PATCH') return { user: { id: USER_ID, ...(b as object) } };
  if (path === '/v1/me/preferences') {
    s.preferences = { ...s.preferences, ...(b as object) };
    return { preferences: s.preferences };
  }
  if (path === '/v1/me/consents') {
    const input = b as unknown as { type: string; granted: boolean; version?: string };
    const existing = s.consents.find((c) => c.type === input.type);
    if (existing) { existing.granted = input.granted; existing.grantedAt = input.granted ? now.toISOString() : null; }
    else s.consents.push({ type: input.type, granted: input.granted, version: input.version ?? '1.0', grantedAt: input.granted ? now.toISOString() : null });
    return { consent: s.consents.find((c) => c.type === input.type) };
  }
  if (path === '/v1/me/deletion-request') return { requested: true, scheduledFor: addDays(localDateInZone(now, TZ), 30) };

  if (path === '/v1/profiles' && method === 'GET') {
    return { profiles: [{ id: PROFILE_ID, displayName: 'محمد', isSelf: true, timezone: TZ, homeTimezone: TZ, travelPolicy: 'ask', birthYear: 1948, avatarKey: null, role: 'owner', permissions: null }] };
  }
  if (path === '/v1/profiles' && method === 'POST') return { profile: { id: `demo-profile-${Date.now()}`, ...(b as object) } };
  if (seg[0] === 'profiles' && seg[2] === 'timezone-check') return { changed: false };
  if (seg[0] === 'profiles' && seg[2] === 'timezone-decision') return { applied: true, decision: 'keep_home_time', timezone: TZ, dosesRegenerated: 0 };

  // -------------------------------------------------------------- today
  if (path === '/v1/today') {
    const today = localDateInZone(now, TZ);
    const todays = s.doses.filter((d) => d.scheduledLocalDate === today).map((d) => doseView(d, now));
    const prefetch = s.doses
      .filter((d) => new Date(d.scheduledAt) > now && new Date(d.scheduledAt).getTime() < now.getTime() + 7 * 86_400_000)
      .map((d) => doseView(d, now));
    const next = todays.find((d) => ['due', 'pending_confirmation'].includes(d.status))
      ?? todays.find((d) => d.status === 'snoozed')
      ?? todays.find((d) => d.status === 'upcoming')
      ?? prefetch[0] ?? null;
    return { profileId: PROFILE_ID, localDate: today, timezone: TZ, serverTime: now.toISOString(), next, today: todays, prefetch, prefetchDays: 7 };
  }

  // --------------------------------------------------------- medications
  if (path === '/v1/medications' && method === 'GET') {
    const status = query.get('status');
    const meds = s.medications.filter((m) => !status || m.status === status).map(medicationView);
    return { medications: meds, count: meds.length };
  }
  if (path === '/v1/medications' && method === 'POST') {
    return { medication: { ...(b as object), id: `demo-med-${Date.now()}`, status: 'active' }, scheduleId: null, dosesCreated: 0 };
  }
  if (path === '/v1/medications/check-duplicate') return { duplicates: [], hasDuplicates: false };
  if (seg[0] === 'medications' && seg.length === 2 && method === 'GET') {
    const med = medById(seg[1]!);
    if (!med) return { error: { code: 'not_found', message: 'not found' } };
    const v = medicationView(med);
    return { medication: v, schedules: v.schedules, stock: v.stock };
  }
  if (seg[0] === 'medications' && seg.length === 2 && method === 'PATCH') {
    const med = medById(seg[1]!);
    if (med) Object.assign(med, b);
    return { medication: med ? medicationView(med) : null, futureDosesCancelled: 0, futureDosesRevived: 0, highRiskChanges: [] };
  }
  if (seg[0] === 'medications' && seg.length === 2 && method === 'DELETE') {
    return { deleted: false, archived: true, historyCount: 12, futureDosesCancelled: 4 };
  }
  if (seg[0] === 'medications' && seg[2] === 'stock' && method === 'GET') {
    const med = medById(seg[1]!)!;
    return { stock: med.stock, forecast: forecast(med), transactions: med.transactions, refills: med.refills };
  }
  if (seg[0] === 'medications' && seg[2] === 'stock' && method === 'PUT') {
    const med = medById(seg[1]!)!;
    const input = b as unknown as { remainingQuantity?: number; delta?: number };
    const before = med.stock.remainingQuantity;
    med.stock.remainingQuantity = input.remainingQuantity ?? Math.max(0, before + (input.delta ?? 0));
    med.transactions.unshift({ delta: med.stock.remainingQuantity - before, reason: 'manual_correction', balanceAfter: med.stock.remainingQuantity, note: null, createdAt: now.toISOString() });
    return { remainingQuantity: med.stock.remainingQuantity, unit: med.stock.unit, delta: med.stock.remainingQuantity - before };
  }
  if (seg[0] === 'medications' && seg[2] === 'refill') {
    const med = medById(seg[1]!)!;
    const input = b as unknown as { quantityAdded: number; unit: string; pharmacy?: string; cost?: number; note?: string };
    med.stock.remainingQuantity = applyRefill(med.stock.remainingQuantity, input.quantityAdded);
    med.stock.lastRefillAt = now.toISOString();
    med.refills.unshift({ id: `demo-refill-${Date.now()}`, quantityAdded: input.quantityAdded, unit: input.unit, pharmacy: input.pharmacy ?? null, cost: input.cost ?? null, note: input.note ?? null, refilledAt: now.toISOString() });
    med.transactions.unshift({ delta: input.quantityAdded, reason: 'refill', balanceAfter: med.stock.remainingQuantity, note: null, createdAt: now.toISOString() });
    return { refillId: med.refills[0]!.id, remainingQuantity: med.stock.remainingQuantity, unit: input.unit, daysOfSupply: forecast(med)?.daysRemaining ?? null };
  }
  if (seg[0] === 'medications' && seg[2] === 'schedules') return { schedule: { id: `demo-sch-${Date.now()}`, ...(b as object) }, dosesCreated: 0 };
  if (seg[0] === 'schedules' && method === 'PATCH') return { schedule: { id: seg[1], ...(b as object) }, futureDosesRemoved: 0, dosesCreated: 0, highRiskChanges: [] };

  if (path === '/v1/stock/low') {
    const low = s.medications.map((m) => ({ medicationId: m.id, medicationName: m.name, unit: m.stock.unit, forecast: forecast(m) })).filter((x) => x.forecast?.isLow);
    const expiring = s.medications.filter((m) => m.expiryDate && m.expiryDate <= addDays(localDateInZone(now, TZ), 30))
      .map((m) => ({ medicationId: m.id, medicationName: m.name, expiryDate: m.expiryDate }));
    return { lowStock: low, expiringSoon: expiring };
  }

  // --------------------------------------------------------------- doses
  if (path === '/v1/doses' && method === 'GET') {
    const list = occurrencesFor(query.get('from') ?? undefined, query.get('to') ?? undefined, query.get('medicationId') ?? undefined)
      .map((d) => doseView(d, now))
      .sort((a, b2) => (a.scheduledAt < b2.scheduledAt ? 1 : -1));
    const status = query.get('status');
    const filtered = status ? list.filter((d) => d.status === status) : list;
    return { doses: filtered, count: filtered.length, from: query.get('from'), to: query.get('to') };
  }
  if (seg[0] === 'doses' && seg.length === 2 && method === 'GET') {
    const d = s.doses.find((x) => x.id === seg[1]);
    return d ? { dose: doseView(d, now), events: d.events } : { error: { code: 'not_found', message: 'not found' } };
  }
  if (seg[0] === 'doses' && seg[2] === 'taken') {
    const d = s.doses.find((x) => x.id === seg[1])!;
    const minutesLate = Math.max(0, Math.round((now.getTime() - new Date(d.scheduledAt).getTime()) / 60_000));
    d.status = minutesLate > THRESHOLDS.lateAfterMinutes ? 'taken_late' : 'taken';
    d.confirmedAt = now.toISOString();
    d.confirmationMethod = 'app';
    d.events.push({ type: 'taken', at: d.confirmedAt, method: 'app', metadata: { minutesLate } });
    const med = medById(d.medicationId)!;
    const applied = applyDoseToStock(med.stock.remainingQuantity, d.doseQuantity, med.stock.trackingEnabled);
    if (applied) {
      med.stock.remainingQuantity = applied.balanceAfter;
      med.transactions.unshift({ delta: applied.delta, reason: 'dose_taken', balanceAfter: applied.balanceAfter, note: null, createdAt: now.toISOString() });
    }
    return { doseId: d.id, status: d.status, confirmedAt: d.confirmedAt, minutesLate, stock: applied ? { remainingQuantity: applied.balanceAfter, clamped: applied.clamped } : null, idempotentReplay: false };
  }
  if (seg[0] === 'doses' && seg[2] === 'snooze') {
    const d = s.doses.find((x) => x.id === seg[1])!;
    const minutes = (b as unknown as { minutes: number }).minutes;
    d.status = 'snoozed';
    d.snoozedUntil = new Date(now.getTime() + minutes * 60_000).toISOString();
    d.snoozeCount += 1;
    d.events.push({ type: 'snoozed', at: now.toISOString(), method: null, metadata: { minutes } });
    return { doseId: d.id, snoozedUntil: d.snoozedUntil, snoozeCount: d.snoozeCount, idempotentReplay: false };
  }
  if (seg[0] === 'doses' && seg[2] === 'skip') {
    const d = s.doses.find((x) => x.id === seg[1])!;
    d.status = 'skipped';
    d.confirmedAt = now.toISOString();
    d.events.push({ type: 'skipped', at: d.confirmedAt, method: null, metadata: {} });
    return { doseId: d.id, status: 'skipped', idempotentReplay: false };
  }
  if (seg[0] === 'doses' && seg[2] === 'undo') {
    const d = s.doses.find((x) => x.id === seg[1])!;
    d.status = 'upcoming'; d.confirmedAt = null; d.confirmationMethod = null;
    return { doseId: d.id, status: 'upcoming' };
  }
  if (path === '/v1/doses/sync') return { results: [], applied: 0, replayed: 0, failed: 0, serverTime: now.toISOString() };

  // ----------------------------------------------------------- adherence
  if (path === '/v1/adherence') {
    const from = query.get('from') ?? addDays(localDateInZone(now, TZ), -30);
    const to = query.get('to') ?? localDateInZone(now, TZ);
    const rows = occurrencesFor(from, to, query.get('medicationId') ?? undefined);
    const occ = rows.map((d) => ({ status: d.status, scheduledAt: d.scheduledAt, snoozedUntil: d.snoozedUntil, notifiedAt: d.notifiedAt, confirmedAt: d.confirmedAt }));
    return {
      summary: summarizeAdherence({ occurrences: occ, now, thresholds: THRESHOLDS, from, to }),
      daily: dailyBreakdown(occ, now, THRESHOLDS, TZ),
      byMedication: s.medications.map((m) => {
        const mo = rows.filter((d) => d.medicationId === m.id).map((d) => ({ status: d.status, scheduledAt: d.scheduledAt, snoozedUntil: d.snoozedUntil, notifiedAt: d.notifiedAt, confirmedAt: d.confirmedAt }));
        return { medicationId: m.id, medicationName: m.name, summary: summarizeAdherence({ occurrences: mo, now, thresholds: THRESHOLDS, from, to }) };
      }),
      consecutiveMissed: consecutiveMissed(occ, now, THRESHOLDS),
      disclaimerKey: 'adherence.disclaimer',
    };
  }

  // ---------------------------------------------------------- care circle
  if (path === '/v1/care-circle') return { caregivers: s.caregivers, viewerRole: 'owner', presets: {} };
  if (path === '/v1/caregivers/invite') return { relationshipId: `demo-rel-${Date.now()}`, expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(), invitationLink: 'https://dawaee.app/invite/preview-only', delivery: { channel: 'sms', ok: true } };
  if (path === '/v1/caregivers/accept') return { accepted: true, relationshipId: 'demo-rel-1', profile: { id: PROFILE_ID, display_name: 'محمد' } };
  if (seg[0] === 'caregivers' && seg[2] === 'permissions') {
    const c = s.caregivers.find((x) => x.id === seg[1]);
    if (c) Object.assign(c, b);
    return { caregiver: c };
  }
  if (seg[0] === 'caregivers' && seg[2] === 'notification-rules') return { rule: b };
  if (seg[0] === 'caregivers' && seg.length === 2 && method === 'DELETE') {
    const c = s.caregivers.find((x) => x.id === seg[1]);
    if (c) c.status = 'revoked';
    return { revoked: true, selfRemoval: false };
  }
  if (path === '/v1/escalation-policy' && method === 'GET') return { policy: { id: 'demo-policy-1', medicationId: null, ...s.escalation }, isDefault: false, defaultStages: DEFAULT_ESCALATION_STAGES };
  if (path === '/v1/escalation-policy' && method === 'PUT') {
    s.escalation = { ...s.escalation, ...(b as object) };
    return { policy: { id: 'demo-policy-1', ...s.escalation } };
  }

  // ------------------------------------------------------------- reports
  if (path === '/v1/reports/weekly' || path === '/v1/reports/adherence' || path === '/v1/reports/clinician') {
    const to = query.get('to') ?? localDateInZone(now, TZ);
    const from = query.get('from') ?? addDays(to, -6);
    const rows = occurrencesFor(from, to);
    const occ = rows.map((d) => ({ status: d.status, scheduledAt: d.scheduledAt, snoozedUntil: d.snoozedUntil, notifiedAt: d.notifiedAt, confirmedAt: d.confirmedAt }));
    return {
      meta: { patientName: 'محمد', timezone: TZ, from, to, generatedAt: now.toISOString(), audience: path.endsWith('clinician') ? 'clinician' : 'family' },
      summary: summarizeAdherence({ occurrences: occ, now, thresholds: THRESHOLDS, from, to }),
      daily: dailyBreakdown(occ, now, THRESHOLDS, TZ),
      medications: s.medications.map((m) => {
        const mo = rows.filter((d) => d.medicationId === m.id).map((d) => ({ status: d.status, scheduledAt: d.scheduledAt, snoozedUntil: d.snoozedUntil, notifiedAt: d.notifiedAt, confirmedAt: d.confirmedAt }));
        return { name: m.name, strength: m.strengthValue ? `${m.strengthValue} ${m.strengthUnit}` : null, form: m.form, summary: summarizeAdherence({ occurrences: mo, now, thresholds: THRESHOLDS, from, to }) };
      }),
      stockOutlook: s.medications.map((m) => { const f = forecast(m); return { medicationName: m.name, unit: m.stock.unit, remaining: f?.remainingQuantity ?? null, daysRemaining: f?.daysRemaining ?? null, runoutDate: f?.runoutDate ?? null, needsRefill: f?.isLow ?? false }; }),
      doses: rows.map((d) => ({ medicationName: medById(d.medicationId)!.name, scheduledDate: d.scheduledLocalDate, scheduledTime: d.scheduledLocalTime, dose: `${d.doseQuantity} ${d.doseUnit}`, status: deriveStatus({ status: d.status, scheduledAt: d.scheduledAt, snoozedUntil: d.snoozedUntil, notifiedAt: d.notifiedAt } as never, now, THRESHOLDS), confirmedAt: d.confirmedAt })),
      disclaimers: { adherenceKey: 'adherence.disclaimer', reportKey: 'reports.disclaimer' },
    };
  }
  if (path === '/v1/reports/export') return { exportedAt: now.toISOString(), profileId: PROFILE_ID, data: { profile: [{ id: PROFILE_ID, display_name: 'محمد' }], medications: s.medications.map(medicationView), doses: s.doses.length, note: 'preview export — sample data only' } };

  // ------------------------------------------------- notes, measurements
  if (path === '/v1/notes' && method === 'GET') return { notes: s.notes, interpretationNotice: 'Recorded as entered by the user. Not interpreted or diagnosed by the app.' };
  if (path === '/v1/notes' && method === 'POST') { const n2 = { id: `demo-note-${Date.now()}`, recordedAt: now.toISOString(), ...(b as object) }; s.notes.unshift(n2); return { note: n2 }; }
  if (path === '/v1/measurements' && method === 'GET') return { measurements: s.measurements, interpretationNotice: 'Measurements are recorded for the user’s own reference and are not evaluated by the app.' };
  if (path === '/v1/measurements' && method === 'POST') { const m2 = { id: `demo-m-${Date.now()}`, measuredAt: now.toISOString(), ...(b as object) }; s.measurements.unshift(m2); return { measurement: m2 }; }

  // ----------------------------------------------------------- emergency
  if (path === '/v1/emergency/card' && method === 'GET') return { card: s.emergency, provenanceKey: 'emergency.userProvided' };
  if (path === '/v1/emergency/card' && method === 'PUT') { s.emergency = { ...(s.emergency ?? {}), ...(b as object) }; return { card: s.emergency }; }
  if (path === '/v1/emergency/qr/enable') { (s.emergency as Record<string, unknown>).qrEnabled = true; return { enabled: true, qrUrl: 'https://dawaee.app/e/preview-only', token: 'preview-only' }; }
  if (path === '/v1/emergency/qr/disable') { (s.emergency as Record<string, unknown>).qrEnabled = false; return { enabled: false }; }

  // ------------------------------------------------------- not in preview
  if (path === '/v1/uploads/request' || path === '/v1/ocr/analyze') {
    throw new DemoUnavailable('camera_and_ocr');
  }
  if (path === '/v1/auth/logout' || path === '/v1/auth/logout-all') return { ok: true };
  if (path === '/v1/devices/push-token') return { ok: true };

  return {};
}

/**
 * Raised for the two flows the preview genuinely cannot do — uploading an
 * image and calling a vision API both need a server. The UI reports this
 * plainly rather than failing with a generic error.
 */
export class DemoUnavailable extends Error {
  constructor(readonly feature: string) {
    super(`not available in the preview: ${feature}`);
    this.name = 'DemoUnavailable';
  }
}

export function resetDemoState(): void {
  state = null;
}
