import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SendResult, WhatsAppProvider, WhatsAppTemplateMessage } from './types.js';
import type { Config } from '../config.js';

/**
 * WhatsApp Business Platform (Meta Cloud API).
 *
 * Only the official Cloud API is supported. Unofficial personal-WhatsApp
 * automation is against Meta's terms and would get a real deployment banned,
 * so there is deliberately no such code path.
 *
 * Message content is kept minimal — patient first name, medication name, time,
 * status. No diagnosis, no dosage rationale, nothing that would turn an
 * intercepted notification into a medical disclosure.
 */
export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta_cloud';
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly appSecret: string | undefined;

  constructor(cfg: Config) {
    if (!cfg.WHATSAPP_PHONE_NUMBER_ID || !cfg.WHATSAPP_ACCESS_TOKEN) {
      throw new Error('WhatsApp Cloud API requires WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN');
    }
    this.phoneNumberId = cfg.WHATSAPP_PHONE_NUMBER_ID;
    this.accessToken = cfg.WHATSAPP_ACCESS_TOKEN;
    this.apiVersion = cfg.WHATSAPP_API_VERSION;
    this.appSecret = cfg.WHATSAPP_APP_SECRET;
  }

  async sendTemplate(message: WhatsAppTemplateMessage): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: message.templateName,
        language: { code: message.languageCode },
        components: message.parameters.length
          ? [{ type: 'body', parameters: message.parameters.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const json = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ id: string }>;
        error?: { code?: number; message?: string; error_subcode?: number };
      };

      if (!res.ok) {
        return {
          ok: false,
          errorCode: String(json.error?.code ?? res.status),
          errorDetail: json.error?.message ?? `HTTP ${res.status}`,
          // 4xx other than 429 means the request itself is wrong; retrying
          // would just burn quota and repeat the failure.
          retryable: res.status === 429 || res.status >= 500,
        };
      }
      return { ok: true, providerMessageId: json.messages?.[0]?.id };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'network_error',
        errorDetail: err instanceof Error ? err.message : 'unknown',
        retryable: true,
      };
    }
  }

  /** X-Hub-Signature-256 validation. An unsigned webhook is never processed. */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!this.appSecret || !signatureHeader) return false;
    const expected = `sha256=${createHmac('sha256', this.appSecret).update(rawBody, 'utf8').digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

export interface RecordedWhatsAppMessage extends WhatsAppTemplateMessage {
  at: string;
}

/**
 * Records instead of sending. This is what runs until real credentials exist,
 * and what the escalation tests assert against.
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock';
  readonly sent: RecordedWhatsAppMessage[] = [];
  /** Set to make the next N sends fail, for retry-path tests. */
  failNext = 0;

  async sendTemplate(message: WhatsAppTemplateMessage): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, errorCode: 'mock_failure', errorDetail: 'injected failure', retryable: true };
    }
    this.sent.push({ ...message, at: new Date().toISOString() });
    return { ok: true, providerMessageId: `mock-wa-${this.sent.length}` };
  }

  verifyWebhookSignature(): boolean {
    return true;
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = 0;
  }
}

/**
 * Approved template names. Meta requires every business-initiated template to
 * be submitted and approved before use; these identifiers must match what is
 * registered in the WhatsApp Manager. Placeholders are positional.
 */
export const WHATSAPP_TEMPLATES = {
  /** {{1}} patient name, {{2}} medication, {{3}} scheduled time */
  doseUnconfirmed: 'dawaee_dose_unconfirmed',
  /** {{1}} patient, {{2}} scheduled, {{3}} taken, {{4}} missed, {{5}} adherence % */
  dailySummary: 'dawaee_daily_summary',
  /** {{1}} patient name, {{2}} invite link */
  caregiverInvite: 'dawaee_caregiver_invite',
  /** {{1}} patient, {{2}} medication, {{3}} days remaining */
  lowStock: 'dawaee_low_stock',
} as const;
