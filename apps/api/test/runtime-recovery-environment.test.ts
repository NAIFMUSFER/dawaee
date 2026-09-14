import { describe, expect, it } from 'vitest';
import { validateRuntimeRecoveryEnvironment } from '../../../scripts/release-runtime-harness.mjs';

describe('runtime recovery execution boundary', () => {
  const head = 'a'.repeat(40);
  const allowed = { NODE_ENV: 'test', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'NAIFMUSFER/dawaee', RECOVERY_CANDIDATE_SHA: head };
  it('accepts the selected commit on a disposable hosted runner', () => {
    expect(() => validateRuntimeRecoveryEnvironment(allowed, head)).not.toThrow();
  });
  it.each([
    { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_REPOSITORY: 'unrelated/project' }, { RECOVERY_CANDIDATE_SHA: 'b'.repeat(40) },
    { DOCKER_HOST: 'tcp://remote.invalid:2376' }, { DOCKER_CONTEXT: 'production' },
    { NODE_ENV: 'production' }, { PGHOST: 'remote.invalid' }, { PGPORT: '5432' },
  ])('rejects another runtime or database before I/O: %j', override => {
    expect(() => validateRuntimeRecoveryEnvironment({ ...allowed, ...override }, head)).toThrow();
  });
});
