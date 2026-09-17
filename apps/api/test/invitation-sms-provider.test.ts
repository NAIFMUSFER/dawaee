import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { buildInvitationSms } from '../src/providers/invitation-sms.js';

const account = `AC${'1'.repeat(32)}`;
const key = `SK${'2'.repeat(32)}`;
const service = `MG${'3'.repeat(32)}`;
const message = `SM${'4'.repeat(32)}`;
function config(extra: NodeJS.ProcessEnv = {}) {
  resetConfigCache();
  return loadConfig({
    DATABASE_URL: 'postgres://test.invalid/synthetic', JWT_SECRET: 'synthetic'.repeat(8),
    CAREGIVER_SMS_PROVIDER: 'twilio', CAREGIVER_SMS_SENDER_APPROVED: 'true',
    TWILIO_ACCOUNT_SID: account, TWILIO_API_KEY_SID: key, TWILIO_API_KEY_SECRET: 'synthetic-secret',
    TWILIO_MESSAGING_SERVICE_SID: service, PUBLIC_APP_URL: 'https://example.invalid', ...extra,
  });
}
afterEach(() => resetConfigCache());

describe('optional Saudi invitation SMS transport (all HTTP mocked)', () => {
  it.each([
    { CAREGIVER_SMS_PROVIDER: 'disabled' }, { CAREGIVER_SMS_SENDER_APPROVED: 'false' },
    { TWILIO_API_KEY_SECRET: '' }, { TWILIO_ACCOUNT_SID: 'invalid' },
    { TWILIO_API_KEY_SID: 'invalid' }, { TWILIO_MESSAGING_SERVICE_SID: '' },
    { PUBLIC_APP_URL: 'http://example.invalid' },
  ])('does not send while setup is unavailable: %j', async (override) => {
    const fetcher = vi.fn();
    const provider = buildInvitationSms(config(override), fetcher);
    expect(provider.ready).toBe(false);
    expect(await provider.send('+966500000001', 'Synthetic invitation')).toBe('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends only to the fixed Twilio endpoint with a server key and explicit retention controls', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ sid: message, status: 'queued' }), { status: 201 }));
    const provider = buildInvitationSms(config(), fetcher);
    expect(provider.ready).toBe(true);
    expect(await provider.send('+966500000001', 'Synthetic invitation')).toBe('accepted');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from(`${key}:synthetic-secret`).toString('base64')}`);
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
      To: '+966500000001', Body: 'Synthetic invitation', MessagingServiceSid: service,
      ContentRetention: 'discard', AddressRetention: 'obfuscate', ShortenUrls: 'false', ValidityPeriod: '600',
    });
  });

  it.each(['+12025550123', '+966110000001', '0500000001'])('rejects unsupported recipients before HTTP: %s', async (to) => {
    const fetcher = vi.fn();
    expect(await buildInvitationSms(config(), fetcher).send(to, 'Synthetic invitation')).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { code: 400, body: '{}', expected: 'failed' },
    { code: 429, body: '{}', expected: 'failed' },
    { code: 503, body: '{}', expected: 'unknown' },
    { code: 201, body: '{', expected: 'unknown' },
    { code: 201, body: JSON.stringify({ sid: message, status: 'failed' }), expected: 'failed' },
    { code: 201, body: JSON.stringify({ status: 'accepted' }), expected: 'unknown' },
  ])('keeps failures/ambiguous outcomes distinct without retry: $code/$expected', async ({ code, body, expected }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: code }));
    expect(await buildInvitationSms(config(), fetcher).send('+966500000001', 'Synthetic invitation')).toBe(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry or expose the exception after a timeout that might follow acceptance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('SYNTHETIC_PRIVATE_PAYLOAD'));
    expect(await buildInvitationSms(config(), fetcher).send('+966500000001', 'Synthetic invitation')).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
