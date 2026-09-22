import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it } from 'vitest';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const DELIVERY_ID = '01234567-89ab-4cde-8fab-0123456789ab';
type Listener = (response: unknown) => void;

function response(kind = 'escalation', identifier = 'native-notification-1', action = DEFAULT_ACTION) {
  return {
    actionIdentifier: action,
    notification: { request: { identifier, content: { data: { kind, deliveryId: DELIVERY_ID } } } },
  };
}

function executeSource(path: string, requireMock: (id: string) => unknown, suffix = '') {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8') + suffix;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
    fileName: path,
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled, { module, exports: module.exports, require: requireMock });
  return module.exports;
}

/** Runs the actual Shell and listener source. React/Expo are boundary doubles,
 * not a device simulator; no SQL, push provider or production account is used. */
function harness(options: { platform?: string; last?: unknown; signedIn?: boolean; ready?: boolean } = {}) {
  const routes: string[] = [];
  const listeners = new Set<Listener>();
  let last: unknown = options.last ?? null;
  let readLast: () => Promise<unknown> = async () => last;
  let clearCount = 0;
  let nativeImports = 0;
  let registrations = 0;
  let actionSubscriptions = 0;
  const native = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    getLastNotificationResponseAsync: () => readLast(),
    clearLastNotificationResponseAsync: async () => { clearCount += 1; last = null; },
    addNotificationResponseReceivedListener: (listener: Listener) => {
      listeners.add(listener);
      return { remove: () => { listeners.delete(listener); } };
    },
  };
  const router = { replace: (path: string) => { routes.push(path); } };
  const state: Record<string, unknown> = {
    ready: options.ready ?? true, signedIn: options.signedIn ?? true,
    user: { id: 'caregiver-A' }, activeProfile: null, deviceId: null,
    preferences: { locale: 'ar', numeralSystem: 'western', calendarSystem: 'gregorian' },
    syncNow: async () => undefined,
  };
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let refIndex = 0;
  let effectIndex = 0;
  let pending: Array<() => void> = [];
  const react = {
    createElement: (..._args: unknown[]) => ({}),
    useRef: (initial: unknown) => {
      const index = refIndex++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const index = effectIndex++;
      const previous = effects[index];
      if (previous && deps.length === previous.deps.length
          && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: effect() };
      });
    },
  };
  const noop = () => undefined;
  let intentModule: Record<string, unknown> | undefined;
  let patientIntentModule: Record<string, unknown> | undefined;
  const requireMock = (id: string): unknown => {
    switch (id) {
      case 'react': return react;
      case 'expo-router': return { Stack: noop, useRouter: () => router };
      case 'expo-status-bar': return { StatusBar: noop };
      case 'react-native-safe-area-context': return { SafeAreaProvider: noop };
      case 'react-native': return { Platform: { OS: options.platform ?? 'android' }, View: noop, Alert: {}, AppState: { addEventListener: () => ({ remove: noop }) } };
      case '@/state/app-store': return { AppProvider: noop, useApp: () => state };
      case '@/i18n': return { I18nProvider: noop };
      case '@/components/ui': return { Loading: noop, PreviewBanner: noop };
      case '@dawaee/shared': return { PALETTE: { background: '#fff' } };
      case '@/api/client': return { DEMO_MODE: false };
      case '@/security/AppLockGate': return { AppLockGate: noop };
      case '@/security/PrivacyModal': return { PrivacyModal: noop };
      case './settings/email-verification': return { default: noop };
      case '@/storage/pending-invite': return { landingAfterAuth: async () => '/caregiver/accept' };
      case '@/security/email-onboarding': return executeSource('apps/mobile/src/security/email-onboarding.ts', requireMock);
      case '@/navigation/private-navigation': return { clearClinicalRouteIntents: noop };
      case '@/navigation/AppNavigator': return { default: noop };
      case '@/components/AccountDeletionNotice': return { PendingDeletionScreen: noop, DeletionReceiptNotice: noop };
      case '@/components/NotificationHealthNotice': return { NotificationHealthNotice: noop };
      case '@/components/WebAlertHost': return { default: noop };
      case '@/storage/medication-draft': return { clearMedicationDrafts: noop };
      case '@/notifications': return {
        configureCategories: async () => undefined, configureChannels: async () => undefined,
        syncPushRegistration: async () => { registrations++; },
        subscribeNotificationPermissionChanges: () => noop, resetPushRegistrationStatus: noop,
        startNotificationActionListener: async () => { actionSubscriptions++; return noop; },
      };
      case '@/notifications/caregiver-navigation':
        return executeSource('apps/mobile/src/notifications/caregiver-navigation.ts', requireMock);
      case '@/notifications/grouped-navigation':
        return executeSource('apps/mobile/src/notifications/grouped-navigation.ts', requireMock);
      case '@/notifications/caregiver-intent':
        return intentModule ??= executeSource('apps/mobile/src/notifications/caregiver-intent.ts', requireMock);
      case '@/notifications/patient-intent':
        return patientIntentModule ??= executeSource('apps/mobile/src/notifications/patient-intent.ts', requireMock);
      case 'expo-notifications': nativeImports += 1; return native;
      default: throw new Error(`Unexpected test dependency: ${id}`);
    }
  };
  const mod = executeSource('apps/mobile/app/_layout.tsx', requireMock, '\nexport { Shell as TestShell };\n');
  const shell = mod.TestShell as () => unknown;
  return {
    routes, listeners,
    get clears() { return clearCount; },
    get imports() { return nativeImports; },
    get registrations() { return registrations; },
    get actionSubscriptions() { return actionSubscriptions; },
    get patientIntent() { return (patientIntentModule?.getPatientReminderIntent as () => unknown)?.(); },
    get intent() { return (intentModule?.getCaregiverNotificationIntent as () => unknown)?.(); },
    setReadLast: (read: () => Promise<unknown>) => { readLast = read; },
    render(overrides: Record<string, unknown> = {}, commitEffects = true) {
      Object.assign(state, overrides);
      refIndex = 0; effectIndex = 0; pending = [];
      const tree = shell();
      if (commitEffects) for (const commit of pending) commit();
      return tree;
    },
    emit(value: unknown) { last = value; for (const listener of listeners) listener(value); },
    dispose() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }

