import { z } from 'zod';
import {
  CAREGIVER_PERMISSIONS, CAREGIVER_ROLES, CALENDAR_SYSTEMS, CAREGIVER_NOTIFY_MODES, CONSENT_TYPES,
  DOSE_UNITS, FOOD_INSTRUCTIONS, LOCALES, MEASUREMENT_TYPES, MEDICATION_FORMS, MEDICATION_STATUSES,
  NOTIFICATION_CHANNELS, NUMERAL_SYSTEMS, STRENGTH_UNITS, SYMPTOM_TAGS, TRAVEL_POLICIES,
} from './enums.js';

// ------------------------------------------------------------- primitives

export const uuid = z.string().uuid();
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
export const instant = z.string().datetime({ offset: true });
/** Strict E.164 — used for values that are already normalized and stored. */
export const phoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'expected E.164 phone number');

/**
 * Phone number as a HUMAN types it. Saudi users overwhelmingly enter
 * `0512345678`, and rejecting that at the schema would be a self-inflicted
 * onboarding failure. The server normalizes to E.164 (defaulting to +966) and
 * validates the result, so the strict form is still what reaches the database.
 */
export const phoneInput = z
  .string()
  .trim()
  .min(7)
  .max(24)
  .regex(/^[+0-9()\-.\s]+$/, 'phone number contains unexpected characters');
export const timezone = z
  .string()
  .min(3)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown IANA timezone');

/** Text fields that may contain patient-authored content. */
const safeText = (max: number) => z.string().trim().min(1).max(max);

// ------------------------------------------------------------------- auth

export const requestOtpSchema = z.object({
  phone: phoneInput,
  locale: z.enum(LOCALES).default('ar'),
});

export const verifyOtpSchema = z.object({
  phone: phoneInput,
  code: z.string().regex(/^\d{4,8}$/),
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().max(120).optional(),
});

/**
 * Sign-in with a password.
 *
 * One `identifier` field rather than separate phone and email inputs: the
 * person typing knows what they registered with, and making them classify it
 * first is a question the server can answer for itself.
 */
export const passwordLoginSchema = z.object({
  identifier: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().max(120).optional(),
});

export const registerSchema = z
  .object({
    phone: phoneInput.optional(),
    email: z.string().email().max(320).optional(),
    displayName: z.string().min(1).max(120),
    password: z.string().min(10).max(200),
    locale: z.enum(LOCALES).default('ar'),
    deviceId: z.string().min(8).max(128),
    deviceName: z.string().max(120).optional(),
  })
  .refine((v) => Boolean(v.phone ?? v.email), {
    message: 'A phone number or an email address is required',
    path: ['phone'],
  });

/**
 * Account deletion.
 *
 * `confirm` is required and must be true. A destructive, irreversible request
 * should not be expressible by an empty body — an accidental POST must not be
 * a valid one.
 */
export const requestDeletionSchema = z.object({ confirm: z.literal(true) });

export const setPasswordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(10).max(200),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(512) });

export const registerPushTokenSchema = z.object({
  token: z.string().min(10).max(512),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().min(8).max(128),
  appVersion: z.string().max(32).optional(),
});

// --------------------------------------------------------------- profiles

export const createProfileSchema = z.object({
  displayName: safeText(80),
  birthYear: z.number().int().min(1900).max(new Date().getUTCFullYear()).nullish(),
  timezone: timezone.default('Asia/Riyadh'),
  isSelf: z.boolean().default(false),
  travelPolicy: z.enum(TRAVEL_POLICIES).default('ask'),
});

export const updateProfileSchema = createProfileSchema.partial().extend({
  homeTimezone: timezone.optional(),
});

export const updatePreferencesSchema = z.object({
  locale: z.enum(LOCALES).optional(),
  numeralSystem: z.enum(NUMERAL_SYSTEMS).optional(),
  calendarSystem: z.enum(CALENDAR_SYSTEMS).optional(),
  elderlyMode: z.boolean().optional(),
  textScale: z.number().min(0.85).max(2).optional(),
  highContrast: z.boolean().optional(),
  voiceRemindersEnabled: z.boolean().optional(),
  voiceConfirmationEnabled: z.boolean().optional(),
  appLockEnabled: z.boolean().optional(),
  appLockAreas: z.array(z.enum(['history', 'caregivers', 'personal', 'reports', 'emergency'])).optional(),
  quietHoursStart: localTime.nullish(),
  quietHoursEnd: localTime.nullish(),
  defaultSnoozeMinutes: z.number().int().min(1).max(240).optional(),
  lowStockThresholdDays: z.number().int().min(1).max(60).optional(),
  expiryWarningDays: z.number().int().min(1).max(180).optional(),
});

