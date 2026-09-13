import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const MOBILE = resolve(ROOT, 'apps/mobile');

const FIXED_PRIVATE_ROUTES = [
  ['app/medication/edit.tsx', 'getMedicationEditRouteIntent'],
  ['app/medication/schedule.tsx', 'getMedicationScheduleRouteIntent'],
  ['app/medication/stock.tsx', 'getMedicationStockRouteIntent'],
] as const;

function source(relative: string): string {
  return readFileSync(resolve(MOBILE, relative), 'utf8');
}

describe('legacy medication query ingestion privacy', () => {
  it.each(FIXED_PRIVATE_ROUTES)(
    '%s never reconstructs clinical identifiers from browser search params',
    (relative, getter) => {
      const contents = source(relative);
      expect(contents).toContain(`${getter}(`);
      expect(contents).not.toContain('useLocalSearchParams');
      expect(contents).not.toMatch(/\blegacy(?:MedicationId|ScheduleId|Prefill|Mode)\b/);
    },
  );

  it('edit does not deserialize medication prefill data from the URL', () => {
    const contents = source('app/medication/edit.tsx');
    expect(contents).not.toContain('applyPrefill');
    expect(contents).not.toMatch(/\bprefill\b/);
  });
});
