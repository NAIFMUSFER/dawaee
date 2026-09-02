import type {
  CaregiverPermission, DoseStatus, DoseUnit, FoodInstruction, MedicationForm, MedicationStatus,
  ScheduleRule, StockForecast, StrengthUnit,
} from '@dawaee/shared';

/** Response shapes the app relies on. Kept in step with the API by the contract tests. */

export interface ProfileSummary {
  id: string;
  displayName: string;
  isSelf: boolean;
  timezone: string;
  homeTimezone: string;
  travelPolicy: 'keep_home_time' | 'follow_local_time' | 'ask';
  birthYear: number | null;
  avatarKey: string | null;
  role: 'owner' | 'caregiver';
  permissions: CaregiverPermission[] | null;
}

export interface DoseView {
  id: string;
  medicationId: string;
  scheduleId: string;
  scheduledAt: string;
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  scheduledTimezone: string;
  doseQuantity: number;
  doseUnit: DoseUnit;
  status: DoseStatus;
  minutesLate: number | null;
  snoozedUntil: string | null;
  snoozeCount: number;
  confirmedAt: string | null;
  escalationStage: number;
  medication: {
    name: string;
    form: MedicationForm;
    imageKey: string | null;
    strengthValue: number | null;
    strengthUnit: StrengthUnit | null;
    foodInstruction: FoodInstruction;
    instructions: string | null;
  };
}

export interface TodayResponse {
  profileId: string;
  localDate: string;
  timezone: string;
  serverTime: string;
  next: DoseView | null;
  today: DoseView[];
  prefetch: DoseView[];
  prefetchDays: number;
}

export interface MedicationScheduleView {
  id: string;
  rule: ScheduleRule;
  ruleKind: string;
  doseQuantity: number;
  doseUnit: DoseUnit;
  timezone: string;
  startDate: string;
  endDate: string | null;
  missedAfterMinutes: number;
  lateAfterMinutes: number;
  active: boolean;
}

export interface MedicationView {
  id: string;
  patientProfileId: string;
  name: string;
  brandName: string | null;
  genericName: string | null;
  form: MedicationForm;
  strengthValue: number | null;
  strengthUnit: StrengthUnit | null;
  imageKey: string | null;
  instructions: string | null;
  doctorInstructions: string | null;
  foodInstruction: FoodInstruction;
  notes: string | null;
  status: MedicationStatus;
  startDate: string;
  endDate: string | null;
  expiryDate: string | null;
  identitySource: 'user' | 'ocr_confirmed_by_user' | 'barcode_confirmed_by_user';
  schedules: MedicationScheduleView[];
  stock: {
    unit: DoseUnit;
    initialQuantity: number | null;
    remainingQuantity: number | null;
    trackingEnabled: boolean;
    lowStockThresholdDays: number | null;
    lastRefillAt: string | null;
  } | null;
  stockForecast: StockForecast | null;
}

export interface AdherenceResponse {
  summary: {
    from: string; to: string; scheduled: number; taken: number; takenOnTime: number;
    takenLate: number; skipped: number; missed: number; pending: number;
    adherencePercent: number | null;
  };
  daily: Array<{ date: string; scheduled: number; taken: number; missed: number; adherencePercent: number | null }>;
  byMedication: Array<{ medicationId: string; medicationName: string; summary: AdherenceResponse['summary'] }>;
  byMedicationWithheld?: boolean;
  consecutiveMissed: number;
  disclaimerKey: string;
}

export interface CaregiverView {
  id: string;
  name: string | null;
  phone: string | null;
  role: string;
  status: 'pending' | 'active' | 'revoked' | 'declined' | 'expired';
  permissions: CaregiverPermission[];
  escalationPriority: number;
  invitationExpiresAt: string | null;
  acceptedAt: string | null;
  isYou: boolean;
  notificationRules: Array<{
    channel: string; mode: string; consecutiveMissedThreshold: number;
    summaryTime: string | null; quietHoursStart: string | null; quietHoursEnd: string | null; enabled: boolean;
  }>;
}

export interface OcrMedicationResult {
  kind: 'medication_label';
  provider: string;
  language: 'ar' | 'en' | 'mixed' | 'unknown';
  detected: Record<string, { value: string | number; confidence: number } | undefined>;
  rawText: string;
  requiresUserConfirmation: true;
  disclaimerKey: string;
  provenanceLabelKey: string;
}
