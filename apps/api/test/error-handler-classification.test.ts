import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@dawaee/shared';
import { registerErrorHandler } from '../src/middleware/error-handler.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(statusCode: number) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerErrorHandler(app);
  app.get('/boom', async () => {
    throw Object.assign(new Error(`status-${statusCode}`), { statusCode });
  });
  return app;
}

describe('HTTP client errors keep their semantic API code', () => {
  const cases = [
    [401, ERROR_CODES.UNAUTHENTICATED],
    [403, ERROR_CODES.FORBIDDEN],
    [404, ERROR_CODES.NOT_FOUND],
    [409, ERROR_CODES.CONFLICT],
  ] as const;

  for (const [status, expectedCode] of cases) {
    it(`${status} is not mislabeled as validation_failed`, async () => {
      const app = build(status);
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(expectedCode);
      expect(res.json().error.code).not.toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  }

  it('keeps a true bad-request error as validation_failed', async () => {
    const app = build(400);
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});