// ------------------------------------------------------------- schedules

export const fixedTimesRuleSchema = z.object({
  kind: z.literal('fixed_times'),
  times: z.array(localTime).min(1).max(12),
});

export const intervalRuleSchema = z.object({
  kind: z.literal('interval'),
  everyHours: z.number().min(1).max(72),
  anchorTime: localTime,
  activeFrom: localTime.optional(),
  activeUntil: localTime.optional(),
});

export const daysOfWeekRuleSchema = z.object({
  kind: z.literal('days_of_week'),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  times: z.array(localTime).min(1).max(12),
});

export const cycleRuleSchema = z.object({
  kind: z.literal('cycle'),
  daysOn: z.number().int().min(1).max(365),
  daysOff: z.number().int().min(0).max(365),
  times: z.array(localTime).min(1).max(12),
  cycleAnchorDate: localDate,
});

export const asNeededRuleSchema = z.object({
  kind: z.literal('as_needed'),
  maxPerDay: z.number().int().min(1).max(24).optional(),
  minHoursBetween: z.number().min(0).max(48).optional(),
});

export const scheduleRuleSchema = z.discriminatedUnion('kind', [
  fixedTimesRuleSchema,
  intervalRuleSchema,
  daysOfWeekRuleSchema,
  cycleRuleSchema,
  asNeededRuleSchema,
]);

export const createScheduleSchema = z
  .object({
    rule: scheduleRuleSchema,
    doseQuantity: z.number().positive().max(1000),
    doseUnit: z.enum(DOSE_UNITS),
    timezone: timezone.optional(),
    startDate: localDate,
    endDate: localDate.nullish(),
    missedAfterMinutes: z.number().int().min(5).max(1440).default(120),
    lateAfterMinutes: z.number().int().min(1).max(720).default(15),
  })
  .refine((s) => !s.endDate || s.endDate >= s.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  })
  .refine((s) => s.missedAfterMinutes > s.lateAfterMinutes, {
    message: 'missedAfterMinutes must exceed lateAfterMinutes',
    path: ['missedAfterMinutes'],
  });

export const updateScheduleSchema = z.object({
  rule: scheduleRuleSchema.optional(),
  doseQuantity: z.number().positive().max(1000).optional(),
  doseUnit: z.enum(DOSE_UNITS).optional(),
  timezone: timezone.optional(),
  startDate: localDate.optional(),
  endDate: localDate.nullish(),
  missedAfterMinutes: z.number().int().min(5).max(1440).optional(),
  lateAfterMinutes: z.number().int().min(1).max(720).optional(),
  active: z.boolean().optional(),
  /** Required by the API when the change alters dose size or timing. */
  confirmHighRiskChange: z.boolean().optional(),
});

// ------------------------------------------------------------ medications

export const createMedicationSchema = z.object({
  patientProfileId: uuid,
  name: safeText(160),
  brandName: z.string().trim().max(160).nullish(),
  genericName: z.string().trim().max(160).nullish(),
  form: z.enum(MEDICATION_FORMS),
  strengthValue: z.number().positive().max(100000).nullish(),
  strengthUnit: z.enum(STRENGTH_UNITS).nullish(),
  manufacturer: z.string().trim().max(160).nullish(),
  barcode: z.string().trim().max(64).nullish(),
  imageKey: z.string().max(256).nullish(),
  instructions: z.string().trim().max(1000).nullish(),
  doctorInstructions: z.string().trim().max(1000).nullish(),
  foodInstruction: z.enum(FOOD_INSTRUCTIONS).default('no_preference'),
  notes: z.string().trim().max(2000).nullish(),
  startDate: localDate,
  endDate: localDate.nullish(),
  expiryDate: localDate.nullish(),
  prescriptionId: uuid.nullish(),
  identitySource: z.enum(['user', 'ocr_confirmed_by_user', 'barcode_confirmed_by_user']).default('user'),
  /** Optional first schedule, created atomically with the medication. */
  schedule: createScheduleSchema.optional(),
  stock: z
    .object({
      trackingEnabled: z.boolean().default(true),
      initialQuantity: z.number().min(0).max(100000),
      unit: z.enum(DOSE_UNITS),
      lowStockThresholdDays: z.number().int().min(1).max(60).nullish(),
    })
    .optional(),
  /** Set true to bypass the duplicate-medication guard after user review. */
  acknowledgeDuplicate: z.boolean().optional(),
});

