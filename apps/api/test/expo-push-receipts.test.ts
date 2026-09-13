import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider } from '../src/providers/push.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Expo push receipts', () => {
  it('requests receipt IDs with provider auth and maps ok/error while leaving missing IDs pending', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        data: {
          'ticket-ok': { status: 'ok' },
          'ticket-dead': {
            status: 'error',
            message: 'device is not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const cfg = { EXPO_ACCESS_TOKEN: 'synthetic-access-token' } as ConstructorParameters<typeof ExpoPushProvider>[0];
    const provider = new ExpoPushProvider(cfg);
    const result = await provider.getReceipts(['ticket-ok', 'ticket-dead', 'ticket-pending']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer synthetic-access-token' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ ids: ['ticket-ok', 'ticket-dead', 'ticket-pending'] });
    expect(result).toEqual([
      { providerMessageId: 'ticket-ok', status: 'ok' },
      {
        providerMessageId: 'ticket-dead',
        status: 'error',
        errorCode: 'DeviceNotRegistered',
        errorDetail: 'device is not registered',
      },
    ]);
  });

  it('fails the reconciliation call on provider HTTP failure instead of inventing receipts', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const cfg = { EXPO_ACCESS_TOKEN: undefined } as ConstructorParameters<typeof ExpoPushProvider>[0];
    const provider = new ExpoPushProvider(cfg);
    await expect(provider.getReceipts(['ticket-one'])).rejects.toThrow('HTTP 503');
  });
});
