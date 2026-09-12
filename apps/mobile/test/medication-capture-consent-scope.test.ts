import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * OCR consent is a patient-profile decision. The privacy screen and API both
 * support profile-specific grants, so the inline grant shown after an OCR 428
 * must not silently widen that decision to every patient managed by the same
 * account.
 */
describe('medication capture OCR consent scope', () => {
  it('grants OCR consent only for the active patient profile', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../app/medication/capture.tsx', import.meta.url)),
      'utf8',
    );
    const start = source.indexOf('const grantConsent = useCallback');
    const end = source.indexOf('const goManual = useCallback', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const grant = source.slice(start, end);

    expect(grant).toContain('patientProfileId: activeProfile.id');
    expect(grant).toMatch(/api\.put\('\/v1\/me\/consents',[\s\S]*patientProfileId/);
  });
});
