import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');
const setups: any[] = [];
function screen(supported = true) {
  let deliver: (proof: string) => Promise<void>;
  const cancel = vi.fn();
  const start = vi.fn(async (_phone: string, onProof: typeof deliver) => {
    deliver = onProof;
    return { cancel, confirm: async () => { await deliver('synthetic-id-token'); } };
  });
  const h = createHarness(resolve('apps/mobile/src/components/PhoneVerification.tsx'),
    resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, {
      '@/security/phone-proof': { phoneVerificationSupported: supported, startPhoneProof: start },
    });
  setups.push(h);
  h.app.refreshProfiles = vi.fn(async () => undefined);
  const reply = async (value: object) => {
    const request = h.batch()[0];
    request.completed = true; request.resolve(value); await h.flush();
  };
  return { h, start, cancel, reply, deliver: (proof: string) => deliver(proof) };
}
afterEach(() => { for (const h of setups.splice(0)) h.unmount(); });

describe('phone verification screen', () => {
  it('sends a code only after an explicit action and to the server account phone', async () => {
    const { h, start, reply } = screen();
    await reply({ phone: '+966500092202', verified: false });
    expect(start).not.toHaveBeenCalled();
    h.find('Button', (p: any) => p.label === 'phoneVerification.send').onPress();
    await h.flush();
    expect(start.mock.calls[0]?.[0]).toBe('+966500092202');
    expect(h.find('Field', (p: any) => p.label === 'phoneVerification.code')).toBeTruthy();
  });

  it('waits for server verification before showing success', async () => {
    const { h, reply } = screen();
    await reply({ phone: '+966500092202', verified: false });
    h.find('Button', (p: any) => p.label === 'phoneVerification.send').onPress();
    await h.flush();
    h.find('Field').onChangeText('123456'); await h.flush();
    h.find('Button', (p: any) => p.label === 'phoneVerification.confirm').onPress(); await h.flush();
    expect(h.batch()[0].payload).toEqual({ idToken: 'synthetic-id-token' });
    expect(h.text()).not.toContain('phoneVerification.verified');
    await reply({ verified: true });
    expect(h.text()).toContain('phoneVerification.verified');
  });

  it('proves a new phone before asking the API to link it', async () => {
    const { h, start, reply } = screen();
    await reply({ phone: null, verified: false });
    h.find('Field', (p: any) => p.label === 'invite.phone').onChangeText('٠٥٠٠٠٩٢٢٩٧');
    h.find('Field', (p: any) => p.label === 'auth.password').onChangeText('correct horse battery staple');
    await h.flush();
    h.find('Button', (p: any) => p.label === 'phoneVerification.send').onPress();
    await h.flush();
    expect(start.mock.calls[0]?.[0]).toBe('+966500092297');
    expect(h.requests.filter((r: any) => r.method === 'POST')).toHaveLength(0);
    h.find('Field', (p: any) => p.label === 'phoneVerification.code').onChangeText('123456');
    await h.flush();
    h.find('Button', (p: any) => p.label === 'phoneVerification.confirm').onPress();
    await h.flush();
    const linking = h.batch()[0];
    expect(linking.route).toBe('/v1/auth/phone');
    expect(linking.payload).toEqual({ idToken: 'synthetic-id-token', currentPassword: 'correct horse battery staple' });
    await reply({ linked: true, verified: true });
    expect(h.text()).toContain('phoneVerification.verified');
    expect(h.app.refreshProfiles).toHaveBeenCalledTimes(1);
  });

  it('discards proof completed after leaving the verification screen', async () => {
    const { h, reply, deliver, cancel } = screen();
    await reply({ phone: '+966500092202', verified: false });
    h.find('Button', (p: any) => p.label === 'phoneVerification.send').onPress(); await h.flush();
    h.unmount();
    await deliver('late-synthetic-proof');
    expect(cancel).toHaveBeenCalled();
    expect(h.requests.filter((r: any) => r.method === 'POST')).toHaveLength(0);
  });

  it('explains the Android requirement without pretending to send an SMS on web', async () => {
    const { h, reply, start } = screen(false);
    await reply({ phone: '+966500092202', verified: false });
    expect(h.text()).toContain('phoneVerification.androidRequired');
    expect(h.find('Button', (p: any) => p.label === 'phoneVerification.send')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('does not offer an unproved phone-link form when verification is unavailable', async () => {
    const { h, reply, start } = screen(false);
    await reply({ phone: null, verified: false });
    expect(h.text()).toContain('phoneVerification.androidRequired');
    expect(h.find('Field', (p: any) => p.label === 'invite.phone')).toBeNull();
    expect(h.find('Button', (p: any) => p.label === 'phoneVerification.send')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
