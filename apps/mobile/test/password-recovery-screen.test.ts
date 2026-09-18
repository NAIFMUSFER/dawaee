import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { createHarness, ApiError } = require('./profile-screen-harness.cjs');
const setups: any[] = [];
async function screen(supported = true, automatic = false, provider = 'firebase') {
  let deliver!: (token: string) => Promise<void>;
  const cancel = vi.fn();
  const confirm = vi.fn(async () => { await deliver('synthetic-recovery-proof'); });
  const start = vi.fn(async (_phone: string, onProof: typeof deliver) => {
    deliver = onProof;
    if (automatic) await deliver('automatic-recovery-proof');
    return { cancel, confirm };
  });
  const h = createHarness(resolve('apps/mobile/app/(auth)/forgot-password.tsx'),
    resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
      '@/security/phone-proof': { phoneVerificationSupported: supported, startPhoneProof: start },
    });
  setups.push(h);
  await h.flush();
  const discovery = h.requests.shift();
  expect(discovery.route).toBe('/v1/auth/password/recovery-options');
  discovery.resolve({ provider, available: true }); await h.flush();
  const press = async (label: string) => { h.find('Button', (p: any) => p.label === label).onPress(); await h.flush(); };
  const field = async (label: string, value: string) => { h.find('Field', (p: any) => p.label === label).onChangeText(value); await h.flush(); };
  const send = async () => { await field('recovery.phone', '٠٥٠٠٩٢٢٠٢٢'); await press('phoneVerification.send'); };
  const verify = async () => { await send(); await field('phoneVerification.code', '١٢٣٤٥٦'); await press('phoneVerification.confirm'); };
  const passwords = async () => { await field('recovery.newPassword', 'Recovery password 123!'); await field('recovery.confirmPassword', 'Recovery password 123!'); };
  return { h, press, field, send, verify, passwords, start, cancel, confirm, deliver: (token: string) => deliver(token) };
}
afterEach(() => { for (const h of setups.splice(0)) h.unmount(); });

describe('forgot password screen boundaries', () => {
  it('provides a reachable forgot-password action on the sign-in screen', () => {
    const h = createHarness(resolve('apps/mobile/app/(auth)/sign-in.tsx'), undefined, {}, {
      '@/storage/pending-invite': { landingAfterAuth: async () => '/(tabs)/today' },
    });
    setups.push(h);
    h.find('Button', (p: any) => p.label === 'recovery.title').onPress();
    expect(h.routes).toEqual(['/(auth)/forgot-password']);
  });
  it('sends only on request, normalizes Arabic phone/code and holds secrets outside navigation', async () => {
    const s = await screen();
    expect(s.start).not.toHaveBeenCalled();
    await s.verify();
    expect(s.start.mock.calls[0]?.[0]).toBe('+966500922022');
    expect(s.confirm).toHaveBeenCalledWith('123456');
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.newPassword')).toBeTruthy();
    expect(s.h.routes).toEqual([]); expect(s.h.requests).toHaveLength(0);
  });
  it('does not regress to code entry after automatic Android verification', async () => {
    const s = await screen(true, true); await s.send();
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.newPassword')).toBeTruthy();
    expect(s.h.find('Field', (p: any) => p.label === 'phoneVerification.code')).toBeNull();
  });
  it('requires matching passwords and does not show success while save is pending or failed', async () => {
    const s = await screen(); await s.verify();
    await s.field('recovery.newPassword', 'Recovery password 123!');
    await s.field('recovery.confirmPassword', 'Different password!');
    await s.press('recovery.save');
    expect(s.h.text()).toContain('recovery.mismatch'); expect(s.h.requests).toHaveLength(0);
    await s.passwords(); await s.press('recovery.save'); await s.press('recovery.save');
    expect(s.h.requests).toHaveLength(1); expect(s.h.text()).not.toContain('recovery.success');
    const first = s.h.requests[0]; first.completed = true; first.reject(new Error('network lost')); await s.h.flush();
    expect(s.h.text()).toContain('recovery.failed');
    await s.press('recovery.save');
    const retry = s.h.requests[1];
    expect(retry.payload).toEqual(first.payload);
    expect(retry.route).toBe('/v1/auth/password/recover');
    retry.completed = true; retry.resolve({ updated: true }); await s.h.flush();
    expect(s.h.text()).toContain('recovery.success');
    expect(s.h.find('Field')).toBeNull();
    await s.press('recovery.back'); expect(s.h.routes).toEqual(['/(auth)/sign-in']);
  });
  it('clears an abandoned proof and ignores late callbacks after restart/unmount', async () => {
    const s = await screen(); await s.send();
    await s.press('recovery.changePhone');
    await s.deliver('late-proof'); await s.h.flush();
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.phone')).toBeTruthy();
    s.h.unmount(); await s.deliver('later-proof');
    expect(s.cancel).toHaveBeenCalled(); expect(s.h.requests).toHaveLength(0);
  });
  it('enforces resend cooldown even if the handler is invoked repeatedly', async () => {
    const s = await screen(); await s.send();
    await s.press('phoneVerification.restart');
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.h.text()).toContain('recovery.cooldown');
  });
  it('explains unsupported builds and never pretends to send a code', async () => {
    const s = await screen(false);
    expect(s.h.text()).toContain('recovery.platform');
    expect(s.h.find('Button', (p: any) => p.label === 'phoneVerification.send')).toBeNull();
    expect(s.start).not.toHaveBeenCalled();
  });
});


