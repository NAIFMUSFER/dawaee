import type { SendResult, SmsProvider } from './types.js';
import type { Config } from '../config.js';

/** Twilio — broad international reach, used as the default real provider. */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(private readonly cfg: Config) {
    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_FROM) {
      throw new Error('Twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
    }
  }

  async send(to: string, body: string): Promise<SendResult> {
    const sid = this.cfg.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${this.cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: this.cfg.TWILIO_FROM!, Body: body }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (!res.ok) {
        return { ok: false, errorCode: String(json.code ?? res.status), errorDetail: json.message, retryable: res.status >= 500 };
      }
      return { ok: true, providerMessageId: json.sid };
    } catch (err) {
      return { ok: false, errorCode: 'network_error', errorDetail: String(err), retryable: true };
    }
  }
}

/** Unifonic — strong deliverability inside Saudi Arabia. */
export class UnifonicSmsProvider implements SmsProvider {
  readonly name = 'unifonic';
  constructor(private readonly cfg: Config) {
    if (!cfg.UNIFONIC_APP_SID) throw new Error('Unifonic requires UNIFONIC_APP_SID');
  }

  async send(to: string, body: string): Promise<SendResult> {
    try {
      const res = await fetch('https://el.cloud.unifonic.com/rest/SMS/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          AppSid: this.cfg.UNIFONIC_APP_SID!,
          Recipient: to.replace(/^\+/, ''),
          Body: body,
          ...(this.cfg.UNIFONIC_SENDER_ID ? { SenderID: this.cfg.UNIFONIC_SENDER_ID } : {}),
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean | string; data?: { MessageID?: string | number }; message?: string; errorCode?: string;
      };
      const ok = res.ok && (json.success === true || json.success === 'true');
      if (!ok) {
        return { ok: false, errorCode: json.errorCode ?? String(res.status), errorDetail: json.message, retryable: res.status >= 500 };
      }
      return { ok: true, providerMessageId: String(json.data?.MessageID ?? '') };
    } catch (err) {
      return { ok: false, errorCode: 'network_error', errorDetail: String(err), retryable: true };
    }
  }
}

export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';
  readonly sent: Array<{ to: string; body: string; at: string }> = [];

  async send(to: string, body: string): Promise<SendResult> {
    this.sent.push({ to, body, at: new Date().toISOString() });
    return { ok: true, providerMessageId: `mock-sms-${this.sent.length}` };
  }

  /** Test helper: pull the OTP the mock "sent" to a number. */
  lastCodeFor(to: string): string | null {
    const last = [...this.sent].reverse().find((m) => m.to === to);
    return last?.body.match(/\d{4,8}/)?.[0] ?? null;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
