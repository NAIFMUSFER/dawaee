import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');
const setups: any[] = [];
function screen(supported = true, automatic = false) {
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
    const s = screen();
    expect(s.start).not.toHaveBeenCalled();
    await s.verify();
    expect(s.start.mock.calls[0]?.[0]).toBe('+966500922022');
    expect(s.confirm).toHaveBeenCalledWith('123456');
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.newPassword')).toBeTruthy();
    expect(s.h.routes).toEqual([]); expect(s.h.requests).toHaveLength(0);
  });
  it('does not regress to code entry after automatic Android verification', async () => {
    const s = screen(true, true); await s.send();
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.newPassword')).toBeTruthy();
    expect(s.h.find('Field', (p: any) => p.label === 'phoneVerification.code')).toBeNull();
  });
  it('requires matching passwords and does not show success while save is pending or failed', async () => {
    const s = screen(); await s.verify();
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
    const s = screen(); await s.send();
    await s.press('recovery.changePhone');
    await s.deliver('late-proof'); await s.h.flush();
    expect(s.h.find('Field', (p: any) => p.label === 'recovery.phone')).toBeTruthy();
    s.h.unmount(); await s.deliver('later-proof');
    expect(s.cancel).toHaveBeenCalled(); expect(s.h.requests).toHaveLength(0);
  });
  it('enforces resend cooldown even if the handler is invoked repeatedly', async () => {
    const s = screen(); await s.send();
    await s.press('phoneVerification.restart');
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.h.text()).toContain('recovery.cooldown');
  });
  it('explains unsupported builds and never pretends to send a code', () => {
    const s = screen(false);
    expect(s.h.text()).toContain('recovery.platform');
    expect(s.h.find('Button', (p: any) => p.label === 'phoneVerification.send')).toBeNull();
    expect(s.start).not.toHaveBeenCalled();
  });
});