// Only fixed, non-clinical routing is permitted with the minimized payload.
// Delivery selection is handed off in memory; only the authenticated landing
// can resolve identity. Never guess the active or first followed patient.
describe('caregiver push navigation from the shipped Shell', () => {
  it('starts registration and action consumption only after the authenticated owner is ready', async () => {
    const h = harness({ ready: false });
    h.render({ deviceId: 'synthetic-device' }); await flush();
    assert.equal(h.registrations, 0);
    assert.equal(h.actionSubscriptions, 0);
    h.render({ ready: true }); await flush();
    assert.equal(h.registrations, 1);
    assert.equal(h.actionSubscriptions, 1);
    h.render({ user: { id: 'new-account' } }); await flush();
    assert.equal(h.registrations, 2);
    assert.equal(h.actionSubscriptions, 2);
    h.dispose();
  });
  it('routes a single patient reminder through the account-bound patient resolver', async () => {
    const value = response('dose_reminder');
    Object.assign(value.notification.request.content.data, { doseId: 'synthetic-patient-dose' });
    const h = harness({ last: value }); h.render(); await flush();
    assert.deepEqual(h.routes, ['/notification']);
    assert.equal((h.patientIntent as any).doseId, 'synthetic-patient-dose');
    assert.equal((h.patientIntent as any).userId, 'caregiver-A');
    h.dispose();
  });
  it('opens the neutral landing for a live Android escalation without a doseId', async () => {
    const h = harness(); h.render(); await flush(); h.emit(response()); await flush();
    const selected = h.intent as Record<string, unknown>;
    assert.equal(selected.userId, 'caregiver-A');
    assert.equal(selected.deliveryId, DELIVERY_ID);
    assert.equal(selected.kind, 'escalation');
    assert.deepEqual(h.routes, ['/caregiver/notification']); h.dispose();
  });
  it('handles a cold-start iOS escalation and consumes it', async () => {
    const h = harness({ platform: 'ios', last: response() }); h.render(); await flush();
    assert.deepEqual(h.routes, ['/caregiver/notification']); assert.equal(h.clears, 1); h.dispose();
  });
  it('does not route the same native response twice', async () => {
    const h = harness({ last: response() }); h.render(); await flush();
    h.emit(response()); h.emit(response()); await flush();
    assert.deepEqual(h.routes, ['/caregiver/notification']); h.dispose();
  });
  for (const options of [{ signedIn: false }, { ready: false }, { platform: 'web' }]) {
    it(`does not navigate outside the signed-in native ready boundary: ${JSON.stringify(options)}`, async () => {
      const h = harness({ ...options, last: response() }); h.render(); await flush();
      h.emit(response()); await flush(); assert.deepEqual(h.routes, []); h.dispose();
    });
  }
  it('does not navigate before the account identity exists', async () => {
    const h = harness({ last: response() }); h.render({ user: null }); await flush();
    assert.deepEqual(h.routes, []); h.dispose();
  });
  it('ignores dose action buttons rather than navigating from them', async () => {
    const h = harness(); h.render(); await flush();
    h.emit(response('escalation', 'action-1', 'TAKEN')); await flush();
    assert.deepEqual(h.routes, []); h.dispose();
  });
  it('does not use a payload URL, patient id, or name as a navigation target', async () => {
    const value = response();
    Object.assign(value.notification.request.content.data, {
      url: 'https://untrusted.example/clinical?patient=secret', patientId: 'secret', patientName: 'not-a-route',
    });
    const h = harness({ last: value }); h.render(); await flush();
    assert.deepEqual(h.routes, ['/caregiver/notification']); h.dispose();
  });
  it('ignores malformed notification data', async () => {
    const h = harness(); h.render(); await flush();
    for (const value of [null, {}, { notification: {} }, response('unknown'),
      { ...response(), notification: { request: { identifier: 'bad', content: { data: { kind: 'escalation' } } } } }]) {
      h.emit(value);
    }
    await flush(); assert.deepEqual(h.routes, []); h.dispose();
  });
  it('fences an account switch synchronously before passive effect cleanup', async () => {
    const h = harness(); h.render(); await flush();
    h.render({ user: { id: 'caregiver-B' } }, false);
    h.emit(response()); await flush(); assert.deepEqual(h.routes, []); h.dispose();
  });
  it('fences logout synchronously before passive effect cleanup', async () => {
    const h = harness(); h.render(); await flush();
    h.render({ signedIn: false, user: null }, false);
    h.emit(response()); await flush(); assert.deepEqual(h.routes, []); h.dispose();
  });
  it('registers live handling before the cold-start lookup finishes', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });
    const h = harness(); h.setReadLast(() => pending); h.render(); await flush();
    h.emit(response('escalation', 'newer-live')); await flush();
    assert.deepEqual(h.routes, ['/caregiver/notification']);
    finish(response('escalation', 'older-cold')); await flush();
    assert.deepEqual(h.routes, ['/caregiver/notification']); h.dispose();
  });
  it('keeps live handling usable when reading the cold response fails', async () => {
    const h = harness(); h.setReadLast(async () => { throw new Error('native read failed'); });
    h.render(); await flush(); h.emit(response()); await flush();
    assert.deepEqual(h.routes, ['/caregiver/notification']); h.dispose();
  });
  it('does not act on callbacks or cold results after unmount', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });
    const h = harness(); h.setReadLast(() => pending); h.render(); await flush();
    const callbacks = [...h.listeners]; h.dispose();
    for (const callback of callbacks) callback(response());
    finish(response()); await flush(); assert.deepEqual(h.routes, []);
  });
  it('routes grouped patient reminders through patient selection', async () => {
    const h = harness({ last: response('dose_group_reminder') }); h.render(); await flush();
    assert.deepEqual(h.routes, ['/notification']); h.dispose();
  });
});

