import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { ExpoPushProvider } from '../src/providers/push.js';
import type { PushMessage } from '../src/providers/types.js';

const message = (token: string): PushMessage => ({
  token,
  title: 'Medication reminder',
  body: 'Time for your dose',
  data: { kind: 'dose_reminder' },
  priority: 'high',
});

const response = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Expo push send response integrity', () => {
  it('preserves one result per message when Expo returns a short ticket array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      data: [{ status: 'ok', id: 'ticket-1' }],
    })));
    const provider = new ExpoPushProvider({ EXPO_ACCESS_TOKEN: undefined } as Config);

    const results = await provider.send([message('token-a'), message('token-b')]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ok: true, providerMessageId: 'ticket-1' });
    expect(results[1]).toMatchObject({
      ok: false,
      errorCode: 'malformed_provider_response',
      retryable: true,
    });
  });

  it('does not accept an ok ticket that lacks the receipt id needed for reconciliation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      data: [{ status: 'ok' }],
    })));
    const provider = new ExpoPushProvider({ EXPO_ACCESS_TOKEN: undefined } as Config);

    const results = await provider.send([message('token-a')]);

    expect(results).toEqual([{
      ok: false,
      errorCode: 'malformed_provider_response',
      retryable: true,
    }]);
  });

  it('clears the abort timer when the transport throws', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic network failure'); }));
    const provider = new ExpoPushProvider({ EXPO_ACCESS_TOKEN: undefined } as Config);

    const results = await provider.send([message('token-a')]);

    expect(results[0]).toMatchObject({ ok: false, errorCode: 'network_error', retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
