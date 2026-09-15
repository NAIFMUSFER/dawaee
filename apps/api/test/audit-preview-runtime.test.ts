import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supervisePreview } from '../../../scripts/audit-preview-runtime.mjs';
import { runtimeEnvironment, validateRuntimeRole, validateTarget } from '../../../scripts/audit-preview-start.mjs';

const env = {
  RENDER_SERVICE_ID: 'srv-daipkbuk1f9s73952trg',
  RENDER_EXTERNAL_URL: 'https://dawaee-audit-preview.onrender.com', NODE_ENV: 'test',
  RENDER_GIT_COMMIT: 'a'.repeat(40),
  DATABASE_URL: 'postgresql://dawaee_audit_db_user:synthetic-owner-password@dpg-daipq80jo6nc73fsmhhg-a/dawaee_audit_db',
  JWT_SECRET: 'synthetic-not-a-secret'.repeat(3), IP_HASH_SALT: 'synthetic-salt-for-test',
};

describe('audit preview runtime credential isolation', () => {
  it('gives each child only its own database credential and fixes providers and identity', () => {
    const source = { ...env, WORKER_DATABASE_URL: 'must-not-copy', DAWAEE_APP_PASSWORD: 'must-not-copy',
      DAWAEE_WORKER_PASSWORD: 'must-not-copy', EXPO_ACCESS_TOKEN: 'must-not-copy',
      STORAGE_SECRET_ACCESS_KEY: 'must-not-copy', NODE_OPTIONS: 'must-not-copy',
      WORKER_ENABLED: 'false', WORKER_READINESS_REQUIRED: 'false', PUSH_PROVIDER: 'expo' };
    const owner = validateTarget(env);
    for (const role of ['dawaee_app', 'dawaee_worker']) {
      const child = runtimeEnvironment(source, owner, `synthetic-${role}`, role);
      const url = new URL(child.DATABASE_URL);
      expect(url.username).toBe(role);
      expect(url.password).toBe(`synthetic-${role}`);
      expect(JSON.stringify(child)).not.toContain('must-not-copy');
      expect(JSON.stringify(child)).not.toContain('synthetic-owner-password');
      expect(child).toMatchObject({ PUSH_PROVIDER: 'mock', OCR_PROVIDER: 'mock', STORAGE_PROVIDER: 'local',
        WORKER_READINESS_REQUIRED: 'true', WORKER_ENABLED: 'true', WORKER_TICK_SECONDS: '60',
        GIT_COMMIT: env.RENDER_GIT_COMMIT, RENDER_GIT_COMMIT: env.RENDER_GIT_COMMIT });
    }
    expect(() => runtimeEnvironment(source, owner, 'synthetic', 'dawaee_audit_db_user')).toThrow('AUDIT_RUNTIME_ROLE_REFUSED');
  });

  it.each(['dawaee_app', 'dawaee_worker'])('requires the actual %s connection to have no elevated or sibling membership', role => {
    const row = { role, super: false, bypass: false, create_role: false, create_db: false,
      owner_member: false, sibling_member: false };
    expect(() => validateRuntimeRole([row], role)).not.toThrow();
    for (const key of ['super', 'bypass', 'create_role', 'create_db', 'owner_member', 'sibling_member']) {
      expect(() => validateRuntimeRole([{ ...row, [key]: true }], role)).toThrow('AUDIT_RUNTIME_IDENTITY_UNSAFE');
    }
    expect(() => validateRuntimeRole([{ ...row, role: 'another_role' }], role)).toThrow();
    expect(() => validateRuntimeRole([], role)).toThrow();
  });
});

class Child extends EventEmitter {
  kill = vi.fn(() => true);
}

function harness() {
  const worker = new Child();
  const api = new Child();
  const signals = new EventEmitter();
  const spawnProcess = vi.fn().mockReturnValueOnce(worker).mockReturnValueOnce(api);
  const runtime = { api: { ONLY: 'app' }, worker: { ONLY: 'worker' } };
  const done = supervisePreview(runtime, { spawnProcess, signals, shutdownMs: 100 });
  return { worker, api, signals, spawnProcess, done, runtime };
}

describe('audit preview process supervision', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['SIGTERM', 'SIGINT'])('starts the worker first with separate environments and drains both on %s', async signal => {
    const h = harness();
    expect(h.spawnProcess.mock.calls.map(call => call[1])).toEqual([
      ['apps/worker/dist/index.js'], ['apps/api/dist/index.js'],
    ]);
    expect(h.spawnProcess.mock.calls[0][2].env).toBe(h.runtime.worker);
    expect(h.spawnProcess.mock.calls[1][2].env).toBe(h.runtime.api);
    h.signals.emit(signal);
    expect(h.worker.kill).toHaveBeenCalledWith(signal);
    expect(h.api.kill).toHaveBeenCalledWith(signal);
    h.worker.emit('close', 0);
    h.api.emit('close', 0);
    expect(await h.done).toBe(0);
    expect(h.signals.listenerCount('SIGTERM') + h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it.each(['worker', 'api'] as const)('stops the sibling and fails even when %s exits unexpectedly with code zero', async kind => {
    const h = harness();
    const sibling = kind === 'worker' ? h.api : h.worker;
    h[kind].emit('close', 0);
    expect(sibling.kill).toHaveBeenCalledWith('SIGTERM');
    sibling.emit('close', 0);
    expect(await h.done).toBe(1);
  });

  it('handles an asynchronous spawn error without leaving the other process alive', async () => {
    const h = harness();
    h.api.emit('error', new Error('synthetic failure'));
    h.api.emit('close', -2);
    expect(h.worker.kill).toHaveBeenCalledWith('SIGTERM');
    h.worker.emit('close', 0);
    expect(await h.done).toBe(1);
  });

  it('cleans up when the second spawn throws synchronously', async () => {
    const worker = new Child();
    const signals = new EventEmitter();
    const spawnProcess = vi.fn().mockReturnValueOnce(worker).mockImplementationOnce(() => { throw new Error('synthetic'); });
    const done = supervisePreview({ worker: {}, api: {} }, { spawnProcess, signals });
    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    worker.emit('close', 0);
    expect(await done).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('kills a child that cannot drain within the shutdown deadline and reports failure', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.signals.emit('SIGTERM');
    h.api.emit('close', 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.worker.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(h.api.kill).toHaveBeenCalledTimes(1);
    h.worker.emit('close', null);
    expect(await h.done).toBe(1);
  });
});