describe('Twilio recovery screen boundaries', () => {
  const challengeToken = 'synthetic-challenge-'.repeat(10);
  const recoveryToken = 'synthetic-proof-'.repeat(10);
  it('uses server SMS without native Firebase and sends only the bound proof when saving', async () => {
    const s = await screen(false, false, 'twilio');
    expect(s.h.text()).toContain('recovery.twilioConsent');
    await s.send(); await s.press('phoneVerification.send');
    expect(s.start).not.toHaveBeenCalled(); expect(s.h.requests).toHaveLength(1);
    expect(s.h.requests[0].payload).toEqual({ phone: '+966500922022' });
    s.h.requests[0].resolve({ challengeToken }); await s.h.flush();
    await s.field('phoneVerification.code', '١٢٣٤٥٦'); await s.press('phoneVerification.confirm');
    expect(s.h.requests[1].payload).toEqual({ challengeToken, code: '123456' });
    await s.press('recovery.changePhone'); // stale/duplicate handler cannot reset an in-flight check
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.phone')).toBeNull();
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.newPassword')).toBeNull();
    s.h.requests[1].resolve({ recoveryToken }); await s.h.flush();
    await s.passwords(); await s.press('recovery.save'); await s.press('recovery.save');
    expect(s.h.requests).toHaveLength(3);
    expect(s.h.requests[2].payload).toEqual({ recoveryToken, newPassword: 'Recovery password 123!' });
    expect(s.h.text()).not.toContain('recovery.success');
    s.h.requests[2].resolve({ updated: true }); await s.h.flush();
    expect(s.h.text()).toContain('recovery.success'); expect(s.h.routes).toEqual([]);
  });
  it('retains the resend cooldown after an ambiguous failed send and never switches providers', async () => {
    const s = await screen(true, false, 'twilio'); await s.send();
    s.h.requests[0].reject(new Error('provider timeout')); await s.h.flush();
    expect(s.h.text()).toContain('recovery.unavailable');
    await s.press('phoneVerification.send');
    expect(s.h.requests).toHaveLength(1); expect(s.start).not.toHaveBeenCalled();
  });
  it('requires approved proof, reports an invalid code, and ignores a late response after leaving', async () => {
    const s = await screen(false, false, 'twilio'); await s.send();
    s.h.requests[0].resolve({ challengeToken }); await s.h.flush();
    await s.field('phoneVerification.code', '123456'); await s.press('phoneVerification.confirm');
    s.h.requests[1].reject(new ApiError('otp_invalid', 403)); await s.h.flush();
    expect(s.h.text()).toContain('phoneVerification.codeError');
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.newPassword')).toBeNull();
    await s.press('phoneVerification.confirm'); s.h.unmount();
    s.h.requests[2].resolve({ recoveryToken }); await s.h.flush();
    expect(s.h.routes).toEqual([]); expect(s.h.requests).toHaveLength(3);
  });
  it('rejects a non-Saudi destination before a paid send', async () => {
    const s = await screen(false, false, 'twilio');
    await s.field('recovery.phone', '+12025550123'); await s.press('phoneVerification.send');
    expect(s.h.text()).toContain('recovery.saudiPhone'); expect(s.h.requests).toHaveLength(0);
  });
  it.each([503, 404])('handles discovery HTTP %s without treating an outage as provider fallback', async (status) => {
    const h = createHarness(resolve('apps/mobile/app/(auth)/forgot-password.tsx'),
      resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
        '@/security/phone-proof': { phoneVerificationSupported: true, startPhoneProof: vi.fn() },
      });
    setups.push(h); await h.flush();
    h.requests[0].reject(new ApiError('unavailable', status)); await h.flush();
    expect(h.text()).toContain(status === 404 ? 'phoneVerification.consent' : 'recovery.unavailable');
    expect(Boolean(h.find('Button', (p: any) => p.label === 'phoneVerification.send'))).toBe(status === 404);
  });
});
