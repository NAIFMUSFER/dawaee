import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearClinicalRouteIntents,
  getCaregiverDetailRouteIntent,
  getMedicationDetailRouteIntent,
  getMedicationEditRouteIntent,
  getMedicationScheduleRouteIntent,
  getMedicationStockRouteIntent,
  setCaregiverDetailRouteIntent,
  setMedicationDetailRouteIntent,
  setMedicationEditRouteIntent,
  setMedicationScheduleRouteIntent,
  setMedicationStockRouteIntent,
} from '../src/navigation/private-navigation.js';

const owner = { userId: 'account-a', patientProfileId: 'patient-a' };

afterEach(() => {
  clearClinicalRouteIntents();
  vi.useRealTimers();
});

describe('clinical route intent privacy boundary', () => {
  it('keeps destination intents independent and returns them only to their exact owner scope', () => {
    setMedicationDetailRouteIntent({ ...owner, medicationId: 'med-detail' });
    setMedicationEditRouteIntent({ ...owner, medicationId: 'med-edit' });
    setMedicationScheduleRouteIntent({ ...owner, medicationId: 'med-schedule', mode: 'edit', scheduleId: 'schedule-a' });
    setMedicationStockRouteIntent({ ...owner, medicationId: 'med-stock' });
    setCaregiverDetailRouteIntent({ ...owner, relationshipId: 'relationship-a' });

    expect(getMedicationDetailRouteIntent(owner.userId, owner.patientProfileId)?.medicationId).toBe('med-detail');
    expect(getMedicationEditRouteIntent(owner.userId, owner.patientProfileId)?.medicationId).toBe('med-edit');
    expect(getMedicationScheduleRouteIntent(owner.userId, owner.patientProfileId)).toMatchObject({
      medicationId: 'med-schedule', mode: 'edit', scheduleId: 'schedule-a',
    });
    expect(getMedicationStockRouteIntent(owner.userId, owner.patientProfileId)?.medicationId).toBe('med-stock');
    expect(getCaregiverDetailRouteIntent(owner.userId, owner.patientProfileId)?.relationshipId).toBe('relationship-a');

    expect(getMedicationDetailRouteIntent('account-b', owner.patientProfileId)).toBeNull();
    expect(getMedicationDetailRouteIntent(owner.userId, 'patient-b')).toBeNull();
    expect(getCaregiverDetailRouteIntent('account-b', owner.patientProfileId)).toBeNull();
  });

  it('expires every handoff instead of turning process memory into durable navigation storage', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'));
    setMedicationDetailRouteIntent({ ...owner, medicationId: 'medication-a' });

    vi.advanceTimersByTime(15 * 60 * 1000 - 1);
    expect(getMedicationDetailRouteIntent(owner.userId, owner.patientProfileId)?.medicationId).toBe('medication-a');

    vi.advanceTimersByTime(1);
    expect(getMedicationDetailRouteIntent(owner.userId, owner.patientProfileId)).toBeNull();
  });

  it('can purge all pending clinical selections on a privacy boundary', () => {
    setMedicationDetailRouteIntent({ ...owner, medicationId: 'medication-a' });
    setCaregiverDetailRouteIntent({ ...owner, relationshipId: 'relationship-a' });

    clearClinicalRouteIntents();

    expect(getMedicationDetailRouteIntent(owner.userId, owner.patientProfileId)).toBeNull();
    expect(getCaregiverDetailRouteIntent(owner.userId, owner.patientProfileId)).toBeNull();
  });
});
