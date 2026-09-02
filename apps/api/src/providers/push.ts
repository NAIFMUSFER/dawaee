import type { PushMessage, PushProvider, PushSendResult } from './types.js';
import type { Config } from '../config.js';

/**
 * Push delivery through Expo, which fans out to APNs and FCM.
 *
 * On the OS-capability question from the brief: this sets the strongest
 * signals each platform actually permits for a non-exempt app — Android uses a
 * high-importance notification channel with a custom sound and full-screen
 * intent capability; iOS uses `time-sensitive` interruption level, which can
 * break through Focus modes when the user allows it. iOS *critical* alerts
 * need a special Apple entitlement that medication apps are rarely granted, so
 * the code does not pretend to have it. Anything stronger than this is a local
 * notification scheduled on-device, which is why the app schedules those too.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';
  private readonly accessToken: string | undefined;

  constructor(cfg: Config) {
    this.accessToken = cfg.EXPO_ACCESS_TOKEN;
  }

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    if (messages.length === 0) return [];
    const results: PushSendResult[] = [];

    // Expo accepts at most 100 messages per request.
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
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const json = (await res.json().catch(() => ({}))) as {
          data?: Array<{ status: string; id?: string; message?: string; details?: { error?: string } }>;
        };

        if (!res.ok || !json.data) {
          for (const _ of batch) {
            results.push({ ok: false, errorCode: `http_${res.status}`, retryable: res.status >= 500 });
          }
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
              // A dead token must be pruned, not retried forever.
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
}

export class MockPushProvider implements PushProvider {
  readonly name = 'mock';
  readonly sent: Array<PushMessage & { at: string }> = [];
  readonly deadTokens = new Set<string>();

  async send(messages: PushMessage[]): Promise<PushSendResult[]> {
    return messages.map((m) => {
      if (this.deadTokens.has(m.token)) {
        return { ok: false, errorCode: 'DeviceNotRegistered', invalidTokens: [m.token], retryable: false };
      }
      this.sent.push({ ...m, at: new Date().toISOString() });
      return { ok: true, providerMessageId: `mock-push-${this.sent.length}` };
    });
  }

  reset(): void {
    this.sent.length = 0;
    this.deadTokens.clear();
  }
}
