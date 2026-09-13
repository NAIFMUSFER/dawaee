import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearMedicationDrafts,
  getMedicationConfirmDraft,
  getMedicationPrefillDraft,
  setMedicationConfirmDraft,
  setMedicationPrefillDraft,
} from '../src/storage/medication-draft.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

function source(path: string): string {
  return readFileSync(resolve(appRoot, path), 'utf8');
}

afterEach(() => {
  clearMedicationDrafts();
  vi.useRealTimers();
});

describe('medication capture privacy handoff', () => {
  it('never serializes OCR or medication prefill into navigation query strings', () => {
    const capture = source('app/medication/capture.tsx');
    const confirm = source('app/medication/confirm.tsx');
    const quickCreate = source('app/medication/quick-create.tsx');

    expect(capture).not.toContain('confirm?data=');
    expect(capture).not.toContain('JSON.stringify(payload)');
    expect(confirm).not.toContain('quick-create?prefill=');
    expect(confirm).not.toContain('JSON.stringify(prefill)');
    expect(quickCreate).not.toContain('params.prefill');

    expect(capture).toContain("router.replace('/medication/confirm')");
    expect(confirm).toContain("router.replace('/medication/quick-create?source=capture')");
  });

  it('binds drafts to one profile and refuses cross-profile reuse', () => {
    setMedicationConfirmDraft({
      patientProfileId: 'profile-a',
      imageKey: 'private-object-key',
      kind: 'medication_label',
      detected: { name: { value: 'Private Medicine', confidence: 0.99 } },
      remainingLines: 0,
    });

    expect(getMedicationConfirmDraft('profile-b')).toBeNull();
    expect(getMedicationConfirmDraft('profile-a')).toBeNull();

    setMedicationPrefillDraft({
      patientProfileId: 'profile-a',
      name: 'Private Medicine',
      imageKey: 'private-object-key',
      identitySource: 'ocr_confirmed_by_user',
    });
    expect(getMedicationPrefillDraft('profile-b')).toBeNull();
    expect(getMedicationPrefillDraft('profile-a')).toBeNull();
  });

  it('expires process-local drafts instead of persisting health data', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T05:00:00Z'));

    setMedicationConfirmDraft({
      patientProfileId: 'profile-a',
      imageKey: 'private-object-key',
      kind: 'prescription',
      detected: { name: { value: 'Private Medicine', confidence: 0.9 } },
      remainingLines: 1,
    });
    expect(getMedicationConfirmDraft('profile-a')?.detected.name?.value).toBe('Private Medicine');

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(getMedicationConfirmDraft('profile-a')).toBeNull();

    const storageSource = source('src/storage/medication-draft.ts');
    expect(storageSource).not.toMatch(/AsyncStorage|SecureStore|localStorage|sessionStorage/);
  });
});
