import type { MedicationForm, StrengthUnit } from '@dawaee/shared';

/**
 * Transient medication-capture handoff state.
 *
 * OCR and medication identity data is health information. It must never be
 * serialized into Expo Router query parameters: on web those parameters become
 * browser history/referrer material and a deep-link/reload reaches the hosting
 * platform request log before application log redaction can run.
 *
 * Keep the handoff process-local only. A reload/app restart intentionally drops
 * the draft and falls back to manual entry rather than persisting PHI in a URL
 * or general-purpose storage. Drafts are profile-bound and expire quickly so a
 * later navigation cannot accidentally reuse one for a different patient.
 */

export interface MedicationDetectedField {
  value: string;
  confidence: number;
}

export interface MedicationConfirmDraft {
  patientProfileId: string;
  imageKey: string;
  kind: 'medication_label' | 'prescription';
  detected: Record<string, MedicationDetectedField | undefined>;
  remainingLines: number;
}

export interface MedicationPrefillDraft {
  patientProfileId: string;
  name?: string;
  form?: MedicationForm;
  strengthValue?: number | null;
  strengthUnit?: StrengthUnit | null;
  brandName?: string | null;
  genericName?: string | null;
  manufacturer?: string | null;
  barcode?: string | null;
  instructions?: string | null;
  expiryDate?: string | null;
  imageKey?: string | null;
  identitySource?: 'user' | 'ocr_confirmed_by_user' | 'barcode_confirmed_by_user';
}

interface TimedDraft<T> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;
let confirmDraft: TimedDraft<MedicationConfirmDraft> | null = null;
let prefillDraft: TimedDraft<MedicationPrefillDraft> | null = null;

function current<T>(slot: TimedDraft<T> | null, patientProfileId: string): T | null {
  if (!slot || Date.now() >= slot.expiresAt || (slot.value as { patientProfileId?: string }).patientProfileId !== patientProfileId) {
    return null;
  }
  return slot.value;
}

export function setMedicationConfirmDraft(value: MedicationConfirmDraft): void {
  confirmDraft = { value, expiresAt: Date.now() + TTL_MS };
  prefillDraft = null;
}

export function getMedicationConfirmDraft(patientProfileId: string): MedicationConfirmDraft | null {
  const value = current(confirmDraft, patientProfileId);
  if (!value) confirmDraft = null;
  return value;
}

export function setMedicationPrefillDraft(value: MedicationPrefillDraft): void {
  prefillDraft = { value, expiresAt: Date.now() + TTL_MS };
  confirmDraft = null;
}

export function getMedicationPrefillDraft(patientProfileId: string): MedicationPrefillDraft | null {
  const value = current(prefillDraft, patientProfileId);
  if (!value) prefillDraft = null;
  return value;
}

export function clearMedicationDrafts(): void {
  confirmDraft = null;
  prefillDraft = null;
}
