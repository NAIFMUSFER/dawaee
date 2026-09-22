import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Requests can fail with HTTP 429, 500, or 503, or an invalid response. The
 * API client deliberately preserves HTTP failures as ApiError rather than
 * misclassifying them as NetworkError. A cold screen must therefore surface a
 * retryable error state instead of falling through to an empty medication or
 * schedule state, which would falsely tell a patient or caregiver that there
 * is nothing due or that clinical data was not shared.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const { createHarness, ApiError, NetworkError } = createRequire(import.meta.url)('./profile-screen-harness.cjs');

describe('request failures never become clinical empty states', () => {
  for (const screen of ['today', 'medications']) {
    it(`${screen}: offline without cached data does not claim an empty clinical list`, async () => {
      const h = createHarness(join(ROOT, `apps/mobile/app/(tabs)/${screen}.tsx`),
        join(ROOT, 'apps/mobile/src/hooks/useRequestScope.ts'));
      try {
        h.fail(h.batch(), new NetworkError('offline'));
        await h.flush();
        expect(h.app.offline).toBe(true);
        expect(h.find('EmptyState')).toBeNull();
        expect(h.find('Button', (props: any) => props.label === 'common.retry')).not.toBeNull();
      } finally { h.unmount(); }
    });
    for (const status of [429, 500, 503]) {
      it(`${screen}: HTTP ${status} shows retry, and a successful retry restores clinical data`, async () => {
        const h = createHarness(join(ROOT, `apps/mobile/app/(tabs)/${screen}.tsx`),
          join(ROOT, 'apps/mobile/src/hooks/useRequestScope.ts'));
        try {
          const error = new ApiError('internal_error');
          error.status = status;
          h.fail(h.batch(), error);
          await h.flush();
          expect(h.find('EmptyState')).toBeNull();
          expect(h.app.offline).toBe(false);
          const retry = h.find('Button', (props: any) => props.label === 'common.retry');
          expect(retry).not.toBeNull();
          retry.onPress();
          h.answer(h.batch(), 'RETRY');
          await h.flush();
          expect(h.text()).toContain('SYNTHETIC-RETRY-ONLY');
          expect(h.find('Button', (props: any) => props.label === 'common.retry')).toBeNull();
        } finally { h.unmount(); }
      });
    }
    it(`${screen}: an unexpected client failure is not an empty schedule`, async () => {
      const h = createHarness(join(ROOT, `apps/mobile/app/(tabs)/${screen}.tsx`),
        join(ROOT, 'apps/mobile/src/hooks/useRequestScope.ts'));
      try {
        h.fail(h.batch(), new Error('invalid response'));
        await h.flush();
        expect(h.find('EmptyState')).toBeNull();
        expect(h.find('Button', (props: any) => props.label === 'common.retry')).not.toBeNull();
      } finally { h.unmount(); }
    });
  }

  it('Caregiver dashboard does not turn an initial transport or API failure into no-doses or not-shared claims', () => {
    const src = source('apps/mobile/app/caregiver/dashboard.tsx');
    expect(src).toContain(
      'const loadFailedWithoutClinicalData = (offline || error !== null) && today === null && adherence === null;',
    );
    expect(src).toMatch(/if \(err instanceof NetworkError\) setOffline\(true\);/);
    expect(src).toMatch(/loadFailedWithoutClinicalData\s*\?\s*null\s*:\s*!canSeeToday/);
    expect(src).toMatch(/loadFailedWithoutClinicalData\s*\?\s*null\s*:\s*!can\('view_adherence'\)\s*\|\|\s*!adherence/);
    expect(src.indexOf('loadFailedWithoutClinicalData ? null : !canSeeToday'))
      .toBeLessThan(src.indexOf("t('caregiver.noDosesToday')"));
    expect(src.indexOf('loadFailedWithoutClinicalData ? null : !can(\'view_adherence\')'))
      .toBeLessThan(src.lastIndexOf("t('caregiver.notShared'"));
  });
});
