import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@dawaee/core';

const require = createRequire(import.meta.url);
const { createHarness, ApiError } = require('./profile-screen-harness.cjs');
const hook = resolve('apps/mobile/src/hooks/useRequestScope.ts');
const setups: any[] = [];

function screen(file: string, overrides: object = {}) {
  const h = createHarness(resolve(`apps/mobile/app/${file}`), hook, {}, overrides);
  setups.push(h);
  return h;
}

afterEach(() => {
  for (const h of setups.splice(0)) h.unmount();
  vi.useRealTimers();
});

describe('reported clinical screen errors', () => {
  it('offers retry after a failed family load without inventing a caregiver access decision', async () => {
    const h = screen('(tabs)/family.tsx');
    h.fail(h.batch(), new ApiError('validation_failed'));
    await h.flush();
    expect(h.find('Banner', (p: any) => p.title === 'family.loadError')).toBeTruthy();
    expect(h.find('CaregiverSelfView')).toBeNull();
    expect(h.find('OwnerView')).toBeNull();
    const retry = h.find('Button', (p: any) => p.label === 'common.retry');
    expect(retry).toBeTruthy();
    retry.onPress();
    for (const r of h.batch()) {
      r.completed = true;
      r.resolve({ viewerRole: 'owner', caregivers: [], presets: {} });
    }
    await h.flush();
    expect(h.find('OwnerView')).toBeTruthy();
    expect(h.find('Banner', (p: any) => p.title === 'family.loadError')).toBeNull();
  });

  it('treats a null family response as a retryable load error', async () => {
    const h = screen('(tabs)/family.tsx');
    for (const r of h.batch()) { r.completed = true; r.resolve(null); }
    await h.flush();
    expect(h.find('Banner', (p: any) => p.title === 'family.loadError')).toBeTruthy();
    expect(h.find('CaregiverSelfView')).toBeNull();
  });

  it('asks for a fresh medication selection after the navigation handoff is lost', async () => {
    const h = screen('medication/detail.tsx', {
      '@/components/MedicationDetailView': {
        MedicationDetailView: (props: any) => ({ type: 'MedicationDetailView', props }),
      },
    });
    await h.flush();
    expect(h.batch()).toHaveLength(0);
    expect(h.text()).not.toContain('error.not_found');
    const choose = h.find('Button', (p: any) => p.label === 'medication.listTitle');
    expect(choose).toBeTruthy();
    choose.onPress();
    expect(h.routes).toEqual(['/(tabs)/medications']);
  });

  it('sends ISO history dates even if the device formats en-CA as month/day/year', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T22:05:00.000Z'));
    const deviceIntl = Object.create(Intl);
    deviceIntl.DateTimeFormat = class extends Intl.DateTimeFormat {
      constructor(locale: string, options: Intl.DateTimeFormatOptions) {
        super(locale, options);
        Object.defineProperty(this, 'format', { value: () => '09/16/2026' });
      }
    };
    const h = screen('(tabs)/history.tsx', {
      '@dawaee/core': core,
      __globals: { Intl: deviceIntl },
    });
    await h.flush();
    const request = h.batch().find((r: any) => r.route === '/v1/doses');
    expect(request?.payload).toMatchObject({ from: '2026-09-13', to: '2026-09-19' });
  });
});
