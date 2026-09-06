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
let refreshInFlight: Promise<RefreshResult> | null = null;
let onUnauthenticated: (() => void) | null = null;

export async function loadStoredSession(): Promise<boolean> {
  if (DEMO_MODE) {
    accessToken = 'demo';
    refreshToken = 'demo';
    return true;
  }
  const stored = await readSession();
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
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  await writeSession(tokens);
}

export async function clearSession(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await clearStoredSession();
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
 * Refresh, single-flight.
 *
 * Every concurrent caller shares one in-flight promise, so twenty requests that
 * all discover an expired access token at the same moment produce exactly ONE
 * refresh over the network. That is not only a bandwidth nicety: two
 * client-originated refreshes carrying the same token race on the server, and
 * until recently the loser was treated as a stolen-token replay and revoked the
 * whole device. The server no longer does that within its grace window, but the
 * client's job is to not create the race in the first place.
 *
 * The promise is cleared in `finally`, so a failed refresh does not wedge every
 * later caller onto a dead result.
 */
/**
 * Why an enum and not a boolean.
 *
 * `request()` used to read "refresh returned false" as "this session is dead"
 * and clear storage. Two of the three ways a refresh fails are not that:
 *
 *   `offline`    — the network never reached the server, so the tokens are
 *                  fine. Clearing here signed a user out because their train
 *                  went into a tunnel while a token happened to be expiring,
 *                  which is the exact opposite of what the offline design is
 *                  for; the comment in the catch below already claimed this
 *                  did not happen.
 *   `superseded` — this client's own parallel request already rotated. The
 *                  newer tokens are on disk; erasing them turns a harmless race
 *                  into a sign-out and undoes the server-side fix for it.
 *   `rejected`   — the server refused the token. This one really is dead.
 */
type RefreshResult = 'ok' | 'rejected' | 'offline' | 'superseded';

async function refreshAccessToken(): Promise<RefreshResult> {
  if (!refreshToken) return 'rejected';
  if (refreshInFlight) return refreshInFlight;

  // The exact token this attempt presents, captured before the await so the
  // recovery below can tell "storage still holds what I sent" from "another
  // context has already moved on".
  const presented = refreshToken;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: presented }),
      });
      if (!res.ok) {
        /**
         * 409 REFRESH_SUPERSEDED: two of THIS client's own requests raced and
         * this one lost. The other already stored a valid session.
         *
         * Clearing here would be the worst possible reaction — it would erase
         * the newer tokens the winning request just wrote, turning a harmless
         * race into a sign-out. Single-flight below means this should be
         * unreachable in normal operation; it is handled anyway because "should
         * be unreachable" is not a security property, and because a process
         * restart mid-refresh can produce exactly this shape.
         */
        /**
         * 409 REFRESH_SUPERSEDED — another execution context already rotated
         * this token.
         *
         * The in-memory single-flight above covers concurrent callers inside
         * ONE runtime, and that is the only concurrency this app actually has:
         * there is no TaskManager task, no headless handler and no background
         * fetch, so notification actions run in the app's own runtime. What it
         * does NOT cover is a SEQUENTIAL restart — Android reclaiming the
         * process, or a cold launch from a notification action — where a
         * previous process rotated and this one starts holding the old token.
         *
         * Recovery, in order:
         *   1. never re-present the token that was just refused, and
         *   2. re-read what is actually persisted now.
         *
         * If storage has moved on, another context won and wrote the newer
         * pair: adopt it and carry on. If storage still holds the token that
         * was just refused, there is no winner to recover from — the rotation
         * happened but its result was lost — so end the session cleanly.
         *
         * Retrying the refused token is the one thing that must not happen. It
         * would work for a moment and then, once the server's 30-second race
         * window closed, be classified as theft and revoke the whole device —
         * turning a lost write into a forced sign-out with a security event
         * attached to it.
         */
        if (res.status === 409) {
          const stored = await readSession().catch(() => null);
          if (stored && stored.refreshToken !== presented) {
            accessToken = stored.accessToken;
            refreshToken = stored.refreshToken;
            return 'ok';
          }
          await clearSession();
          onUnauthenticated?.();
          return 'rejected';
        }

        await clearSession();
        onUnauthenticated?.();
        return 'rejected';
      }
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      try {
        await storeSession(body);
      } catch {
        // The rotation succeeded on the server, so the OLD refresh token is
        // now dead — but persisting the new pair failed, which means whatever
        // is on disk still names the dead one. Leaving it there would produce
        // a launch that presents an invalidated token, gets a 401, and signs
        // the user out with no explanation days later. Clearing makes the next
        // launch a clean sign-in instead. This run continues on the in-memory
        // pair, which storeSession set before it threw.
        await clearStoredSession().catch(() => undefined);
      }
      return 'ok';
    } catch {
      // Offline: keep the tokens, the user is not signed out.
      return 'offline';
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort());
    try {
      return await fetch(url.toString(), {
        method,
        headers: {
          'content-type': 'application/json',
          ...(anonymous || !accessToken ? {} : { authorization: `Bearer ${accessToken}` }),
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
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }

  if (res.status === 401 && !anonymous) {
    const parsed = await res.clone().json().catch(() => null) as { error?: { code?: string } } | null;
    // Only an expired token is worth a silent refresh; a revoked session must
    // sign the user out rather than loop.
    if (parsed?.error?.code === 'token_expired') {
      const outcome = await refreshAccessToken();
      if (outcome === 'ok') {
        try {
          res = await send();
        } catch (err) {
          throw new NetworkError(err instanceof Error ? err.message : undefined);
        }
      } else if (outcome === 'offline') {
        // The refresh never reached the server. Surface it as what it is so the
        // UI falls back to cached data, and leave the session alone.
        throw new NetworkError('refresh unreachable');
      }
      // 'superseded': this client's own parallel request already rotated, and
      // `refreshAccessToken` has cleared nothing. Fall through to the error
      // below; the caller retries against the session the winner stored.
      // 'rejected': the session is genuinely dead and has already been cleared.
    } else {
      await clearSession();
      onUnauthenticated?.();
    }
  }

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (payload as { error?: { code: string; message: string; details?: Array<{ path: string; message: string }> } }).error;
    throw new ApiError(
      e?.code ?? 'internal_error',
      res.status,
      e?.message ?? `Request failed with ${res.status}`,
      (payload as { meta?: Record<string, unknown> }).meta,
      e?.details,
    );
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
