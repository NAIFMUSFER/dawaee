/**
 * Canonical enumerations shared by API, worker, mobile and portal.
 * Values are stable wire identifiers — never rename without a migration.
 */

export const MEDICATION_FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'drops',
  'injection',
  'cream',
  'inhaler',
  'patch',
  'suppository',
  'powder',
  'spray',
  'other',
] as const;
export type MedicationForm = (typeof MEDICATION_FORMS)[number];

/** Units a *dose* is expressed in (what the patient takes at one time). */
export const DOSE_UNITS = [
  'tablet',
  'capsule',
  'ml',
  'mg',
  'g',
  'drop',
  'puff',
  'patch',
  'unit',
  'application',
  'sachet',
  'spray',
] as const;
export type DoseUnit = (typeof DOSE_UNITS)[number];

/** Units the *strength* printed on the box is expressed in. */
export const STRENGTH_UNITS = ['mg', 'mcg', 'g', 'ml', 'iu', 'percent', 'mg_per_ml', 'mcg_per_dose'] as const;
export type StrengthUnit = (typeof STRENGTH_UNITS)[number];

export const MEDICATION_STATUSES = ['active', 'paused', 'completed', 'expired', 'archived'] as const;
export type MedicationStatus = (typeof MEDICATION_STATUSES)[number];

export const FOOD_INSTRUCTIONS = ['no_preference', 'before_food', 'with_food', 'after_food', 'empty_stomach'] as const;
export type FoodInstruction = (typeof FOOD_INSTRUCTIONS)[number];

export const SCHEDULE_RULE_KINDS = [
  'fixed_times',   // explicit clock times each active day
  'interval',      // every N hours from an anchor
  'days_of_week',  // explicit clock times but only on selected weekdays
  'cycle',         // N days on, M days off
  'as_needed',     // PRN — no generated occurrences
] as const;
export type ScheduleRuleKind = (typeof SCHEDULE_RULE_KINDS)[number];

/** Lifecycle of a single scheduled dose. */
export const DOSE_STATUSES = [
  'upcoming',
  'due',
  'pending_confirmation',
  'snoozed',
  'taken',
  'taken_late',
  'skipped',
  'missed',
  'cancelled',
] as const;
export type DoseStatus = (typeof DOSE_STATUSES)[number];

export const TERMINAL_DOSE_STATUSES: readonly DoseStatus[] = ['taken', 'taken_late', 'skipped', 'missed', 'cancelled'];

export const CONFIRMATION_METHODS = [
  'app',
  'push_action',
  'notification_action',
  'voice',
  'watch',
  'widget',
  'caregiver',
  'auto_missed',
  'system',
] as const;
export type ConfirmationMethod = (typeof CONFIRMATION_METHODS)[number];

export const DOSE_EVENT_TYPES = [
  'scheduled',
  'notified',
  'snoozed',
  'taken',
  'skipped',
  'missed',
  'undone',
  'escalated',
  'cancelled',
] as const;
export type DoseEventType = (typeof DOSE_EVENT_TYPES)[number];

/** Granular, revocable capabilities a caregiver may hold over a patient profile. */
export const CAREGIVER_PERMISSIONS = [
  'view_medications',
  'view_schedule',
  'view_adherence',
  'view_history',
  'view_reports',
  'view_emergency_card',
  'receive_notifications',
  'edit_schedule',
  'add_medication',
  'edit_medication',
  'update_stock',
  'confirm_dose',
  'manage_caregivers',
] as const;
export type CaregiverPermission = (typeof CAREGIVER_PERMISSIONS)[number];

export const CAREGIVER_RELATIONSHIP_STATUSES = ['pending', 'active', 'revoked', 'declined', 'expired'] as const;
export type CaregiverRelationshipStatus = (typeof CAREGIVER_RELATIONSHIP_STATUSES)[number];

export const CAREGIVER_ROLES = ['son', 'daughter', 'spouse', 'parent', 'sibling', 'nurse', 'caregiver', 'doctor', 'other'] as const;
export type CaregiverRole = (typeof CAREGIVER_ROLES)[number];

