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
  it.each([[429, true], [500, true], [503, true], [400, false], [401, false], [403, false]])(
    'classifies HTTP %i as retryable=%s without invalidating devices', async (status, retryable) => {
      const request = vi.fn(async () => response(Number(status), { errors: [{ message: 'private-provider-marker' }] }));
      vi.stubGlobal('fetch', request);
      const provider = new ExpoPushProvider({ EXPO_ACCESS_TOKEN: undefined } as Config);
      const results = await provider.send([message('token-a'), message('token-b')]);
      expect(results).toEqual(Array.from({ length: 2 }, () => ({
        ok: false, errorCode: `http_${status}`, retryable,
      })));
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(results)).not.toContain('private-provider-marker');
    },
  );

  it('retains rate-limit classification when the 429 response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('temporary limit', { status: 429 })));
    const provider = new ExpoPushProvider({ EXPO_ACCESS_TOKEN: undefined } as Config);
    expect(await provider.send([message('token-a')])).toEqual([
      { ok: false, errorCode: 'http_429', retryable: true },
    ]);
  });

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
