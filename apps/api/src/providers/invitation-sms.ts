import type { Config } from '../config.js';

export type InvitationSmsStatus = 'accepted' | 'failed' | 'unknown' | 'unavailable';
export interface InvitationSmsProvider {
  readonly ready: boolean;
  send(to: string, body: string): Promise<InvitationSmsStatus>;
}

export const disabledInvitationSms: InvitationSmsProvider = {
  ready: false,
  send: async () => 'unavailable',
};

/** Saudi caregiver invitations only; never a general client-supplied SMS API. */
export function buildInvitationSms(cfg: Config, request: typeof fetch = fetch): InvitationSmsProvider {
  if (cfg.CAREGIVER_SMS_PROVIDER !== 'twilio' || !cfg.CAREGIVER_SMS_SENDER_APPROVED
    || !/^AC[0-9a-f]{32}$/i.test(cfg.TWILIO_ACCOUNT_SID ?? '')
    || !/^SK[0-9a-f]{32}$/i.test(cfg.TWILIO_API_KEY_SID ?? '')
    || !cfg.TWILIO_API_KEY_SECRET?.trim()
    || !/^MG[0-9a-f]{32}$/i.test(cfg.TWILIO_MESSAGING_SERVICE_SID ?? '')
    || !cfg.PUBLIC_APP_URL.startsWith('https://')) return disabledInvitationSms;

  return {
    ready: true,
    async send(to, body) {
      if (!/^\+9665\d{8}$/.test(to) || !body || body.length > 1000) return 'failed';
      try {
        const response = await request(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${cfg.TWILIO_API_KEY_SID}:${cfg.TWILIO_API_KEY_SECRET}`).toString('base64')}`,
          },
          body: new URLSearchParams({
            To: to, Body: body, MessagingServiceSid: cfg.TWILIO_MESSAGING_SERVICE_SID!,
            ContentRetention: 'discard', AddressRetention: 'obfuscate',
            ShortenUrls: 'false', ValidityPeriod: '600',
          }),
        });
        // A timeout/5xx may follow acceptance. Do not retry and risk double SMS.
        if (!response.ok) return response.status >= 400 && response.status < 500 ? 'failed' : 'unknown';
        const result = await response.json() as { sid?: unknown; status?: unknown };
        if (result.status === 'failed' || result.status === 'undelivered') return 'failed';
        if (typeof result.sid !== 'string' || !/^SM[0-9a-f]{32}$/i.test(result.sid)) return 'unknown';
        // Provider acceptance is not delivery to the recipient's phone.
        return ['accepted', 'queued', 'sending', 'sent', 'delivered'].includes(String(result.status)) ? 'accepted' : 'unknown';
      } catch {
        // Never surface provider payloads, phone numbers or credentials in logs.
        return 'unknown';
      }
    },
  };
}
