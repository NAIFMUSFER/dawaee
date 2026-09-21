import type { PushMessage, PushProvider, PushReceiptResult, PushSendResult } from './types.js';
import type { Config } from '../config.js';

/** Push delivery through Expo, which fans out to APNs and FCM. */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';
  private readonly accessToken: string | undefined;

  constructor(cfg: Config) {
    this.accessToken = cfg.EXPO_ACCESS_TOKEN;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
    };
  }

  private async post(url: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    if (messages.length === 0) return [];
    const results: PushSendResult[] = [];

    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const body = batch.map((m) => ({
        to: m.token,
        title: m.title,
        body: m.body,
        data: m.data,
        sound: m.sound ?? 'default',
        priority: m.priority,
        channelId: m.priority === 'high' ? 'medication-critical' : 'default',
        interruptionLevel: m.priority === 'high' ? 'time-sensitive' : 'active',
        categoryId: m.categoryId,
        badge: m.badge,
        ttl: 3600,
      }));

      try {
        const res = await this.post('https://exp.host/--/api/v2/push/send', body);
        const json = (await res.json().catch(() => ({}))) as {
          data?: Array<{ status?: string; id?: string; message?: string; details?: { error?: string } }>;
        };
        if (!res.ok || !Array.isArray(json.data)) {
          const errorCode = res.ok ? 'malformed_provider_response' : `http_${res.status}`;
          for (const _ of batch) {
            // HTTP throttling is temporary just like MessageRateExceeded in
            // a ticket. Let the durable dispatcher apply bounded backoff;
            // never loop/retry here or mark a rate-limited device invalid.
            results.push({ ok: false, errorCode, retryable: res.ok || res.status === 429 || res.status >= 500 });
          }
          continue;
        }

        for (let idx = 0; idx < batch.length; idx += 1) {
          const ticket = json.data[idx];
          if (!ticket) {
            results.push({ ok: false, errorCode: 'malformed_provider_response', retryable: true });
            continue;
          }
          if (ticket.status === 'ok') {
            if (typeof ticket.id === 'string' && ticket.id.length > 0) {
              results.push({ ok: true, providerMessageId: ticket.id });
            } else {
              results.push({ ok: false, errorCode: 'malformed_provider_response', retryable: true });
            }
            continue;
          }
          if (ticket.status === 'error') {
            const error = ticket.details?.error;
            results.push({
              ok: false,
              errorCode: error ?? 'push_error',
              errorDetail: ticket.message,
              invalidTokens: error === 'DeviceNotRegistered' ? [batch[idx]!.token] : undefined,
              retryable: error === 'MessageRateExceeded',
            });
            continue;
          }
          results.push({ ok: false, errorCode: 'malformed_provider_response', retryable: true });
        }
      } catch (err) {
        for (const _ of batch) {
          results.push({
            ok: false,
            errorCode: 'network_error',
            errorDetail: err instanceof Error ? err.message : 'unknown',
            retryable: true,
          });
        }
      }
    }
    return results;
  }

  async getReceipts(providerMessageIds: string[]): Promise<PushReceiptResult[]> {
    if (providerMessageIds.length === 0) return [];
    const results: PushReceiptResult[] = [];

    for (let i = 0; i < providerMessageIds.length; i += 500) {
      const ids = providerMessageIds.slice(i, i + 500);
      const res = await this.post('https://exp.host/--/api/v2/push/getReceipts', { ids });
      const json = (await res.json().catch(() => ({}))) as {
        data?: Record<string, { status?: string; message?: string; details?: { error?: string } }>;
      };
      if (!res.ok || !json.data) throw new Error(`Expo push receipt request failed with HTTP ${res.status}`);

      for (const [id, receipt] of Object.entries(json.data)) {
        if (receipt.status === 'ok') {
          results.push({ providerMessageId: id, status: 'ok' });
        } else if (receipt.status === 'error') {
          results.push({
            providerMessageId: id,
            status: 'error',
            errorCode: receipt.details?.error ?? 'push_receipt_error',
            errorDetail: receipt.message,
          });
        }
      }
    }
    return results;
  }
}

export class MockPushProvider implements PushProvider {
  readonly name = 'mock';
  readonly sent: Array<PushMessage & { at: string }> = [];
  readonly deadTokens = new Set<string>();
  readonly receiptErrors = new Map<string, string>();
  readonly pendingReceipts = new Set<string>();

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    return messages.map((m) => {
      if (this.deadTokens.has(m.token)) {
        return { ok: false, errorCode: 'DeviceNotRegistered', invalidTokens: [m.token], retryable: false };
      }
      this.sent.push({ ...m, at: new Date().toISOString() });
      return { ok: true, providerMessageId: `mock-push-${this.sent.length}` };
    });
  }

  async getReceipts(providerMessageIds: string[]): Promise<PushReceiptResult[]> {
    const results: PushReceiptResult[] = [];
    for (const id of providerMessageIds) {
      if (this.pendingReceipts.has(id)) continue;
      const errorCode = this.receiptErrors.get(id);
      if (errorCode) {
        results.push({ providerMessageId: id, status: 'error', errorCode, errorDetail: `mock receipt: ${errorCode}` });
      } else {
        results.push({ providerMessageId: id, status: 'ok' });
      }
    }
    return results;
  }

  reset(): void {
    this.sent.length = 0;
    this.deadTokens.clear();
    this.receiptErrors.clear();
    this.pendingReceipts.clear();
  }
}
