import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  get: vi.fn(), set: vi.fn(), readSession: vi.fn(), writeSession: vi.fn(),
  clearSession: vi.fn(), unauthenticated: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: h.get, setItem: h.set },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../src/api/token-store.js', () => ({
  readSession: h.readSession, writeSession: h.writeSession, clearStoredSession: h.clearSession,
}));

type Client = typeof import('../src/api/client.js');
let client: Client;
const INITIAL = { accessToken: 'A1', refreshToken: 'R1' };
const ROTATED = { accessToken: 'A2', refreshToken: 'R2' };
const NEXT_ACCOUNT = { accessToken: 'B1', refreshToken: 'BR1' };
const DEVICE_KEY = 'dawaee.deviceId';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const expired = () => json(401, { error: { code: 'token_expired' } });
const revoked = () => json(401, { error: { code: 'session_revoked' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://audit.invalid');
  vi.stubEnv('EXPO_PUBLIC_DEMO', '0');
  h.disk.clear();
  h.get.mockReset().mockImplementation(async (k: string) => h.disk.get(k) ?? null);
  h.set.mockReset().mockImplementation(async (k: string, v: string) => { h.disk.set(k, v); });
  h.readSession.mockReset().mockResolvedValue(INITIAL);
  h.writeSession.mockReset().mockResolvedValue(undefined);
  h.clearSession.mockReset().mockResolvedValue(undefined);
  h.unauthenticated.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  client = await import('../src/api/client.js');
  await client.storeSession(INITIAL);
  client.setUnauthenticatedHandler(h.unauthenticated);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('one persisted identity per installation, even during first-use overlap', () => {
  it('20 concurrent callers obtain one ID from one complete read/create/write', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => client.getDeviceId()));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(h.disk.get(DEVICE_KEY));
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.set).toHaveBeenCalledTimes(1);
  });

  it('a caller arriving while persistence is pending joins the existing operation', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    h.set.mockImplementation(async (k: string, v: string) => {
      started.resolve();
      await finish.promise;
      h.disk.set(k, v);
    });
    const first = client.getDeviceId();
    await started.promise;
    const second = client.getDeviceId();
    finish.resolve();
    const ids = await Promise.all([first, second]);
    expect(ids[0]).toBe(ids[1]);
    expect(h.set).toHaveBeenCalledTimes(1);
  });

  it('an existing ID is not rewritten by logout or an account switch', async () => {
    h.disk.set(DEVICE_KEY, 'existing-installation');
    expect(await client.getDeviceId()).toBe('existing-installation');
    await client.clearSession();
    await client.storeSession(NEXT_ACCOUNT);
    expect(await client.getDeviceId()).toBe('existing-installation');
    expect(h.set).not.toHaveBeenCalled();
  });

  it('a fresh runtime reads the same ID instead of relying on a memory-only cache', async () => {
    const id = await client.getDeviceId();
    vi.resetModules();
    const restarted = await import('../src/api/client.js');
    expect(await restarted.getDeviceId()).toBe(id);
    expect(h.set).toHaveBeenCalledTimes(1);
  });

  it('a synchronous storage exception rejects every waiter and does not wedge retries', async () => {
    h.get.mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    const results = await Promise.allSettled([client.getDeviceId(), client.getDeviceId()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const id = await client.getDeviceId();
    expect(id).toBe(h.disk.get(DEVICE_KEY));
  });

  it('a failed write cannot report an unpersisted ID, and the next attempt can recover', async () => {
    h.set.mockRejectedValueOnce(new Error('disk full'));
    const results = await Promise.allSettled([client.getDeviceId(), client.getDeviceId()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(h.disk.has(DEVICE_KEY)).toBe(false);
    const id = await client.getDeviceId();
    expect(id).toBe(h.disk.get(DEVICE_KEY));
  });
});

describe('the single authentication retry is still subject to revocation', () => {
  it('a 401 after successful refresh clears credentials and signals local privacy cleanup once', async () => {
    h.fetch.mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, ROTATED))
      .mockResolvedValueOnce(revoked());
    await expect(client.api.get('/v1/me')).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(client.isSignedIn()).toBe(false);
    expect(h.clearSession).toHaveBeenCalledTimes(1);
    expect(h.unauthenticated).toHaveBeenCalledTimes(1);
  });

  it('a late old-token 401 also honors revocation when retried with the current token', async () => {
    const slow = deferred<Response>();
    h.fetch.mockResolvedValueOnce(expired()).mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(json(200, ROTATED)).mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(revoked());
    // Both initial requests enter send synchronously; the second is held until
    // the first has rotated, so this exercises the late-token retry branch.
    const rotating = client.api.get('/v1/me');
    const pending = client.api.get('/v1/slow').catch((e: unknown) => e);
    await rotating;
    slow.resolve(expired());
    expect(await pending).toMatchObject({ status: 401, code: 'session_revoked' });
    expect(client.isSignedIn()).toBe(false);
    expect(h.clearSession).toHaveBeenCalledTimes(1);
    expect(h.unauthenticated).toHaveBeenCalledTimes(1);
  });

  it('a rejected retry from account A cannot sign out a later account B', async () => {
    const retry = deferred<Response>();
    const started = deferred<void>();
    h.fetch.mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, ROTATED))
      .mockImplementationOnce(() => { started.resolve(); return retry.promise; });
    const pending = client.api.get('/v1/me').catch((e: unknown) => e);
    await started.promise;
    await client.storeSession(NEXT_ACCOUNT);
    retry.resolve(revoked());
    expect(await pending).toBeInstanceOf(client.SessionChangedError);
    expect(client.isSignedIn()).toBe(true);
    expect(h.clearSession).not.toHaveBeenCalled();
    expect(h.unauthenticated).not.toHaveBeenCalled();
    expect(h.writeSession).toHaveBeenLastCalledWith(NEXT_ACCOUNT);
  });

  it('a late rejected retry does not evict a newer same-session rotation', async () => {
    const retry = deferred<Response>();
    const started = deferred<void>();
    const newest = { accessToken: 'A3', refreshToken: 'R3' };
    h.fetch.mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, ROTATED))
      .mockImplementationOnce(() => { started.resolve(); return retry.promise; })
      .mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, newest))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const pending = client.api.get('/v1/slow').catch((e: unknown) => e);
    await started.promise;
    await client.api.get('/v1/me');
    retry.resolve(revoked());
    expect(await pending).toMatchObject({ status: 401 });
    expect(client.isSignedIn()).toBe(true);
    expect(h.clearSession).not.toHaveBeenCalled();
    expect(h.unauthenticated).not.toHaveBeenCalled();
    expect(h.writeSession).toHaveBeenLastCalledWith(newest);
  });

  it.each([403, 503])('retry HTTP %i preserves the session and the real HTTP error', async (status) => {
    h.fetch.mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, ROTATED))
      .mockResolvedValueOnce(json(status, { error: { code: 'test_http_failure' } }));
    await expect(client.api.get('/v1/me')).rejects.toMatchObject({ status, code: 'test_http_failure' });
    expect(client.isSignedIn()).toBe(true);
    expect(h.clearSession).not.toHaveBeenCalled();
    expect(h.unauthenticated).not.toHaveBeenCalled();
  });

  it('a transport failure on the retry preserves the newly rotated session', async () => {
    h.fetch.mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, ROTATED))
      .mockRejectedValueOnce(new TypeError('network lost'));
    await expect(client.api.get('/v1/me')).rejects.toBeInstanceOf(client.NetworkError);
    expect(client.isSignedIn()).toBe(true);
    expect(h.clearSession).not.toHaveBeenCalled();
    expect(h.unauthenticated).not.toHaveBeenCalled();
  });

  it('a normal first-response rejection still signals cleanup only once', async () => {
    h.fetch.mockResolvedValueOnce(revoked());
    await expect(client.api.get('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.clearSession).toHaveBeenCalledTimes(1);
    expect(h.unauthenticated).toHaveBeenCalledTimes(1);
  });

  it('anonymous 401 does not touch an unrelated signed-in session', async () => {
    h.fetch.mockResolvedValueOnce(json(401, { error: { code: 'invalid_credentials' } }));
    await expect(client.api.anonymous.post('/v1/auth/login', {})).rejects.toMatchObject({ status: 401 });
    expect(client.isSignedIn()).toBe(true);
    expect(h.clearSession).not.toHaveBeenCalled();
    expect(h.unauthenticated).not.toHaveBeenCalled();
  });

  it('a successful retry returns its body without signing out', async () => {
    h.fetch.mockResolvedValueOnce(expired()).mockResolvedValueOnce(json(200, ROTATED))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(client.api.get('/v1/me')).resolves.toEqual({ ok: true });
    expect(client.isSignedIn()).toBe(true);
    expect(h.clearSession).not.toHaveBeenCalled();
  });
});
