import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { buildRecoveryVerify } from '../src/providers/recovery-verify.js';

const account = `AC${'1'.repeat(32)}`, key = `SK${'2'.repeat(32)}`, service = `VA${'3'.repeat(32)}`, verification = `VE${'4'.repeat(32)}`;
const phone = '+966500000001';
function config(extra: NodeJS.ProcessEnv = {}) {
  resetConfigCache();
  return loadConfig({ DATABASE_URL: 'postgres://test.invalid/synthetic', JWT_SECRET: 'synthetic'.repeat(8),
    PASSWORD_RECOVERY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: account, TWILIO_API_KEY_SID: key,
    TWILIO_API_KEY_SECRET: 'synthetic-secret', TWILIO_VERIFY_SERVICE_SID: service, ...extra });
}
const payload = (extra = {}) => ({ sid: verification, service_sid: service, account_sid: account,
  to: phone, status: 'pending', channel: 'sms', date_created: new Date().toISOString(), ...extra });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const challenge = () => ({ phone, verificationSid: verification, serviceSid: service, startedAt: Math.floor(Date.now() / 1000) });
afterEach(() => { resetConfigCache(); vi.useRealTimers(); });

describe('Twilio Verify transport, all external HTTP mocked', () => {
  it.each([{ PASSWORD_RECOVERY_PROVIDER: 'firebase' }, { TWILIO_ACCOUNT_SID: 'bad' },
    { TWILIO_API_KEY_SID: 'bad' }, { TWILIO_API_KEY_SECRET: '' }, { TWILIO_VERIFY_SERVICE_SID: `MG${'3'.repeat(32)}` },
  ])('fails closed when setup is incomplete: %j', async (extra) => {
    const request = vi.fn(), provider = buildRecoveryVerify(config(extra), request);
    expect(provider.ready).toBe(false);
    await expect(provider.start(phone, 'ar')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(request).not.toHaveBeenCalled();
  });
  it('creates an SMS verification with only server credentials and the selected locale', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(payload()));
    const provider = buildRecoveryVerify(config(), request);
    const result = await provider.start(phone, 'ar');
    expect(result).toMatchObject({ phone, verificationSid: verification, serviceSid: service });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`https://verify.twilio.com/v2/Services/${service}/Verifications`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({ To: phone, Channel: 'sms', Locale: 'ar' });
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from(`${key}:synthetic-secret`).toString('base64')}`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['+12025550123', '+966110000001', '0500000001'])('never sends outside Saudi mobiles: %s', async (to) => {
    const request = vi.fn();
    await expect(buildRecoveryVerify(config(), request).start(to, 'en')).rejects.toMatchObject({ reason: 'invalid' });
    expect(request).not.toHaveBeenCalled();
  });
  it('retains the original provider creation time on resend', async () => {
    const created = Math.floor(Date.now() / 1000) - 120;
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(payload({ date_created: new Date(created * 1000).toUTCString() })));
    expect((await buildRecoveryVerify(config(), request).start(phone, 'en')).startedAt).toBe(created);
  });
  it.each([
    { status: 'approved' }, { sid: 'bad' }, { to: '+966500000002' }, { service_sid: `VA${'5'.repeat(32)}` },
    { account_sid: `AC${'5'.repeat(32)}` }, { date_created: 'invalid' }, { date_created: '2000-01-01T00:00:00Z' },
  ])('refuses malformed or mismatched challenge results: %j', async (extra) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(payload(extra)));
    await expect(buildRecoveryVerify(config(), request).start(phone, 'ar')).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('checks the exact server-bound verification SID, never just a client phone', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(payload({ status: 'approved' })));
    expect(await buildRecoveryVerify(config(), request).check(challenge(), '123456')).toBe(true);
    expect(request.mock.calls[0]?.[0]).toBe(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`);
    expect(Object.fromEntries(request.mock.calls[0]![1]!.body as URLSearchParams)).toEqual({ VerificationSid: verification, Code: '123456' });
  });
  it.each([{ status: 'pending' }, { status: 'failed' }, { sid: `VE${'5'.repeat(32)}` },
    { to: '+966500000002' }, { account_sid: `AC${'5'.repeat(32)}` }, { service_sid: `VA${'5'.repeat(32)}` },
  ])('cannot accept an unapproved/mismatched check: %j', async (extra) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(payload({ status: 'approved', ...extra })));
    expect(await buildRecoveryVerify(config(), request).check(challenge(), '123456')).toBe(false);
  });
  it.each([{ status: 429, reason: 'rate_limited' }, { status: 404, reason: 'invalid' },
    { status: 401, reason: 'unavailable' }, { status: 503, reason: 'unavailable' },
  ])('maps a check HTTP $status without leaking payloads or retrying', async ({ status, reason }) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ message: 'SYNTHETIC_PRIVATE_RESPONSE' }, status));
    await expect(buildRecoveryVerify(config(), request).check(challenge(), '123456')).rejects.toMatchObject({ reason, message: 'Phone recovery verification failed' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not retry an ambiguous send timeout', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('SYNTHETIC_SECRET'));
    await expect(buildRecoveryVerify(config(), request).start(phone, 'ar')).rejects.toMatchObject({ reason: 'unavailable', message: 'Phone recovery verification failed' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
