import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Executes the real reminder coordinator with controlled network and OS I/O.
 * This verifies schedule refresh and account isolation, not physical delivery. */
function harness() {
  vi.useFakeTimers();
  const effects: Array<() => () => void> = [];
  const listeners = new Set<() => void>();
  const foreground = new Set<(state: string) => void>();
  const calls: Array<{ query: any; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  const scheduled: any[] = [], cached: any[] = [];
  const stateRef = { current: {
    signedIn: true, user: { id: 'account-a', emailVerificationRequired: false },
    profiles: [{ id: 'own', isSelf: true, role: 'owner' }, { id: 'other-patient', isSelf: false, role: 'caregiver' }],
    activeProfile: { id: 'other-patient' },
    preferences: { locale: 'ar', voiceRemindersEnabled: false, showMedicationInNotifications: false },
  } };
  const generation = { current: 1 }, mounted = { current: true };
  const dependencies: Record<string, unknown> = {
    react: { useEffect: (fn: () => () => void) => effects.push(fn) },
    'react-native': { AppState: { addEventListener: (_: string, fn: (s: string) => void) => {
      foreground.add(fn); return { remove: () => foreground.delete(fn) };
    } } },
    '../api/clinical-changes.js': { subscribeClinicalChanges: (fn: () => void) => {
      listeners.add(fn); return () => listeners.delete(fn);
    } },
    '../api/client.js': { isSignedIn: () => stateRef.current.signedIn, api: { get: (_: string, query: any) =>
      new Promise((resolve, reject) => calls.push({ query, resolve, reject })) } },
    '../storage/offline-queue.js': { cacheSchedule: async (data: any) => { cached.push(data); } },
    '../notifications/index.js': { captureLocalReminderContext: () => () => true,
      rescheduleLocalNotifications: async (doses: any, locale: any, prefs: any) => { scheduled.push({ doses, locale, prefs }); } },
  };
  const module = { exports: {} as any };
  const source = ts.transpileModule(readFileSync(resolve('apps/mobile/src/hooks/useSelfReminderRefresh.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name];
  }, setTimeout, clearTimeout, Date });
  module.exports.useSelfReminderRefresh(stateRef.current, stateRef, generation, mounted);
  const cleanup = effects.map(fn => fn());
  return { calls, scheduled, cached, stateRef, generation,
    change: () => listeners.forEach(fn => fn()),
    foreground: () => foreground.forEach(fn => fn('active')),
    close: () => cleanup.forEach(fn => fn()),
    async wait() { await vi.advanceTimersByTimeAsync(101); },
    async resolve(index: number, name: string) {
      calls[index]!.resolve({ timezone: 'Asia/Riyadh', today: [{ id: name, medication: { name }, status: 'pending' }], prefetch: [] });
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('self reminder refresh after clinical writes', () => {
  it('refreshes the owner schedule even when viewing another patient, and includes a newly added drug', async () => {
    const h = harness();
    try {
      await h.wait(); expect(h.calls[0]?.query).toEqual({ profileId: 'own' });
      await h.resolve(0, 'old-drug');
      h.change(); h.change(); await h.wait();
      expect(h.calls).toHaveLength(2);
      await h.resolve(1, 'new-drug');
      expect(h.scheduled.map(r => r.doses[0].id)).toEqual(['old-drug', 'new-drug']);
      expect(h.cached.every(r => r.profileId === 'own')).toBe(true);
    } finally { h.close(); }
  });
  it('rejects stale requests after a newer medication write and retries on foreground', async () => {
    const h = harness();
    try {
      await h.wait(); h.change(); await h.wait();
      await h.resolve(0, 'stale-drug'); expect(h.scheduled).toHaveLength(0);
      await h.resolve(1, 'current-drug');
      h.foreground(); await h.wait(); expect(h.calls).toHaveLength(3);
      await h.resolve(2, 'foreground-drug');
      expect(h.scheduled.map(r => r.doses[0].id)).toEqual(['current-drug', 'foreground-drug']);
    } finally { h.close(); }
  });
  it('does not write patient data or reminders after logout/account transition', async () => {
    const h = harness();
    try {
      await h.wait(); h.generation.current++;
      await h.resolve(0, 'previous-account');
      expect(h.cached).toHaveLength(0); expect(h.scheduled).toHaveLength(0);
      h.stateRef.current.signedIn = false; h.change(); await h.wait();
      expect(h.calls).toHaveLength(1);
    } finally { h.close(); }
  });
  it('preserves existing reminders when offline and stops all refreshes on unmount', async () => {
    const h = harness(); await h.wait();
    h.calls[0]!.reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduled).toHaveLength(0);
    h.close(); h.change(); h.foreground(); await h.wait();
    expect(h.calls).toHaveLength(1);
  });
});
