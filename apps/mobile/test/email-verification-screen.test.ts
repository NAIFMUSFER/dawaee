import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');
const screens: any[] = [];
function screen() {
  const h = createHarness(resolve('apps/mobile/app/settings/email-verification.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), {}, { '@/storage/pending-invite': { landingAfterAuth: async () => '/caregiver/accept' } });
  screens.push(h); return h;
}
afterEach(() => { for (const h of screens.splice(0)) h.unmount(); });
describe('email verification settings', () => {
  it('preserves edited email while status loads and requires explicit password-backed submission', async () => {
    const h = screen(); h.find('Field', (p: any) => p.label === 'emailAccount.email').onChangeText(' New@Example.com '); await h.flush();
    h.requests[0].resolve({ email: 'old@example.com', verified: false, available: true }); await h.flush();
    expect(h.find('Field').value).toBe(' New@Example.com ');
    h.find('Field', (p: any) => p.secureTextEntry).onChangeText('synthetic-password'); await h.flush();
    const send = h.find('Button', (p: any) => p.label === 'emailAccount.sendVerify'); send.onPress(); send.onPress(); await h.flush();
    expect(h.requests).toHaveLength(2); expect(h.requests[1].payload).toEqual({ email: 'new@example.com', currentPassword: 'synthetic-password' });
    expect(h.text()).not.toContain('emailAccount.verifyRequested'); h.requests[1].resolve({ accepted: true }); await h.flush();
    expect(h.find('Field', (p: any) => p.secureTextEntry).value).toBe(''); expect(h.text()).toContain('emailAccount.verifyRequested');
  });
  it('does not carry another account email or password across an account switch', async () => {
    const h = screen(); h.find('Field', (p: any) => p.secureTextEntry).onChangeText('private'); await h.flush();
    h.app.user = { id: 'second-account' }; h.render(); await h.flush();
    h.requests[0].resolve({ email: 'first@example.com', verified: true, available: true }); await h.flush();
    expect(h.find('Field').value).toBe(''); expect(h.find('Field', (p: any) => p.secureTextEntry).value).toBe(''); expect(h.text()).not.toContain('first@example.com');
  });
  it('preserves the pending invitation destination when leaving email setup', async () => {
    const h = screen(); h.find('Button', (p: any) => p.label === 'common.back').onPress(); await h.flush();
    expect(h.routes).toEqual(['/caregiver/accept']);
  });
});
