import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const { createHarness } = require('./profile-screen-harness.cjs');
const scopeHook = resolve('apps/mobile/src/hooks/useRequestScope.ts');
const payload = { profileId: 'A', data: { auditLog: [{ action: 'SYNTHETIC-RECORD' }], doseEvents: [{ event_type: 'taken' }], refills: [{ quantity: 1 }] } };

function outputScreen(file: string, globals: Record<string, unknown> = {}) {
  let blocked = false;
  const outputs: Array<{ value: unknown; current: () => boolean }> = [];
  const h = createHarness(resolve(file), scopeHook, { role: 'owner' }, {
    __globals: globals,
    '@/security/AppLockContext': { useAppLock: () => ({ contentBlocked: blocked }) },
    '@/privacy/share-full-export': { shareFullExport: async (value: unknown, _title: string, current: () => boolean) => {
      outputs.push({ value, current }); return true;
    } },
  });
  return { h, outputs, lock(value: boolean) { blocked = value; h.render(); } };
}

describe.each(['apps/mobile/app/reports/index.tsx', 'apps/mobile/app/settings/privacy.tsx'])('%s full output', file => {
  it('passes the intact API payload to the complete export action and fences later lock/unlock', async () => {
    const { h, outputs, lock } = outputScreen(file);
    try {
      const prepare = h.find('Button', (p: any) => p.label === 'reports.prepareExport');
      if (prepare) { prepare.onPress(); await h.flush(); }
      else { h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle').onPress(); await h.flush(); }
      h.requests.find((r: any) => r.route === '/v1/reports/export').resolve(payload); await h.flush();
      if (prepare) { h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle').onPress(); await h.flush(); }
      expect(outputs).toHaveLength(1); expect(outputs[0]!.value).toEqual(payload); expect(outputs[0]!.current()).toBe(true);
      lock(true); expect(outputs[0]!.current()).toBe(false);
      lock(false); expect(outputs[0]!.current()).toBe(false);
    } finally { h.unmount(); }
  });
  it('cannot export the previous profile or start an export while locked', async () => {
    const { h, outputs, lock } = outputScreen(file);
    try {
      const prepare = h.find('Button', (p: any) => p.label === 'reports.prepareExport');
      if (prepare) { prepare.onPress(); await h.flush(); }
      else { h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle').onPress(); await h.flush(); }
      h.switchProfile('B'); await h.flush();
      h.requests.find((r: any) => r.route === '/v1/reports/export').resolve(payload); await h.flush();
      expect(outputs).toEqual([]);
      lock(true);
      h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle')?.onPress(); await h.flush();
      expect(outputs).toEqual([]);
    } finally { h.unmount(); }
  });
});


describe('web output generation independent of AppState rendering', () => {
  it.each(['visibilitychange', 'pagehide'])('does not revive a pending export after %s then foreground', async eventName => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const win = new EventTarget();
    const { h, outputs } = outputScreen('apps/mobile/app/settings/privacy.tsx', { document: doc, window: win });
    try {
      h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle').onPress(); await h.flush();
      const pending = h.requests.find((r: any) => r.route === '/v1/reports/export');
      expect(pending).toBeTruthy();
      // No AppLock render is scheduled: output ownership must not rely on
      // React committing the intermediate hidden state before foreground.
      if (eventName === 'visibilitychange') { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event(eventName)); }
      else win.dispatchEvent(new Event(eventName));
      doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
      pending.resolve(payload); await h.flush();
      expect(outputs).toEqual([]);
      expect(h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle').loading).toBe(false);
      // Returning to the screen permits a new explicit export action.
      h.find('Button', (p: any) => p.label === 'privacy.fullExportTitle').onPress(); await h.flush();
      h.requests.filter((r: any) => r.route === '/v1/reports/export')[1].resolve(payload); await h.flush();
      expect(outputs).toHaveLength(1);
    } finally { h.unmount(); }
  });
});
