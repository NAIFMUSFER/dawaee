import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { createHarness, ApiError, NetworkError } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const screens: any[] = [];
afterEach(() => { for (const h of screens.splice(0)) h.unmount(); });
const draft = { email: 'recipient@example.test', phone: '+966500001234', createdAt: Date.now() };

function login(identity = { email: draft.email, verified: true }, linked = false) {
  const clear = vi.fn(async () => undefined);
  const read = vi.fn(async () => draft);
  const get = vi.fn(async (url: string) => url === '/v1/auth/email' ? identity : { phone: linked ? draft.phone : null, verified: linked });
  const post = vi.fn(async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }));
  const h = createHarness(resolve('apps/mobile/app/(auth)/sign-in.tsx'), undefined, {}, {
    '@/api/client': { ApiError, NetworkError, getDeviceId: async () => 'synthetic-device', api: { get, anonymous: { post } } },
    '@/api/auth-connection': { waitForAuthServer: async () => undefined },
    '@/security/phone-proof': { phoneVerificationSupported: true },
    '@/storage/registration-phone': { readRegistrationPhone: read, clearRegistrationPhone: clear },
    '@/storage/pending-invite': { landingAfterAuth: async () => '/caregiver/accept' },
  });
  screens.push(h);
  h.app.signInWithTokens = async () => { h.app.signedIn = true; h.render(); };
  return { h, clear, read, get, post };
}
async function signIn(h: any) {
  h.find('Field', (p: any) => p.label === 'auth.identifier').onChangeText(draft.email);
  h.find('Field', (p: any) => p.label === 'auth.password').onChangeText('synthetic-login-password');
  await h.flush(); h.find('Button', (p: any) => p.label === 'auth.signIn').onPress(); await h.flush();
}

