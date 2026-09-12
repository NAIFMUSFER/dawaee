import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { buildProviders } from '../src/providers/index.js';

const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
  DATABASE_SSL: 'true',
  JWT_SECRET: 'x'.repeat(64),
  IP_HASH_SALT: 'audit-production-ocr-salt',
  PUSH_PROVIDER: 'expo',
} as NodeJS.ProcessEnv;

function config(extra: NodeJS.ProcessEnv) {
  resetConfigCache();
  return loadConfig({ ...base, ...extra });
}

afterEach(() => resetConfigCache());

describe('production OCR provider safety', () => {
  it('fails closed instead of returning realistic mock medication data', async () => {
    const providers = buildProviders(config({
      NODE_ENV: 'production',
      OCR_PROVIDER: 'mock',
      STORAGE_PROVIDER: 'r2',
    }));

    expect(providers.ocr.name).toBe('unconfigured');
    await expect(
      providers.ocr.readMedicationLabel(Buffer.from('synthetic-image'), 'image/png'),
    ).rejects.toThrow(/OCR provider is not configured/i);
    await expect(
      providers.ocr.readPrescription(Buffer.from('synthetic-image'), 'image/png'),
    ).rejects.toThrow(/OCR provider is not configured/i);
  });

  it('keeps the deterministic mock available outside production for tests and development', async () => {
    const providers = buildProviders(config({
      NODE_ENV: 'test',
      OCR_PROVIDER: 'mock',
      STORAGE_PROVIDER: 'local',
    }));

    expect(providers.ocr.name).toBe('mock');
    const result = await providers.ocr.readMedicationLabel(Buffer.from('ignored'), 'image/png');
    expect(result.provider).toBe('mock');
    expect(result.fields.name?.value).toBeTruthy();
  });
});