export const updateMedicationSchema = createMedicationSchema
  .omit({ patientProfileId: true, schedule: true, stock: true, acknowledgeDuplicate: true })
  .partial()
  .extend({
    status: z.enum(MEDICATION_STATUSES).optional(),
    confirmHighRiskChange: z.boolean().optional(),
  });

export const checkDuplicateSchema = z.object({
  patientProfileId: uuid,
  name: z.string().trim().min(1).max(160),
  strengthValue: z.number().positive().nullish(),
  strengthUnit: z.enum(STRENGTH_UNITS).nullish(),
  barcode: z.string().trim().max(64).nullish(),
});

// ------------------------------------------------------------------ doses

export const confirmDoseSchema = z.object({
  /** Client clock at the moment the patient tapped, for offline replay. */
  takenAt: instant.optional(),
  method: z.enum(['app', 'push_action', 'notification_action', 'voice', 'watch', 'widget', 'caregiver']).default('app'),
  deviceId: z.string().max(128).optional(),
  /** Idempotency key so an offline queue can retry safely. */
  clientEventId: z.string().min(8).max(128),
  /** Voice confirmations must clear a confidence bar before they count. */
  voiceConfidence: z.number().min(0).max(1).optional(),
  note: z
    .object({
      tags: z.array(z.enum(SYMPTOM_TAGS)).max(8).default([]),
      text: z.string().trim().max(1000).nullish(),
    })
    .optional(),
});

export const snoozeDoseSchema = z.object({
  minutes: z.number().int().min(1).max(720),
  clientEventId: z.string().min(8).max(128),
  deviceId: z.string().max(128).optional(),
});

export const skipDoseSchema = z.object({
  reason: z.string().trim().max(300).nullish(),
  clientEventId: z.string().min(8).max(128),
  deviceId: z.string().max(128).optional(),
});

/** Bulk replay of offline actions. Order preserved; each item is idempotent. */
export const syncDoseActionsSchema = z.object({
  actions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('taken'), doseOccurrenceId: uuid, at: instant, clientEventId: z.string().min(8).max(128), method: z.string().max(32).optional() }),
        z.object({ type: z.literal('skipped'), doseOccurrenceId: uuid, at: instant, clientEventId: z.string().min(8).max(128), reason: z.string().max(300).nullish() }),
        z.object({ type: z.literal('snoozed'), doseOccurrenceId: uuid, at: instant, clientEventId: z.string().min(8).max(128), minutes: z.number().int().min(1).max(720) }),
      ]),
    )
    .max(500),
  deviceId: z.string().max(128),
});

// ------------------------------------------------------------------ stock

export const adjustStockSchema = z.object({
  remainingQuantity: z.number().min(0).max(100000).optional(),
  delta: z.number().min(-100000).max(100000).optional(),
  reason: z.enum(['manual_correction', 'discard']).default('manual_correction'),
  note: z.string().max(300).nullish(),
});

export const refillSchema = z.object({
  quantityAdded: z.number().positive().max(100000),
  unit: z.enum(DOSE_UNITS),
  pharmacy: z.string().trim().max(160).nullish(),
  cost: z.number().min(0).max(1_000_000).nullish(),
  note: z.string().trim().max(300).nullish(),
  refilledAt: instant.optional(),
});

// ------------------------------------------------------------- caregivers

export const inviteCaregiverSchema = z.object({
  patientProfileId: uuid,
  invitedName: safeText(80),
  invitedPhone: phoneInput,
  role: z.enum(CAREGIVER_ROLES),
  permissions: z.array(z.enum(CAREGIVER_PERMISSIONS)).min(1).max(CAREGIVER_PERMISSIONS.length),
  escalationPriority: z.number().int().min(1).max(20).default(10),
  channel: z.enum(['link', 'qr']).default('link'),
  expiresInHours: z.number().int().min(1).max(168).default(72),
});

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(256) });

