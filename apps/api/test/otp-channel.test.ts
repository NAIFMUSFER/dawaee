import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startHarness, type Harness } from './harness.js';
import { resetConfigCache } from '../src/config.js';

/**
 * Login over WhatsApp. Saudi A2P SMS needs a Sender ID registered against a
 * commercial registration, and long/short codes do not exist there at all, so
 * WhatsApp is the channel that can actually be switched on.
 */
let h: Harness;

beforeAll(async () => {
  resetDatabase();
  process.env.OTP_CHANNEL = 'whatsapp';
  resetConfigCache();
  h = await startHarness();
});

afterAll(async () => {
  delete process.env.OTP_CHANNEL;
  resetConfigCache();
  await h.close();
});

describe('login code over WhatsApp', () => {
  it('sends the authentication template and nothing over SMS', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request',
      payload: { phone: '0555123456', locale: 'ar' },
    });
    expect(res.statusCode).toBe(200);

    expect(h.sms.sent).toHaveLength(0);
    expect(h.whatsapp.sent).toHaveLength(1);

    const msg = h.whatsapp.sent[0]!;
    expect(msg.templateName).toBe('dawaee_login_code');
    expect(msg.languageCode).toBe('ar');

    // The code must be in the body AND on the copy button — the button copy is
    // the one WhatsApp puts on the clipboard.
    const code = msg.parameters[0]!;
    expect(code).toMatch(/^\d{6}$/);
    expect(msg.authenticationCode).toBe(code);
  });

  it('carries no health information — only the code', async () => {
    const msg = h.whatsapp.sent.at(-1)!;
    const payload = JSON.stringify(msg).toLowerCase();
    for (const leak of ['medication', 'dose', 'panadol', 'patient', 'adherence']) {
      expect(payload).not.toContain(leak);
    }
    expect(msg.parameters).toHaveLength(1);
  });

  it('still returns the same shape for an unknown number', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/auth/otp/request',
      payload: { phone: '0559999999', locale: 'en' },
    });
    expect(res.statusCode).toBe(200);
    // Same shape either way: revealing "no account for this number" would turn
    // the endpoint into a way to test whether someone uses a medication app.
    expect(res.json().sent).toBe(true);
    expect(h.whatsapp.sent.at(-1)!.templateName).toBe('dawaee_login_code');
  });
});
