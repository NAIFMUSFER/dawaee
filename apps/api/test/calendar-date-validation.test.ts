import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { optionalDate, requireDate, requireDateRange } from '../src/lib/params.js';

describe('calendar-date edge validation', () => {
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    registerErrorHandler(app);
    app.get('/probe', async (req) => {
      const { value } = req.query as { value?: string };
      return { value: requireDate(value, 'value') };
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it.each([
    '0000-01-01',
    '2026-00-10',
    '2026-13-10',
    '2026-01-00',
    '2026-01-32',
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-06-31',
    '2026-11-31',
  ])('returns a stable 400 for the nonexistent Gregorian date %s', async value => {
    const response = await app.inject({ method: 'GET', url: `/probe?value=${value}` });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { code: string; details: Array<{ path: string }> } }>().error).toMatchObject({
      code: 'validation_failed',
      details: [{ path: 'value' }],
    });
    expect(response.body).not.toMatch(/Postgres|SQL|date\/time field value|out of range/i);
  });

  it.each(['0001-01-01', '2000-02-29', '2024-02-29', '2026-04-30', '9999-12-31'])(
    'retains the real calendar date %s', value => {
      expect(requireDate(value, 'value')).toBe(value);
    },
  );

  it('applies the same calendar guard to optional dates and both range endpoints', () => {
    expect(optionalDate('', 'from')).toBeNull();
    expect(() => optionalDate('2026-02-29', 'from')).toThrow();
    expect(() => requireDateRange('2026-02-28', '2026-02-29')).toThrow();
    expect(() => requireDateRange('2026-04-31', '2026-05-01')).toThrow();
    expect(requireDateRange('2024-02-29', '2024-03-01')).toEqual({
      from: '2024-02-29', to: '2024-03-01',
    });
  });
});
