/**
 * Process-local handoff for authenticated clinical navigation.
 *
 * Stable profile, medication, schedule, dose, and caregiver relationship ids
 * are health-linked identifiers. Expo Router path/search parameters become
 * browser history and, after a reload or deep link, reach Render's platform
 * request log before the application can redact anything. Current navigation
 * therefore uses fixed public paths and hands the selected resource through
 * these short-lived, account/profile-bound slots.
 *
 * A process restart intentionally drops the selection. Persisting these ids in
 * a URL or general-purpose browser storage would recreate the disclosure this
 * boundary exists to prevent.
 */

interface RouteOwner {
  userId: string;
  patientProfileId: string;
}

export interface MedicationDetailRouteIntent extends RouteOwner {
  medicationId: string;
}

export interface MedicationEditRouteIntent extends RouteOwner {
  medicationId: string;
}

export interface MedicationScheduleRouteIntent extends RouteOwner {
  medicationId: string;
  mode: 'create' | 'edit';
  scheduleId?: string;
}

export interface MedicationStockRouteIntent extends RouteOwner {
  medicationId: string;
}

export interface CaregiverDetailRouteIntent extends RouteOwner {
  relationshipId: string;
}

interface TimedIntent<T extends RouteOwner> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;

let medicationDetail: TimedIntent<MedicationDetailRouteIntent> | null = null;
let medicationEdit: TimedIntent<MedicationEditRouteIntent> | null = null;
let medicationSchedule: TimedIntent<MedicationScheduleRouteIntent> | null = null;
let medicationStock: TimedIntent<MedicationStockRouteIntent> | null = null;
let caregiverDetail: TimedIntent<CaregiverDetailRouteIntent> | null = null;

function write<T extends RouteOwner>(value: T): TimedIntent<T> {
  return { value, expiresAt: Date.now() + TTL_MS };
}

function read<T extends RouteOwner>(
  slot: TimedIntent<T> | null,
  userId: string,
  patientProfileId: string,
): T | null {
  if (!slot || Date.now() >= slot.expiresAt) return null;
  if (slot.value.userId !== userId || slot.value.patientProfileId !== patientProfileId) return null;
  return slot.value;
}

export function setMedicationDetailRouteIntent(value: MedicationDetailRouteIntent): void {
  medicationDetail = write(value);
}

export function getMedicationDetailRouteIntent(
  userId: string,
  patientProfileId: string,
): MedicationDetailRouteIntent | null {
  const value = read(medicationDetail, userId, patientProfileId);
  if (medicationDetail && Date.now() >= medicationDetail.expiresAt) medicationDetail = null;
  return value;
}

export function setMedicationEditRouteIntent(value: MedicationEditRouteIntent): void {
  medicationEdit = write(value);
}

export function getMedicationEditRouteIntent(
  userId: string,
  patientProfileId: string,
): MedicationEditRouteIntent | null {
  const value = read(medicationEdit, userId, patientProfileId);
  if (medicationEdit && Date.now() >= medicationEdit.expiresAt) medicationEdit = null;
  return value;
}

export function setMedicationScheduleRouteIntent(value: MedicationScheduleRouteIntent): void {
  medicationSchedule = write(value);
}

export function getMedicationScheduleRouteIntent(
  userId: string,
  patientProfileId: string,
): MedicationScheduleRouteIntent | null {
  const value = read(medicationSchedule, userId, patientProfileId);
  if (medicationSchedule && Date.now() >= medicationSchedule.expiresAt) medicationSchedule = null;
  return value;
}

export function setMedicationStockRouteIntent(value: MedicationStockRouteIntent): void {
  medicationStock = write(value);
}

export function getMedicationStockRouteIntent(
  userId: string,
  patientProfileId: string,
): MedicationStockRouteIntent | null {
  const value = read(medicationStock, userId, patientProfileId);
  if (medicationStock && Date.now() >= medicationStock.expiresAt) medicationStock = null;
  return value;
}

export function setCaregiverDetailRouteIntent(value: CaregiverDetailRouteIntent): void {
  caregiverDetail = write(value);
}

export function getCaregiverDetailRouteIntent(
  userId: string,
  patientProfileId: string,
): CaregiverDetailRouteIntent | null {
  const value = read(caregiverDetail, userId, patientProfileId);
  if (caregiverDetail && Date.now() >= caregiverDetail.expiresAt) caregiverDetail = null;
  return value;
}

export function clearClinicalRouteIntents(): void {
  medicationDetail = null;
  medicationEdit = null;
  medicationSchedule = null;
  medicationStock = null;
  caregiverDetail = null;
}