describe('phone is entered once during native registration', () => {
  it('collects email, name, password and phone, withholding contact persistence until mailbox proof', async () => {
    const save = vi.fn(async () => undefined);
    const h = createHarness(resolve('apps/mobile/app/(auth)/sign-up.tsx'), undefined, {}, {
      '@/api/auth-connection': { waitForAuthServer: async () => undefined },
      '@/security/phone-proof': { phoneVerificationSupported: true },
      '@/storage/registration-phone': { saveRegistrationPhone: save },
    }); screens.push(h);
    h.find('Field', (p: any) => p.label === 'emailAccount.email').onChangeText(draft.email);
    await h.flush(); expect(h.find('Button', (p: any) => p.label === 'auth.sendEmailCode').disabled).toBe(true);
    h.find('Field', (p: any) => p.label === 'invite.phone').onChangeText('٠٥٠٠٠٠١٢٣٤');
    h.find('Field', (p: any) => p.label === 'auth.displayName').onChangeText('Synthetic');
    h.find('Field', (p: any) => p.label === 'auth.password').onChangeText('synthetic-login-password');
    await h.flush(); h.find('Button', (p: any) => p.label === 'auth.sendEmailCode').onPress(); await h.flush();
    expect(save).not.toHaveBeenCalled();
    expect(h.requests[0].payload).toEqual({ email: draft.email, locale: 'en' });
    expect(h.requests[0].payload).not.toHaveProperty('phone');
    h.requests[0].resolve({ accepted: true, challenge: 'synthetic-challenge', retryAfterSeconds: 60 }); await h.flush();
    expect(h.find('Field', (p: any) => p.label === 'auth.emailCode')).toBeTruthy();
  });
  it('confirms email inside the app before retaining the contact and entering phone proof', async () => {
    const save = vi.fn(async () => undefined), clear = vi.fn(async () => undefined);
    const h = createHarness(resolve('apps/mobile/app/(auth)/sign-up.tsx'), undefined, {}, {
      '@/api/auth-connection': { waitForAuthServer: async () => undefined },
      '@/security/phone-proof': { phoneVerificationSupported: true },
      '@/storage/registration-phone': { saveRegistrationPhone: save, clearRegistrationPhone: clear },
      '@/storage/pending-invite': { landingAfterAuth: async () => '/caregiver/accept' },
    }); screens.push(h);
    h.app.signInWithTokens = async () => { h.app.signedIn = true; h.render(); };
    for (const [label, value] of Object.entries({ 'emailAccount.email':draft.email, 'auth.displayName':'Synthetic', 'auth.password':'synthetic-login-password', 'invite.phone':'0500001234' })) {
      h.find('Field', (p:any) => p.label === label).onChangeText(value);
    }
    await h.flush();
    expect(h.find('Field', (p:any) => p.label === 'emailAccount.email').autoFocus).toBeUndefined();
    h.find('Button', (p:any) => p.label === 'auth.sendEmailCode').onPress(); await h.flush();
    expect(save).not.toHaveBeenCalled();
    h.requests[0].resolve({accepted:true,challenge:'synthetic-challenge',retryAfterSeconds:60}); await h.flush();
    h.find('Field', (p:any) => p.label === 'auth.emailCode').onChangeText('١٢٣٤٥٦'); await h.flush();
    h.find('Button', (p:any) => p.label === 'auth.completeInApp').onPress(); await h.flush();
    expect(h.requests[1].route).toBe('/v1/auth/registration-code/complete');
    expect(h.requests[1].payload.code).toBe('123456');
    expect(save).not.toHaveBeenCalled();
    h.requests[1].resolve({userId:'synthetic-account',accessToken:'synthetic-access',refreshToken:'synthetic-refresh'}); await h.flush();
    expect(save).toHaveBeenCalledWith(draft.email,draft.phone);
    expect(h.find('PhoneVerification').initialPhone).toBe(draft.phone);
    expect(h.routes).toEqual([]);
    h.find('PhoneVerification').onVerified(); await h.flush();
    expect(clear).toHaveBeenCalledWith(draft.email);
    expect(h.routes).toEqual(['/caregiver/accept']);
  });
  it('opens SMS verification with the saved phone and current password, then restores the pending invitation', async () => {
    const { h, clear } = login(); await signIn(h);
    const form = h.find('PhoneVerification');
    expect(form.initialPhone).toBe(draft.phone);
    expect(form.initialPassword).toBe('synthetic-login-password');
    expect(h.routes).toEqual([]); expect(clear).not.toHaveBeenCalled();
    form.onVerified(); await h.flush();
    expect(clear).toHaveBeenCalledWith(draft.email);
    expect(h.routes).toEqual(['/caregiver/accept']);
  });
  it.each([{ email: 'other@example.test', verified: true }, { email: draft.email, verified: false }])('never exposes or links the saved phone to a different or unverified mailbox: %j', async identity => {
    const { h, clear } = login(identity); await signIn(h);
    expect(h.find('PhoneVerification')).toBeNull(); expect(clear).not.toHaveBeenCalled();
    expect(h.routes).toEqual(['/caregiver/accept']);
  });
  it('does not ask an already verified account to verify again', async () => {
    const { h, clear } = login(undefined, true); await signIn(h);
    expect(h.find('PhoneVerification')).toBeNull();
    expect(clear).toHaveBeenCalledWith(draft.email); expect(h.routes).toEqual(['/caregiver/accept']);
  });
  it('removes the registration phone form and password immediately when the account changes', async () => {
    const { h } = login(); await signIn(h);
    expect(h.find('PhoneVerification')).toBeTruthy();
    h.app.user = { id: 'different-account' }; h.render(); await h.flush();
    expect(h.find('PhoneVerification')).toBeNull();
    expect(h.find('Field', (p: any) => p.label === 'auth.password').value).toBe('');
  });
  it('offers an explicit phone login keyboard as well as email', async () => {
    const { h } = login();
    h.find('Button', (p: any) => p.label === 'invite.phone').onPress(); await h.flush();
    expect(h.find('Field', (p: any) => p.label === 'auth.identifier').keyboardType).toBe('phone-pad');
    h.find('Button', (p: any) => p.label === 'emailAccount.email').onPress(); await h.flush();
    expect(h.find('Field', (p: any) => p.label === 'auth.identifier').keyboardType).toBe('email-address');
  });
});
