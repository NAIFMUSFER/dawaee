import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@dawaee/shared';

const require = createRequire(import.meta.url);
const { createHarness, deferred, NetworkError, ApiError } = require('./profile-screen-harness.cjs');
const screens: any[] = [];
afterEach(() => { for (const h of screens.splice(0)) h.unmount(); });

function setup(kind: 'sign-in' | 'sign-up') {
  const gate = deferred(), response = deferred();
  const wait = vi.fn((_signal: AbortSignal) => gate.promise), post = vi.fn((_path: string, _body: unknown) => response.promise);
  const getDeviceId = vi.fn(async () => 'synthetic-device');
  const signedIn = vi.fn(async () => undefined);
  const h = createHarness(resolve(`apps/mobile/app/(auth)/${kind}.tsx`), undefined, {}, {
    '@/api/auth-connection': { waitForAuthServer: wait },
    '@/api/client': { NetworkError, ApiError, getDeviceId, api: { anonymous: { post } } },
    '@/storage/pending-invite': { landingAfterAuth: async () => '/caregiver/accept' },
  });
  h.app.signInWithTokens = signedIn; h.render(); screens.push(h);
  const label = kind === 'sign-up' ? 'auth.signUp' : 'auth.signIn';
  const press = () => h.find('Button', (p: any) => p.label === label).onPress();
  const fill = async () => {
    const values = kind === 'sign-up'
      ? { 'emailAccount.email': 'Example@example.test' }
      : { 'auth.identifier': 'Example@example.test', 'auth.password': 'synthetic-only-secret' };
    for (const [field, value] of Object.entries(values)) h.find('Field', (p: any) => p.label === field).onChangeText(value);
    await h.flush();
  };
  return { h, gate, response, wait, post, getDeviceId, signedIn, press, fill };
}

describe('generic sign-in refusal output', () => {
  it.each(['ar', 'en'] as const)('displays the server guidance and keeps explicit recovery reachable (%s)', async locale => {
    const s = setup('sign-in'); await s.fill(); s.press(); s.gate.resolve(); await s.h.flush();
    const error = new ApiError('invalid_credentials');
    error.status = 401;
    error.message = t(locale, 'auth.signInRefused', { minutes: '15' });
    s.response.reject(error); await s.h.flush();
    expect(s.h.find('Banner').title).toBe(error.message);
    expect(s.h.find('Field', (p: any) => p.label === 'auth.password').editable).toBe(true);
    expect(s.signedIn).not.toHaveBeenCalled(); expect(s.h.routes).toEqual([]);
    const recovery = s.h.find('Button', (p: any) => p.label === 'recovery.title');
    expect(recovery.disabled).toBe(false); recovery.onPress();
    expect(s.h.routes).toEqual(['/(auth)/forgot-password']);
    expect(s.post).toHaveBeenCalledTimes(1);
  });
});

describe.each(['sign-in', 'sign-up'] as const)('%s connection lifecycle', kind => {
  it('waits before sending credentials, blocks duplicate clicks and completes one accepted request', async () => {
    const s = setup(kind); await s.fill(); s.press(); s.press(); await s.h.flush();
    expect(s.wait).toHaveBeenCalledTimes(1); expect(s.post).not.toHaveBeenCalled();
    expect(s.h.text()).toContain('auth.connectingServer'); expect(s.h.find('Field').editable).toBe(false);
    s.gate.resolve(); await s.h.flush();
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.post.mock.calls[0]?.[0]).toBe(kind === 'sign-up' ? '/v1/auth/register' : '/v1/auth/login');
    const response = kind === 'sign-up' ? { accepted: true, retryAfterSeconds: 60 }
      : { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' };
    s.response.resolve(response); await s.h.flush();
    if (kind === 'sign-up') {
      expect(s.signedIn).not.toHaveBeenCalled();
      expect(s.h.text()).toContain('auth.registrationRequested');
      expect(s.h.routes).toEqual([]);
    } else {
      expect(s.signedIn).toHaveBeenCalledTimes(1);
      expect(s.signedIn).toHaveBeenCalledWith(response);
      expect(s.h.routes).toEqual(['/caregiver/accept']);
    }
  });
  it('shows a connection banner without blaming the password or promising dose sync', async () => {
    const s = setup(kind); await s.fill(); s.press(); s.gate.reject(new NetworkError('unreachable')); await s.h.flush();
    expect(s.post).not.toHaveBeenCalled(); expect(s.h.find('Banner').title).toBe('auth.connectionFailed');
    if (kind === 'sign-in') expect(s.h.find('Field', (p: any) => p.label === 'auth.password').error).toBeUndefined();
    expect(s.h.text()).not.toContain('notifications.offlineBanner');
    expect(s.h.find('Field').editable).toBe(true);
  });
  it('never replays a POST with an unknown result and explains registration uncertainty', async () => {
    const s = setup(kind); await s.fill(); s.press(); s.gate.resolve(); await s.h.flush();
    s.response.reject(new NetworkError('response lost')); await s.h.flush();
    expect(s.post).toHaveBeenCalledTimes(1); expect(s.signedIn).not.toHaveBeenCalled();
    expect(s.h.find('Banner').title).toBe(kind === 'sign-up' ? 'auth.registrationUnconfirmed' : 'auth.connectionFailed');
  });
  it('does not send credentials after leaving while the server is starting', async () => {
    const s = setup(kind); await s.fill(); s.press(); s.h.unmount();
    expect(s.wait.mock.calls[0]?.[0].aborted).toBe(true);
    s.gate.resolve(); await s.h.flush(); expect(s.post).not.toHaveBeenCalled();
  });
  it('does not send credentials after leaving during device identity lookup', async () => {
    const s = setup(kind), identity = deferred(); s.getDeviceId.mockImplementation(() => identity.promise);
    await s.fill(); s.press(); s.gate.resolve(); await s.h.flush();
    if (kind === 'sign-up') {
      expect(s.getDeviceId).not.toHaveBeenCalled(); expect(s.post).toHaveBeenCalledOnce();
    } else {
      s.h.unmount(); identity.resolve('synthetic-device'); await s.h.flush(); expect(s.post).not.toHaveBeenCalled();
    }
  });
  it('ignores an auth response that arrives after the screen closes', async () => {
    const s = setup(kind); await s.fill(); s.press(); s.gate.resolve(); await s.h.flush(); s.h.unmount();
    s.response.resolve({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }); await s.h.flush();
    expect(s.signedIn).not.toHaveBeenCalled(); expect(s.h.routes).toEqual([]);
  });
});
