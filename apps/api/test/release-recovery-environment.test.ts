import { describe, expect, it } from 'vitest';
import { validateRecoveryEnvironment } from '../../../scripts/release-recovery-harness.mjs';

describe('recovery rehearsal target containment', () => {
  const local = { NODE_ENV: 'test', PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' };
  it('accepts only the dedicated local test topology', () => {
    expect(() => validateRecoveryEnvironment(local)).not.toThrow();
  });
  it.each([
    { NODE_ENV: 'production' }, { PGHOST: 'db.production.invalid' },
    { PGPORT: '5432' }, { PGUSER: 'dawaee_app' }, { DAWAEE_MIGRATOR_ROLE: 'postgres' },
  ])('refuses an unrelated target before any I/O: %j', (override) => {
    expect(() => validateRecoveryEnvironment({ ...local, ...override })).toThrow();
  });
});