it('cleans up its subscription even when the native startup read throws synchronously', async () => {
  const h = harness(); h.setReadLast(() => { throw new Error('native bridge unavailable'); });
  h.render(); await flush(); h.dispose();
  assert.equal(h.listeners.size, 0);
});

it('loads both real default-tap listeners and keeps their routing and consumption separate', async () => {
  const h = harness(); h.render(); await flush();
  assert.equal(h.listeners.size, 2, 'both production navigation helpers must be exercised');
  for (const kind of ['dose_group_reminder', 'daily_summary', 'weekly_summary']) {
    h.emit(response(kind, `integration-${kind}`)); await flush();
  }
  assert.deepEqual(h.routes, ['/notification', '/caregiver/notification', '/caregiver/notification']);
  assert.equal(h.clears, 3, 'each matching response is consumed by exactly one listener');
  h.dispose();
  assert.equal(h.listeners.size, 0);
});

it('fences both real default-tap listeners before passive cleanup on account change', async () => {
  const h = harness(); h.render(); await flush();
  assert.equal(h.listeners.size, 2);
  h.render({ user: { id: 'account-B' } }, false);
  h.emit(response('dose_group_reminder', 'old-group'));
  h.emit(response('escalation', 'old-caregiver'));
  await flush();
  assert.deepEqual(h.routes, []);
  assert.equal(h.clears, 0);
  h.dispose();
});
