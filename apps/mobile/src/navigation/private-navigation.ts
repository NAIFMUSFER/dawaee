interface MedicationDetailSelection {
  patientProfileId: string;
  medicationId: string;
}

interface TimedSelection<T> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;
let medicationDetailSelection: TimedSelection<MedicationDetailSelection> | null = null;

/**
 * Process-local browser-navigation handoff for sensitive medication identity.
 *
 * Stable health-linked identifiers must not be serialized into Expo Router path
 * or query parameters: on web those values become browser history/referrer
 * material and a reload reaches the hosting platform request log before the app
 * can redact anything. A reload intentionally drops this selection and fails
 * closed instead of reconstructing a medication identity from the public URL.
 */
export function setMedicationDetailSelection(value: MedicationDetailSelection): void {
  medicationDetailSelection = { value, expiresAt: Date.now() + TTL_MS };
}

export function getMedicationDetailSelection(patientProfileId: string): MedicationDetailSelection | null {
  const slot = medicationDetailSelection;
  if (!slot || Date.now() >= slot.expiresAt || slot.value.patientProfileId !== patientProfileId) {
    medicationDetailSelection = null;
    return null;
  }
  return slot.value;
}

export function clearMedicationDetailSelection(): void {
  medicationDetailSelection = null;
}
