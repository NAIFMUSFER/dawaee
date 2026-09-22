import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.js', () => ({ api: { baseUrl: 'https://audit.invalid' },
  DEMO_MODE: false, NetworkError: class NetworkError extends Error {} }));
import { waitForAuthServer } from '../src/api/auth-connection.js';
import { NetworkError } from '../src/api/client.js';

const fetcher = vi.fn();
const ready = () => new Response(JSON.stringify({ status: 'ok', service: 'dawaee-api' }));
beforeEach(() => { vi.useFakeTimers(); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('authentication waits through cold startup using credential-free GETs only', () => {
  it('accepts the live API and sends no body, cookies or authorization', async () => {
    fetcher.mockResolvedValueOnce(ready());
    await waitForAuthServer(new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(['https://audit.invalid/health', {
      method: 'GET', credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal),
    }]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits through gateway wake-up failures before accepting the API', async () => {
    fetcher.mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ready());
    const pending = waitForAuthServer(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET' && !options.body && !options.headers)).toBe(true);
  });
  it('does not mistake an HTML wake page or another service for the API', async () => {
    fetcher.mockResolvedValueOnce(new Response('<html>Starting</html>'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', service: 'other' })))
      .mockResolvedValueOnce(ready());
    const pending = waitForAuthServer(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not repeat requests rejected by an HTTP policy or a missing endpoint', async () => {
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(waitForAuthServer(new AbortController().signal)).rejects.toBeInstanceOf(NetworkError);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('times out a hung probe and can recover without sending a credential request', async () => {
    fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    })).mockResolvedValueOnce(ready());
    const pending = waitForAuthServer(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(16_500); await pending;
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('ends an unavailable connection within the overall 75-second budget', async () => {
    fetcher.mockRejectedValue(new TypeError('unreachable'));
    const outcome = waitForAuthServer(new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await outcome).toBeInstanceOf(NetworkError);
    expect(vi.getTimerCount()).toBe(0);
    const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('does not probe an already-closed screen', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(waitForAuthServer(controller.signal)).rejects.toThrow('screen closed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels a pending probe when the screen closes', async () => {
    fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const controller = new AbortController();
    const outcome = waitForAuthServer(controller.signal).catch(error => error);
    controller.abort(); expect((await outcome).message).toContain('screen closed');
    expect(vi.getTimerCount()).toBe(0); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels the retry delay without scheduling another request', async () => {
    fetcher.mockResolvedValue(new Response('', { status: 502 }));
    const controller = new AbortController();
    const outcome = waitForAuthServer(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect((await outcome).message).toContain('screen closed');
    expect(vi.getTimerCount()).toBe(0); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