export const updateCaregiverPermissionsSchema = z.object({
  permissions: z.array(z.enum(CAREGIVER_PERMISSIONS)).min(0).max(CAREGIVER_PERMISSIONS.length),
  escalationPriority: z.number().int().min(1).max(20).optional(),
  role: z.enum(CAREGIVER_ROLES).optional(),
});

export const caregiverNotificationRuleSchema = z.object({
  channel: z.enum(NOTIFICATION_CHANNELS),
  mode: z.enum(CAREGIVER_NOTIFY_MODES),
  consecutiveMissedThreshold: z.number().int().min(1).max(10).default(2),
  summaryTime: localTime.nullish(),
  quietHoursStart: localTime.nullish(),
  quietHoursEnd: localTime.nullish(),
  enabled: z.boolean().default(true),
});

// ------------------------------------------------------------- escalation

export const escalationStageSchema = z.object({
  afterMinutes: z.number().int().min(0).max(1440),
  target: z.enum(['patient', 'primary_caregiver', 'secondary_caregivers', 'all_caregivers']),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1),
});

export const updateEscalationPolicySchema = z
  .object({
    enabled: z.boolean(),
    medicationId: uuid.nullish(),
    stages: z.array(escalationStageSchema).max(8),
    quietHoursStart: localTime.nullish(),
    quietHoursEnd: localTime.nullish(),
  })
  .refine(
    (p) => p.stages.every((s, i) => i === 0 || s.afterMinutes > (p.stages[i - 1]?.afterMinutes ?? -1)),
    { message: 'stages must be in strictly increasing afterMinutes order', path: ['stages'] },
  );

// -------------------------------------------------------------- emergency

export const updateEmergencyCardSchema = z.object({
  bloodType: z.string().trim().max(8).nullish(),
  allergies: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  conditionsNote: z.string().trim().max(1000).nullish(),
  emergencyContacts: z
    .array(z.object({ name: safeText(80), phoneE164, relation: z.string().trim().max(40).nullish() }))
    .max(5)
    .default([]),
  includeMedications: z.boolean().default(true),
  includeAllergies: z.boolean().default(true),
  includeContacts: z.boolean().default(true),
});

// ---------------------------------------------------------------- consent

export const setConsentSchema = z.object({
  type: z.enum(CONSENT_TYPES),
  granted: z.boolean(),
  version: z.string().max(32).default('1.0'),
  patientProfileId: uuid.nullish(),
});

// ----------------------------------------------------------- measurements

export const createMeasurementSchema = z.object({
  type: z.enum(MEASUREMENT_TYPES),
  valuePrimary: z.number(),
  valueSecondary: z.number().nullish(),
  unit: z.string().max(16),
  measuredAt: instant.optional(),
  doseOccurrenceId: uuid.nullish(),
  note: z.string().trim().max(500).nullish(),
});

// ----------------------------------------------------------------- travel

export const applyTravelDecisionSchema = z.object({
  patientProfileId: uuid,
  detectedTimezone: timezone,
  decision: z.enum(['keep_home_time', 'follow_local_time', 'dismiss']),
});

// ---------------------------------------------------------------- uploads

export const requestUploadSchema = z.object({
  purpose: z.enum(['medication_image', 'prescription_image', 'avatar']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  byteSize: z.number().int().min(1).max(15 * 1024 * 1024),
  patientProfileId: uuid.optional(),
});

// -------------------------------------------------------------------- OCR

export const submitOcrSchema = z.object({
  imageKey: z.string().min(4).max(256),
  patientProfileId: uuid,
  kind: z.enum(['medication_label', 'prescription']),
});

// --------------------------------------------------------------- queries

export const dateRangeQuery = z.object({
  from: localDate,
  to: localDate,
});

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(256).optional(),
});

export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
export type UpdateMedicationInput = z.infer<typeof updateMedicationSchema>;
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type ConfirmDoseInput = z.infer<typeof confirmDoseSchema>;
export type InviteCaregiverInput = z.infer<typeof inviteCaregiverSchema>;
export type UpdateEscalationPolicyInput = z.infer<typeof updateEscalationPolicySchema>;
