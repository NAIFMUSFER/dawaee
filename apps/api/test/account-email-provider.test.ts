import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { accountEmailReady, accountEmailContent, emailTokenHash, openEmailJob, sealEmailJob, sendAccountEmail } from '../src/providers/account-email.js';
const mail = { email: 'patient@example.com', token: 'a'.repeat(43), purpose: 'reset' as const, locale: 'ar' as const };
const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; resetConfigCache(); });
beforeEach(() => {
  process.env.ACCOUNT_EMAIL_PROVIDER='resend'; process.env.ACCOUNT_EMAIL_SENDER_VERIFIED='true';
  process.env.ACCOUNT_EMAIL_FROM='support@mail.example.com'; process.env.ACCOUNT_EMAIL_BASE_URL='https://app.example.com'; process.env.RESEND_API_KEY='re_synthetic'; resetConfigCache();
});
describe('account email provider', () => {
  it('requires all sending configuration and an HTTPS origin', () => {
    expect(accountEmailReady()).toBe(true);
    for (const patch of [{ ACCOUNT_EMAIL_SENDER_VERIFIED: false }, { ACCOUNT_EMAIL_PROVIDER: 'disabled' }, { RESEND_API_KEY: '' },
      { ACCOUNT_EMAIL_FROM: 'invalid' }, { ACCOUNT_EMAIL_BASE_URL: 'http://app.example.com' }, { ACCOUNT_EMAIL_BASE_URL: 'https://user:pass@app.example.com' }, { ACCOUNT_EMAIL_BASE_URL: 'https://app.example.com/path' }]) {
      expect(accountEmailReady({ ...loadConfig(), ...patch } as any)).toBe(false);
    }
  });
  it('encrypts the job and rejects tampering and wrong secrets', async () => {
    const job = await sealEmailJob(mail); expect(job).not.toContain(mail.email); expect(job).not.toContain(mail.token);
    expect(await openEmailJob(job)).toEqual(mail);
    await expect(openEmailJob(job.slice(0,-5)+'AAAAA')).rejects.toThrow();
    process.env.JWT_SECRET='different-secret-that-is-at-least-32-characters'; resetConfigCache();
    await expect(openEmailJob(job)).rejects.toThrow();
  });
  it('puts the bearer token only in the URL fragment with a clear expiry', () => {
    const content = accountEmailContent(mail, loadConfig());
    const url = new URL(content.text.split('\n')[1]!);
    expect(url.pathname).toBe('/account-email'); expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(mail.token);
    expect(content.html).toContain('dir="rtl"'); expect(content.text).toContain('15');
  });
  it('uses a stable idempotency key and never follows a provider redirect', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: 'synthetic-message' }), { status: 200 }));
    const key = emailTokenHash(mail.token); await sendAccountEmail(mail, key, request as typeof fetch);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as any;
    expect(url).toBe('https://api.resend.com/emails'); expect(init.redirect).toBe('error');
    expect(init.headers['Idempotency-Key']).toBe(`account-email/${key}`);
    expect(JSON.parse(init.body).to).toEqual([mail.email]);
  });
  it('sanitizes provider and network errors', async () => {
    for (const request of [async () => new Response('private provider body', { status: 429 }), async () => { throw new Error(mail.token); }, async () => new Response('{}')]) {
      await expect(sendAccountEmail(mail, 'key', request as typeof fetch)).rejects.toThrow('Account email unavailable');
    }
  });
});
