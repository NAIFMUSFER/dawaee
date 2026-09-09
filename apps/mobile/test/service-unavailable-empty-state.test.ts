import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Render's free web service can answer HTTP 503 while the instance wakes. The
 * API client deliberately preserves HTTP failures as ApiError rather than
 * misclassifying them as NetworkError. A cold screen must therefore surface a
 * retryable service-unavailable state instead of falling through to an empty
 * medication/schedule state, which would falsely tell the patient there is
 * nothing due or no medication configured.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('503 never becomes a clinical empty state', () => {
  for (const [name, path] of [
    ['Today', 'apps/mobile/app/(tabs)/today.tsx'],
    ['Medications', 'apps/mobile/app/(tabs)/medications.tsx'],
  ] as const) {
    it(`${name} records and renders an ApiError 503`, () => {
      const src = source(path);
      expect(src).toContain('ApiError');
      expect(src).toMatch(/err\s+instanceof\s+ApiError\s*&&\s*err\.status\s*===\s*503/);
      expect(src).toContain('serviceUnavailable');
      expect(src).toContain('setServiceUnavailable(true)');
    });
  }

  it('Today suppresses the no-medications empty state while service is unavailable', () => {
    const src = source('apps/mobile/app/(tabs)/today.tsx');
    expect(src).toMatch(/serviceUnavailable\s*\?\s*\([\s\S]*?<Banner[\s\S]*?\)\s*:\s*todayList\.length\s*===\s*0\s*\?/);
  });

  it('Medications suppresses the empty list while service is unavailable', () => {
    const src = source('apps/mobile/app/(tabs)/medications.tsx');
    expect(src).toMatch(/serviceUnavailable\s*\?\s*\([\s\S]*?<Banner[\s\S]*?\)\s*:\s*medications\.length\s*===\s*0\s*\?/);
  });
});
