import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { GoogleVisionOcrProvider } from '../src/providers/ocr.js';

const API_KEY = 'test-google-vision-key-not-a-secret';

function provider(): GoogleVisionOcrProvider {
  resetConfigCache();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_SECRET: 'x'.repeat(64),
    OCR_PROVIDER: 'google_vision',
    GOOGLE_VISION_API_KEY: API_KEY,
  });
  return new GoogleVisionOcrProvider(cfg);
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetConfigCache();
});

describe('Google Vision credential transport', () => {
  it('keeps the API key out of the request URL and sends it in x-goog-api-key', async () => {
    let requestedUrl = '';
    let requestedHeaders = new Headers();
    let requestedBody = '';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(
        JSON.stringify({ responses: [{ fullTextAnnotation: { text: 'PANADOL 500 mg' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));

    const result = await provider().readMedicationLabel(Buffer.from([1, 2, 3]), 'image/png');

    const url = new URL(requestedUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://vision.googleapis.com/v1/images:annotate');
    expect(url.searchParams.has('key')).toBe(false);
    expect(requestedUrl).not.toContain(API_KEY);
    expect(requestedBody).not.toContain(API_KEY);
    expect(requestedHeaders.get('x-goog-api-key')).toBe(API_KEY);
    expect(requestedHeaders.get('content-type')).toBe('application/json');
    expect(result.provider).toBe('google_vision');
  });
});