/** Preset permission bundles offered in the UI. Patients can always customise. */
export const CAREGIVER_ROLE_PRESETS: Record<string, readonly CaregiverPermission[]> = {
  observer: ['view_adherence', 'receive_notifications'],
  family: ['view_medications', 'view_schedule', 'view_adherence', 'view_history', 'receive_notifications'],
  nurse: [
    'view_medications',
    'view_schedule',
    'view_adherence',
    'view_history',
    'view_reports',
    'receive_notifications',
    'edit_schedule',
    'add_medication',
    'edit_medication',
    'update_stock',
    'confirm_dose',
  ],
  emergency_only: ['view_emergency_card'],
};

/**
 * Channels a notification can actually go out on.
 *
 * WhatsApp and SMS are absent on purpose. Reaching a Saudi phone by SMS needs
 * an alphanumeric Sender ID registered against a commercial registration, and
 * by WhatsApp needs a Meta-verified business with an approved template —
 * neither can be enabled by configuration, so neither is offered as a choice a
 * patient or caregiver can make and then wait on forever. The database enum
 * still carries both values so historical rows stay readable, and adding the
 * channel back is a matter of a provider plus one entry here.
 */
export const NOTIFICATION_CHANNELS = ['push', 'local', 'in_app'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DELIVERY_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'expired'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const NOTIFICATION_KINDS = [
  'dose_reminder',
  'dose_reminder_repeat',
  'escalation',
  'low_stock',
  'refill_due',
  'expiry_warning',
  'prescription_renewal',
  'daily_summary',
  'weekly_summary',
  'caregiver_invitation',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** How often a caregiver hears from the system about a patient. */
export const CAREGIVER_NOTIFY_MODES = [
  'every_dose',
  'missed_only',
  'consecutive_missed',
  'daily_summary',
  'weekly_summary',
  'never',
] as const;
export type CaregiverNotifyMode = (typeof CAREGIVER_NOTIFY_MODES)[number];

export const CONSENT_TYPES = [
  'terms_of_service',
  'privacy_policy',
  'whatsapp_notifications',
  'sms_notifications',
  'caregiver_data_sharing',
  'emergency_card_public',
  'ocr_image_processing',
  'analytics',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const TRAVEL_POLICIES = ['keep_home_time', 'follow_local_time', 'ask'] as const;
export type TravelPolicy = (typeof TRAVEL_POLICIES)[number];

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const NUMERAL_SYSTEMS = ['latn', 'arab'] as const;
export type NumeralSystem = (typeof NUMERAL_SYSTEMS)[number];

export const CALENDAR_SYSTEMS = ['gregory', 'islamic-umalqura'] as const;
export type CalendarSystem = (typeof CALENDAR_SYSTEMS)[number];

export const AUDIT_ACTIONS = [
  'medication.created',
  'medication.updated',
  'medication.archived',
  'medication.deleted',
  'medication.paused',
  'medication.resumed',
  'medication.status_changed',
  'schedule.created',
  'schedule.updated',
  'schedule.deleted',
  'dose.confirmed',
  'dose.skipped',
  'dose.snoozed',
  'dose.undone',
  'stock.adjusted',
  'stock.refilled',
  'caregiver.invited',
  'caregiver.accepted',
  'caregiver.declined',
  'caregiver.revoked',
  'caregiver.permissions_changed',
  'caregiver.notify_rules_changed',
  'profile.created',
  'profile.updated',
  'consent.granted',
  'consent.withdrawn',
  'emergency_card.updated',
  'emergency_card.qr_enabled',
  'emergency_card.qr_disabled',
  'auth.login',
  'auth.logout',
  'auth.otp_requested',
  'auth.otp_failed',
  'account.export_requested',
  'account.deletion_requested',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const SYMPTOM_TAGS = [
  'feeling_normal',
  'dizziness',
  'nausea',
  'headache',
  'drowsiness',
  'stomach_pain',
  'rash',
  'fatigue',
  'other',
] as const;
export type SymptomTag = (typeof SYMPTOM_TAGS)[number];

export const MEASUREMENT_TYPES = ['blood_pressure', 'blood_glucose', 'weight', 'temperature', 'heart_rate', 'spo2'] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];
