import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type { ErrorCode } from '@dawaee/shared';
import { clearStoredSession, readSession, writeSession } from './token-store.js';

/**
 * API client.
 *
 * Responsibilities beyond "call fetch":
 *  - refreshes an expired access token once, transparently, and queues
 *    concurrent callers behind that single refresh instead of stampeding
 *  - surfaces network failure as a distinct, recognisable condition so the UI
 *    can fall back to cached data and the offline queue rather than showing a
 *    generic error
 *  - never throws away the server's error code, which is what the UI maps to a
 *    localized message
 */

/**
 * Where the API lives.
 *
 * `EXPO_PUBLIC_API_URL` wins when set. An explicitly empty value means
 * same-origin, which is what a web deployment serving the app and the API from
 * one host wants. Otherwise fall back to the value baked into app.json.
 */
const CONFIGURED = process.env.EXPO_PUBLIC_API_URL
  ?? (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl
  ?? 'http://localhost:8080';

const BASE_URL: string =
  CONFIGURED === '' && typeof window !== 'undefined' ? window.location.origin : CONFIGURED;

/**
 * Preview mode.
 *
 * Set at build time. When on, requests are served by an in-memory backend that
 * runs the REAL domain engines over sample data, so the published preview can
 * be walked through without a server behind it. It is never enabled in a
 * normal build, and the UI states plainly that the data is sample data.
 */
export const DEMO_MODE: boolean = process.env.EXPO_PUBLIC_DEMO === '1';

/**
 * The device id is NOT a credential and stays in AsyncStorage deliberately.
 * It is a random per-install string used to name this phone for push
 * registration and offline replay; it authorises nothing on its own, and
 * putting it in the keychain would mean it becomes unreadable before first
 * unlock — exactly when a boot-time notification needs it.
 *
 * The access and refresh tokens used to live beside it. They now live in
 * `./token-store`, which is the keychain; see that file for why, and for what
 * happens to the plaintext copies left on devices that upgrade.
 */
const DEVICE_KEY = 'dawaee.deviceId';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    readonly status: number,
    message: string,
    readonly meta?: Record<string, unknown>,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised when the request never reached the server. The UI treats this as "offline". */
export class NetworkError extends Error {
  readonly offline = true;
  constructor(message = 'network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshInFlight: { generation: number; promise: Promise<RefreshResult> } | null = null;
// Changes only at explicit session boundaries, not on same-session rotation.
let sessionGeneration = 0;
let sessionStorageTail: Promise<void> = Promise.resolve();

/** A stale request must not be mistaken for an offline action to replay. */
export class SessionChangedError extends ApiError {
  constructor() {
    super('session_changed', 409, 'The session changed while the request was running.');
    this.name = 'SessionChangedError';
  }
}

function requireSession(generation: number): void {
  if (generation !== sessionGeneration) throw new SessionChangedError();
}

function advanceSession(): number {
  refreshInFlight = null;
  return ++sessionGeneration;
}

/** Order keychain reads/writes/deletes; never hold this lock over HTTP. */
function withSessionStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionStorageTail.then(operation);
  sessionStorageTail = result.then(() => undefined, () => undefined);
  return result;
}
let onUnauthenticated: (() => void) | null = null;

export async function loadStoredSession(): Promise<boolean> {
  const generation = advanceSession();
  if (DEMO_MODE) {
    accessToken = 'demo';
    refreshToken = 'demo';
    return true;
  }
  const stored = await withSessionStorage(readSession);
  if (generation !== sessionGeneration) return false;
  accessToken = stored?.accessToken ?? null;
  refreshToken = stored?.refreshToken ?? null;
  return stored !== null;
}

/**
 * Hold a session in memory and persist it securely.
 *
 * The in-memory assignment happens first and unconditionally: if the keychain
 * write fails, the person who just typed their password is still signed in for
 * this run rather than being bounced back to the form with no explanation. The
 * throw still propagates, so a caller that wants to report it can.
 */
export async function storeSession(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  const generation = advanceSession();
  const snapshot = { ...tokens };
  accessToken = snapshot.accessToken;
  refreshToken = snapshot.refreshToken;
  await withSessionStorage(async () => {
    requireSession(generation);
    await writeSession(snapshot);
  });
  requireSession(generation);
}

export async function clearSession(): Promise<void> {
  advanceSession();
  accessToken = null;
  refreshToken = null;
  // Run after any already-started write, so it cannot resurrect credentials.
  await withSessionStorage(clearStoredSession);
}

async function rejectSession(generation: number): Promise<void> {
  requireSession(generation);
  const clearing = clearSession();
  const clearedGeneration = sessionGeneration;
  try {
    await clearing;
  } finally {
    // A later login must not receive an earlier session's sign-out callback.
    if (sessionGeneration === clearedGeneration) onUnauthenticated?.();
  }
}

export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

export function isSignedIn(): boolean {
  return Boolean(accessToken);
}

/** Stable per-install device id, used for push registration and offline replay. */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    await AsyncStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * Single-flight within one session generation. Explicit sign-in/out detaches
 * old work; its late result must neither replace credentials nor clear a new
 * account's flight. Rotation itself keeps the generation, so concurrent calls
 * for the same account continue to share one refresh.
 *
 * An unavailable server is not an authentication rejection. HTTP errors remain
 * ApiError (with their real status), while transport failures are NetworkError.
 */
type RefreshResult = 'ok' | 'rejected' | 'offline' | { kind: 'transient'; error: ApiError };

function apiErrorFromResponse(
  res: Response,
  payload: unknown,
): ApiError {
  const e = (payload as {
    error?: { code?: string; message?: string; details?: Array<{ path: string; message: string }> };
    meta?: Record<string, unknown>;
  } | null)?.error;
  return new ApiError(
    e?.code ?? 'internal_error',
    res.status,
    e?.message ?? `Request failed with ${res.status}`,
    (payload as { meta?: Record<string, unknown> } | null)?.meta,
    e?.details,
  );
}

async function refreshAccessToken(generation: number): Promise<RefreshResult> {
  requireSession(generation);
  if (!refreshToken) return 'rejected';
  if (refreshInFlight?.generation === generation) return refreshInFlight.promise;
  const presented = refreshToken;

  // Start in a microtask so even a synchronously throwing fetch cannot leave
  // a settled promise installed after its own cleanup already ran.
  const promise = Promise.resolve().then(async (): Promise<RefreshResult> => {
    try {
      const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: presented }),
      });
      requireSession(generation);
      if (!res.ok) {
        if (res.status === 409) {
          // Another runtime may have rotated before a sequential restart.
          // Never re-present the refused token if its replacement was lost.
          const stored = await withSessionStorage(readSession).catch(() => null);
          requireSession(generation);
          if (stored && stored.refreshToken !== presented) {
            accessToken = stored.accessToken;
            refreshToken = stored.refreshToken;
            return 'ok';
          }
          await rejectSession(generation);
          return 'rejected';
        }
        if (res.status === 401) {
          await rejectSession(generation);
          return 'rejected';
        }
        const payload = await res.clone().json().catch(() => null);
        requireSession(generation);
        return { kind: 'transient', error: apiErrorFromResponse(res, payload) };
      }
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      requireSession(generation);
      // This is a rotation, not a new account. Preserve the shared generation.
      accessToken = body.accessToken;
      refreshToken = body.refreshToken;
      try {
        await withSessionStorage(async () => {
          requireSession(generation);
          await writeSession(body);
        });
      } catch {
        requireSession(generation);
        // A failed keychain write must not leave the now-dead presented token
        // behind. This run keeps the new memory pair. Check again inside the
        // storage lock so cleanup can never delete a later login's tokens.
        await withSessionStorage(async () => {
          requireSession(generation);
          await clearStoredSession();
        }).catch(() => undefined);
      }
      requireSession(generation);
      return 'ok';
    } catch (err) {
      if (err instanceof ApiError) throw err;
      requireSession(generation);
      return 'offline';
    } finally {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    }
  });
  refreshInFlight = { generation, promise };
  return promise;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Skips the Authorization header — used by the auth endpoints themselves. */
  anonymous?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, anonymous = false, timeoutMs = 15_000 } = options;
  const generation = sessionGeneration;
  const requireCurrentRequest = () => { if (!anonymous) requireSession(generation); };
  let sentAccessToken: string | null = null;

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  if (DEMO_MODE) {
    const { handleDemoRequest, DemoUnavailable } = await import('./demo-backend.js');
    // A small delay keeps loading states honest rather than making the preview
    // feel unrealistically instant.
    await new Promise((r) => setTimeout(r, 120));
    try {
      return handleDemoRequest(method, url.pathname, url.searchParams, body) as T;
    } catch (err) {
      if (err instanceof DemoUnavailable) {
        throw new ApiError('provider_unavailable', 503, 'This step needs the server, which is not attached to the preview.');
      }
      throw err;
    }
  }

  const send = async (): Promise<Response> => {
    requireCurrentRequest();
    sentAccessToken = accessToken;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort());
    try {
      return await fetch(url.toString(), {
        method,
        headers: {
          'content-type': 'application/json',
          ...(anonymous || !sentAccessToken ? {} : { authorization: `Bearer ${sentAccessToken}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await send();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    requireCurrentRequest();
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }
  requireCurrentRequest();

  if (res.status === 401 && !anonymous) {
    const parsed = await res.clone().json().catch(() => null) as { error?: { code?: string } } | null;
    requireCurrentRequest();
    // A late 401 may refer to the access token another same-session caller
    // already rotated. Reuse the new pair, but never cross a login boundary.
    if (sentAccessToken && accessToken && sentAccessToken !== accessToken) {
      try {
        res = await send();
      } catch (err) {
        if (err instanceof ApiError) throw err;
        requireCurrentRequest();
        throw new NetworkError(err instanceof Error ? err.message : undefined);
      }
      requireCurrentRequest();
    } else if (parsed?.error?.code === 'token_expired') {
      const outcome = await refreshAccessToken(generation);
      if (outcome === 'ok') {
        try {
          res = await send();
        } catch (err) {
          if (err instanceof ApiError) throw err;
          requireCurrentRequest();
          throw new NetworkError(err instanceof Error ? err.message : undefined);
        }
        requireCurrentRequest();
      } else if (outcome === 'offline') {
        throw new NetworkError('refresh unreachable');
      } else if (typeof outcome === 'object' && outcome.kind === 'transient') {
        throw outcome.error;
      }
      // An explicitly rejected session has already been cleared.
    } else {
      await rejectSession(generation);
    }
  }

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => ({}));
  // Decoding a response is also asynchronous: do not return old-account PHI.
  if (res.ok) requireCurrentRequest();
  if (!res.ok) {
    throw apiErrorFromResponse(res, payload);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'PUT', body, query }),
  patch: <T>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'PATCH', body, query }),
  delete: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'DELETE', query }),
  anonymous: {
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body, anonymous: true }),
    // The emergency scan is read by a paramedic who has no account, on a phone
    // that is not theirs. Sending a stored token with it would be wrong twice:
    // it would attach the wrong identity, and a 401 would trigger the refresh
    // and sign-out path on the phone's actual owner.
    get: <T>(path: string, query?: RequestOptions['query']) =>
      request<T>(path, { method: 'GET', query, anonymous: true }),
  },
  baseUrl: BASE_URL,
};
