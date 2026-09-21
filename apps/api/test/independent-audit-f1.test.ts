import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';
import type { AppState } from '../../mobile/src/state/app-store.js';

vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withTransaction: (fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn),
  withUser: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid),
  withUserReadOnly: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid, true),
}));
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerProfileRoutes } from '../src/routes/profiles.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { createSession } from '../src/auth/session-service.js';
import { loadConfig } from '../src/config.js';

let db: PGlite;
const http = Fastify();
const owner = (sql: string, values: unknown[] = []) => auditTransaction(db, 'dawaee_migrator', tx => tx.query(sql, values));
beforeAll(async () => {
  db = await createAuditDatabase();
  registerErrorHandler(http); registerAuthRoutes(http); registerProfileRoutes(http); await http.ready();
}, 60_000);
afterAll(async () => { await http.close(); await db?.close(); });

function moduleAt<T>(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, URL, Response, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: { EXPO_PUBLIC_API_URL: 'https://audit.invalid', EXPO_PUBLIC_DEMO: '0' } },
    require: (name: string) => { if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`); return mocks[name]; },
    ...globals,
  }, { filename: file });
  return module.exports as T;
}

describe('F1: committed refresh response lost between server and installed client', () => {
  it('recovers without canceling reminders or discarding queued dose confirmations', async () => {
    const user = randomUUID(), profile = randomUUID();
    await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [user, `${user}@example.test`, 'Synthetic audit']);
    await owner('INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self) VALUES($1,$2,$3,true)', [profile, user, 'Synthetic self']);
    const session = await auditTransaction(db, 'dawaee_app', tx => createSession(tx, user, { deviceId: 'audit-f1-device' }));
    const cfg = loadConfig();
    const expired = await new SignJWT({ sid: session.sessionId, role: 'user' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user).setIssuer(cfg.JWT_ISSUER)
      .setAudience('dawaee-client').setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(new TextEncoder().encode(cfg.JWT_SECRET));
    let stored: { accessToken: string; refreshToken: string } | null = { accessToken: expired, refreshToken: session.refreshToken };
    const refreshStatuses: number[] = [];
    const requested: string[] = [];
    let dropped = false, cancellations = 0, queuedActions = 2, tokenClears = 0;
    const purged: Array<string | null> = [], destroyed: string[] = [];
    const cleanups: Array<() => void> = [], effects: Array<() => unknown> = [];
    let state!: AppState;
    const root = 'apps/mobile/src/';
    const changes = moduleAt(root + 'api/access-changes.ts', {});
    const clinical = moduleAt(root + 'api/clinical-changes.ts', {});
    const client = moduleAt<typeof import('../../mobile/src/api/client.js')>(root + 'api/client.ts', {
      '@react-native-async-storage/async-storage': { getItem: async () => 'audit-f1-device', setItem: async () => undefined },
      'expo-constants': {}, './access-changes.js': changes, './clinical-changes.js': clinical,
      './token-store.js': {
        readSession: async () => stored,
        writeSession: async (next: NonNullable<typeof stored>) => { stored = next; },
        clearStoredSession: async () => { tokenClears++; stored = null; },
      },
    }, {
      fetch: async (url: string, options: RequestInit) => {
        const path = new URL(url).pathname; requested.push(path);
        const response = await http.inject({ method: options.method as 'GET' | 'POST', url: path,
          headers: options.headers as Record<string, string>, payload: options.body as string | undefined,
          remoteAddress: '198.18.61.1' });
        if (path === '/v1/auth/refresh') {
          refreshStatuses.push(response.statusCode);
          if (!dropped && response.statusCode === 200) {
            dropped = true; // The real route has already committed its SQL transaction.
            throw new TypeError('Synthetic response lost after commit');
          }
        }
        return new Response(response.body, { status: response.statusCode });
      },
    });
    const provider = moduleAt<typeof import('../../mobile/src/state/app-store.js')>(root + 'state/app-store.tsx', {
      react: {
        createContext: () => ({ Provider: 'provider' }),
        useState: (initial: AppState) => { state = initial; return [state, (next: AppState | ((s: AppState) => AppState)) => { state = typeof next === 'function' ? next(state) : next; }]; },
        useRef: (current: unknown) => ({ current }), useEffect: (effect: () => unknown) => effects.push(effect),
        useMemo: (factory: () => unknown) => factory(), useCallback: (callback: unknown) => callback,
        useContext: () => { throw new Error('No mounted consumer'); },
      },
      'react/jsx-runtime': { jsx: (_type: unknown, props: unknown) => props },
      'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
      'expo-localization': { getLocales: () => [{ languageCode: 'en' }] },
      '../api/client.js': client, '../api/access-changes.js': changes, '../api/clinical-changes.js': clinical,
      '../security/profile-permissions.js': moduleAt(root + 'security/profile-permissions.ts', {}),
      '../hooks/useSelfReminderRefresh.js': { useSelfReminderRefresh: () => undefined },
      '../api/restored-session-owner.js': { getRestoredSessionUserId: async () => user },
      '../storage/offline-queue.js': {
        subscribeQueueChanges: () => () => undefined, invalidateCachedProfile: async () => undefined,
        restoreCachedProfiles: () => undefined, flushQueue: async () => ({ offline: false }),
        purgeLocalCaches: async (id: string | null) => { purged.push(id); queuedActions = 0; },
        queueSize: async () => queuedActions, setCacheOwner: () => undefined,
        readOfflineBootstrap: async () => ({ version: 1, user: { id: user, displayName: 'Synthetic audit', phoneE164: null },
          preferences: state.preferences, selfProfile: { id: profile, displayName: 'Synthetic self', isSelf: true, role: 'owner', permissions: null } }),
        writeOfflineBootstrap: async () => true,
      },
      '../storage/notification-privacy-intent.js': {
        acknowledgePrivacyHide: async () => undefined, cancelPrivacyHidePending: async () => undefined,
        markPrivacyHidePending: async () => 'synthetic-intent', privacyHidePendingCount: async () => 0,
        purgePrivacyHideIntents: async () => undefined, readPrivacyHideIntent: async () => ({ kind: 'none' }),
      },
      '../storage/locale-preference.js': { readLocalePreference: async () => 'en', writeLocalePreference: async () => true },
      '../i18n/index.js': { applyNativeDirection: () => ({ restartRequired: false }) },
      '../notifications/index.js': { cancelAllLocalNotifications: async () => { cancellations++; }, rebuildRemindersFromCache: async () => undefined },
      '../storage/cache-key.js': { destroyCacheKey: async (id: string) => { destroyed.push(id); } },
    });
    // Complete shipped client and provider; only the React/native/storage hosts
    // are doubles. This cannot establish iOS notification presentation.
    provider.AppProvider({ children: null });
    for (const effect of effects) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void); }
    try {
      for (let i = 0; i < 100 && !state.ready; i++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(state.ready).toBe(true); expect(dropped).toBe(true);
      expect(refreshStatuses).toEqual([200]);
      expect(client.isSignedIn()).toBe(true); expect(cancellations).toBe(0); expect(queuedActions).toBe(2);
      const rotated = (await owner('SELECT revoked_at,replaced_by FROM auth_sessions WHERE id=$1', [session.sessionId])).rows[0];
      expect(rotated.revoked_at).not.toBeNull(); expect(rotated.replaced_by).not.toBeNull();
      let retryError: unknown;
      try { await client.api.get('/v1/me'); } catch (error) { retryError = error; }
      await new Promise<void>(resolve => setImmediate(resolve));
      console.info('F1 loss measurements', JSON.stringify({ refreshStatuses, cancellations, tokenClears,
        purgeCount: purged.length, destroyedKeyCount: destroyed.length, queuedActions,
        signedIn: client.isSignedIn(), requests: requested.length }));
      expect.soft(retryError, 'F1: retrying the committed-but-lost rotation must recover').toBeUndefined();
      expect.soft(client.isSignedIn()).toBe(true);
      expect.soft(cancellations).toBe(0);
      expect.soft(queuedActions).toBe(2);
      expect.soft(purged).toEqual([]); expect.soft(destroyed).toEqual([]);
    } finally { for (const cleanup of cleanups) cleanup(); }
  });
});
