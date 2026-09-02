import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type { ErrorCode } from '@dawaee/shared';

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

const BASE_URL: string =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ?? 'http://localhost:8080';

const ACCESS_KEY = 'dawaee.accessToken';
const REFRESH_KEY = 'dawaee.refreshToken';
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
let refreshInFlight: Promise<boolean> | null = null;
let onUnauthenticated: (() => void) | null = null;

export async function loadStoredSession(): Promise<boolean> {
  const [a, r] = await Promise.all([AsyncStorage.getItem(ACCESS_KEY), AsyncStorage.getItem(REFRESH_KEY)]);
  accessToken = a;
  refreshToken = r;
  return Boolean(a && r);
}

export async function storeSession(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  await AsyncStorage.multiSet([[ACCESS_KEY, tokens.accessToken], [REFRESH_KEY, tokens.refreshToken]]);
}

export async function clearSession(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await AsyncStorage.multiRemove([ACCESS_KEY, REFRESH_KEY]);
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

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;
  // Concurrent 401s must trigger exactly one refresh.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        await clearSession();
        onUnauthenticated?.();
        return false;
      }
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      await storeSession(body);
      return true;
    } catch {
      // Offline: keep the tokens, the user is not signed out.
      return false;
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
    if (parsed?.error?.code === 'token_expired' && (await refreshAccessToken())) {
      try {
        res = await send();
      } catch (err) {
        throw new NetworkError(err instanceof Error ? err.message : undefined);
      }
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
  },
  baseUrl: BASE_URL,
};
