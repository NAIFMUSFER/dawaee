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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal,
        });
        clearTimeout(timer);

        const json = (await res.json().catch(() => ({}))) as {
          data?: Array<{ status: string; id?: string; message?: string; details?: { error?: string } }>;
        };
        if (!res.ok || !json.data) {
          for (const _ of batch) results.push({ ok: false, errorCode: `http_${res.status}`, retryable: res.status >= 500 });
          continue;
        }

        json.data.forEach((ticket, idx) => {
          if (ticket.status === 'ok') {
            results.push({ ok: true, providerMessageId: ticket.id });
          } else {
            const error = ticket.details?.error;
            results.push({
              ok: false,
              errorCode: error ?? 'push_error',
              errorDetail: ticket.message,
              invalidTokens: error === 'DeviceNotRegistered' ? [batch[idx]!.token] : undefined,
              retryable: error === 'MessageRateExceeded',
            });
          }
        });
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

    // Expo accepts up to 1,000 receipt IDs per request; smaller batches bound a
    // single worker tick's response and retry cost.
    for (let i = 0; i < providerMessageIds.length; i += 500) {
      const ids = providerMessageIds.slice(i, i + 500);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
          method: 'POST', headers: this.headers(), body: JSON.stringify({ ids }), signal: controller.signal,
        });
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
          // Missing IDs are intentionally omitted. The worker keeps them
          // pending instead of inventing a provider result.
        }
      } finally {
        clearTimeout(timer);
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
    return providerMessageIds.flatMap((id) => {
      if (this.pendingReceipts.has(id)) return [];
      const errorCode = this.receiptErrors.get(id);
      return errorCode
        ? [{ providerMessageId: id, status: 'error' as const, errorCode, errorDetail: `mock receipt: ${errorCode}` }]
        : [{ providerMessageId: id, status: 'ok' as const }];
    });
  }

  reset(): void {
    this.sent.length = 0;
    this.deadTokens.clear();
    this.receiptErrors.clear();
    this.pendingReceipts.clear();
  }
}
