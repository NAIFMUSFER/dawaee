import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleVisionOcrProvider, parseMedicationText, parsePrescriptionText } from '../src/providers/ocr.js';
import { loadConfig, resetConfigCache } from '../src/config.js';

const provider = () => new GoogleVisionOcrProvider(loadConfig({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://unused:unused@127.0.0.1:5432/unused',
  JWT_SECRET: 'audit-test-value-not-secret-01234567890123456789', IP_HASH_SALT: 'audit-test-salt',
  GOOGLE_VISION_API_KEY: 'synthetic-not-a-secret',
}));
const read = () => provider().readMedicationLabel(Buffer.from('synthetic-image'));
afterEach(() => { vi.unstubAllGlobals(); resetConfigCache(); });

describe('OCR failure classification and honest field provenance', () => {
  it.each([
    [403, { error: { details: [{ reason: 'BILLING_DISABLED' }], message: 'PRIVATE-PROJECT' } }, 'ocr_billing'],
    [401, { error: { message: 'PRIVATE-CREDENTIAL' } }, 'ocr_configuration'],
    [403, { error: { message: 'PRIVATE-PROJECT' } }, 'ocr_configuration'],
    [200, { responses: [{ error: { code: 7, message: 'PRIVATE-PROJECT' } }] }, 'ocr_configuration'],
    [429, { error: { message: 'PRIVATE-QUOTA' } }, 'provider_unavailable'],
    [200, { responses: [{}] }, 'ocr_no_text'],
  ])('classifies HTTP %s without reflecting upstream content', async (status, body, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
    const failure = await read().catch((e) => e);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain('PRIVATE-');
  });
  it('reports the provider deadline separately from no readable text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('private timeout context', 'TimeoutError')));
    await expect(read()).rejects.toMatchObject({ code: 'ocr_timeout', statusCode: 504 });
  });
  it('does not turn box strength into a dose schedule or invented provider confidence', async () => {
    const text = 'Synthetic medicine\n500 mg\ntablets';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text } }] }))));
    const result = await read();
    expect(result.fields.strengthValue?.value).toBe(500);
    expect(result.fields).not.toHaveProperty('frequency');
    expect(result.fields).not.toHaveProperty('doseQuantity');
    for (const field of Object.values(result.fields)) expect(field?.confidenceSource).toBe('heuristic');
    expect(parseMedicationText('', 'google_vision').fields).toEqual({});
    const prescription = parsePrescriptionText('Synthetic 10 mg twice daily for 3 days', 'google_vision');
    for (const line of prescription.lines) for (const field of Object.values(line)) {
      if (field && typeof field === 'object' && 'confidence' in field) expect(field.confidenceSource).toBe('heuristic');
    }
  });
});
