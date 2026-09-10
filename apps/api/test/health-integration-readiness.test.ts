import { describe, expect, it } from 'vitest';
import type { Providers } from '../src/providers/index.js';
import { assessIntegrationReadiness } from '../src/routes/health.js';

function providers(push: string, ocr: string, storage: string): Providers {
  return {
    push: { name: push },
    ocr: { name: ocr },
    storage: { name: storage },
  } as unknown as Providers;
}

describe('production integration readiness', () => {
  it('fails readiness when OCR is a mock and storage is unconfigured — the exact production evidence observed in the audit', () => {
    const result = assessIntegrationReadiness(providers('expo', 'mock', 'unconfigured'), true);

    expect(result.mockedIntegrations).toEqual(['ocr', 'storage']);
    expect(result.check.ok).toBe(false);
    expect(result.check.detail).toMatch(/ocr, storage/);
  });

  it('fails readiness on any development-only provider in production', () => {
    for (const [push, ocr, storage] of [
      ['mock', 'google_vision', 's3'],
      ['expo', 'unconfigured', 'r2'],
      ['expo', 'azure_document_intelligence', 'local'],
    ]) {
      expect(assessIntegrationReadiness(providers(push!, ocr!, storage!), true).check.ok).toBe(false);
    }
  });

  it('passes production readiness only when push, OCR, and storage are all real configured providers', () => {
    const result = assessIntegrationReadiness(providers('expo', 'google_vision', 's3'), true);
    expect(result.mockedIntegrations).toEqual([]);
    expect(result.check).toEqual({ ok: true, detail: 'configured' });
  });

  it('does not make development or test readiness fail merely because deterministic mocks are intentional there', () => {
    const result = assessIntegrationReadiness(providers('mock', 'mock', 'local'), false);
    expect(result.check.ok).toBe(true);
    expect(result.mockedIntegrations).toEqual(['push', 'ocr', 'storage']);
  });
});
