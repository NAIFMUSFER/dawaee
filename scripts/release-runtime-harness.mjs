// Rebuilt, pinned runtimes on an owned CI-only Docker network. No live targets.
import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecoveryEnvironment } from './release-recovery-harness.mjs';

export const RECORDED_RUNTIME_SHAS = Object.freeze({
  oldApi: '4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72',
  oldWorker: '0338ddefc475d23cccecf13d5ede0f32d2007fb0',
  servingApi: '60b474ea81105529c16f88d5b878c5c274c7b03b',
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function validateRuntimeRecoveryEnvironment(env, head) {
  validateRecoveryEnvironment(env);
  assert.equal(env.GITHUB_ACTIONS, 'true', 'runtime rehearsal requires GitHub Actions');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'runtime rehearsal requires a disposable hosted runner');
  assert.equal(env.GITHUB_REPOSITORY, 'NAIFMUSFER/dawaee', 'unexpected rehearsal repository');
  assert.equal(env.DOCKER_HOST ?? 'unix:///var/run/docker.sock', 'unix:///var/run/docker.sock', 'remote Docker is refused');
  assert.equal(env.DOCKER_CONTEXT ?? 'default', 'default', 'non-default Docker context is refused');
  assert.match(head, /^[0-9a-f]{40}$/, 'candidate must be a full commit SHA');
  assert.equal(env.RECOVERY_CANDIDATE_SHA, head, 'checkout must be the selected candidate, not a merge ref');
}

export function parseRecoveryLoopbackPort(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, 'recovery port must have exactly one host binding');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(lines[0]);
  assert.ok(match, 'recovery port must bind only to IPv4 loopback');
  const port = Number(match[1]);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, 'recovery host port is invalid');
  return String(port);
}

export async function until(label, probe, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await probe();
    if (value) return value;
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error(`timed out: ${label}`);
}

export async function createRuntimeHarness(env = process.env) {
  // Validate external inputs before invoking Docker or creating files.
  validateRuntimeRecoveryEnvironment(env, env.RECOVERY_CANDIDATE_SHA);
  const run = (command, args, options = {}) => execFileSync(command, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  validateRuntimeRecoveryEnvironment(env, head);
  const context = JSON.parse(run('docker', ['context', 'inspect', 'default']))[0];
  assert.equal(context.Endpoints.docker.Host, 'unix:///var/run/docker.sock');
  assert.match(run('pg_dump', ['--version']), /^pg_dump \(PostgreSQL\) 17\./, 'use the PostgreSQL 17 client');
  const token = randomUUID().replaceAll('-', '');
  const label = `dawaee.runtime-recovery=${token}`;
  const network = `dawaee_runtime_${token}`;
  const temporary = mkdtempSync(join(tmpdir(), 'dawaee-runtime-'));
  const worktrees = [];
  const containers = new Set();
  const runtimes = new Set();
  const forwarders = new Set();
  const images = {};
  let networkCreated = false;
  let postgres;

  const inspect = (id) => JSON.parse(run('docker', ['inspect', id]))[0];
  const create = (args) => {
    const id = run('docker', ['create', '--label', label, '--network', network, ...args]).trim();
    assert.match(id, /^[0-9a-f]{64}$/);
    containers.add(id); // remember creation even if start/port binding fails
    run('docker', ['start', id]);
    return id;
  };
  const forward = async (id, targetPort, localPort = 0) => {
    assert.ok(containers.has(id), 'cannot forward an unowned container');
    const attached = inspect(id).NetworkSettings.Networks;
    assert.deepEqual(Object.keys(attached), [network]);
    const target = attached[network].IPAddress;
    // Docker internal networks do not publish ports. The host may reach their
    // private IPs directly; this loopback-only, fixed-target child is the bridge.
    const child = fork(join(ROOT, 'scripts/release-runtime-forwarder.mjs'),
      [target, String(targetPort), String(localPort)], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
        env: { NODE_ENV: 'test', DAWAEE_RUNTIME_FORWARDER: 'owned-ci-fixture' },
      });
    forwarders.add(child);
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1000); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('loopback forwarder did not start')), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`forwarder exited (${code}): ${errors}`)); });
      child.once('message', address => {
        clearTimeout(timer);
        try {
          assert.ok(Number.isInteger(address.port));
          const port = Number(parseRecoveryLoopbackPort(`${address.host}:${address.port}`));
          if (localPort) assert.equal(address.port, localPort);
          resolve(port);
        } catch (error) { reject(error); }
      });
    });
  };
  const cleanup = async () => {
    const failures = [];
    for (const child of forwarders) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('forwarder did not stop')); }, 5000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          child.kill('SIGTERM');
        });
      } catch (error) { failures.push(error); }
    }
    for (const id of [...containers].reverse()) {
      try { run('docker', ['rm', '--force', '--volumes', id]); }
      catch (error) { failures.push(error); }
    }
    if (networkCreated) {
      try { run('docker', ['network', 'rm', network]); }
      catch (error) { failures.push(error); }
    }
    for (const path of worktrees.reverse()) {
      try { run('git', ['worktree', 'remove', path]); }
      catch (error) { failures.push(error); }
    }
    rmSync(temporary, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'runtime rehearsal cleanup failed');
  };
  try {
    // Fetch only the fixed, reviewed sources from this repository. Build
    // each unmodified Dockerfile and lockfile in a detached, temporary worktree.
    run('git', ['fetch', '--no-tags', 'origin', ...Object.values(RECORDED_RUNTIME_SHAS)]);
    for (const [name, sha] of Object.entries({ ...RECORDED_RUNTIME_SHAS, candidate: head })) {
      const path = join(temporary, name);
      run('git', ['worktree', 'add', '--detach', path, sha]);
      worktrees.push(path);
      assert.equal(run('git', ['-C', path, 'rev-parse', 'HEAD']).trim(), sha);
      const tag = `dawaee-runtime-recovery:${token}-${name.toLowerCase()}`;
      console.info(`Building recovery runtime ${name} from ${sha}`);
      run('docker', ['build', '--tag', tag, '--build-arg', `GIT_COMMIT=${sha}`, path],
        { timeout: 900_000, stdio: 'inherit' });
      const info = JSON.parse(run('docker', ['image', 'inspect', tag]))[0];
      assert.equal(info.Config.Labels['org.opencontainers.image.revision'], sha);
      assert.equal(info.Config.User, 'dawaee');
      const migrations = readdirSync(join(path, 'db/migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
      images[name] = { sha, imageId: info.Id, requiredSchema: migrations.at(-1),
        lockfileBlob: run('git', ['rev-parse', `${sha}:package-lock.json`]).trim() };
    }
    run('docker', ['network', 'create', '--internal', '--label', label, network]);
    networkCreated = true;
    assert.equal(JSON.parse(run('docker', ['network', 'inspect', network]))[0].Internal, true);
    postgres = create(['--name', `${network}_postgres`, '--network-alias', 'db',
      '--env', 'POSTGRES_PASSWORD=postgres', 'postgres:17']);
    await forward(postgres, 5432, 5433);
    await until('owned PostgreSQL startup', () => {
      assert.equal(inspect(postgres).State.Running, true, 'owned PostgreSQL exited');
      try { run('docker', ['exec', postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); return true; }
      catch { return false; }
    });
    const databaseEnv = {
      PATH: env.PATH, NODE_ENV: 'test', PGHOST: '127.0.0.1', PGPORT: '5433',
      PGUSER: 'postgres', PGPASSWORD: 'postgres', PGSSLMODE: 'disable', PSQLRC: '/dev/null',
      DAWAEE_MIGRATOR_ROLE: 'dawaee_migrator', DAWAEE_MIGRATOR_PASSWORD: 'migratorpw',
      DAWAEE_APP_PASSWORD: 'devpass', DAWAEE_WORKER_PASSWORD: 'devpass',
    };
    // The listener has just been created and its binding verified. Bootstrap
    // touches only this new container; never an already-running database.
    run('bash', [join(ROOT, 'scripts/db-bootstrap-roles.sh'), 'postgres'], { env: databaseEnv });
    const allowedDatabases = new Set();
    return {
      images, databaseEnv, inspect, cleanup,
      allowDatabases(names) { Object.values(names).forEach(name => allowedDatabases.add(name)); },
      async start(name, database, app, { connectHttp = true } = {}) {
        assert.ok(Object.hasOwn(images, name), 'unbuilt runtime refused');
        assert.ok(allowedDatabases.has(database), 'unowned runtime database');
        assert.ok(['api', 'worker'].includes(app));
        const config = {
          NODE_ENV: 'test', HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'warn', APP: app,
          DATABASE_URL: `postgres://dawaee_app:devpass@db:5432/${database}`,
          WORKER_DATABASE_URL: `postgres://dawaee_worker:devpass@db:5432/${database}`,
          DATABASE_SSL: 'false', WORKER_ENABLED: app === 'worker' ? 'true' : 'false',
          // Run the real initial tick AND hourly housekeeping immediately.
          // The unchanged main loop then waits an hour, allowing a clean stop.
          WORKER_TICK_SECONDS: '3600',
          JWT_SECRET: 'runtime_recovery_synthetic_only_secret_0123456789abcdef',
          IP_HASH_SALT: 'runtime-recovery-synthetic-salt', TRUST_PROXY_HOPS: '0',
          PUSH_PROVIDER: 'mock', OCR_PROVIDER: 'mock', STORAGE_PROVIDER: 'local',
          STORAGE_LOCAL_DIR: '/tmp/recovery-objects', PUBLIC_APP_URL: 'http://127.0.0.1:8080',
        };
        const args = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--tmpfs', '/tmp:rw,nosuid,noexec,size=32m', '--memory', '512m', '--pids-limit', '128'];
        for (const [key, value] of Object.entries(config)) args.push('--env', `${key}=${value}`);
        const id = create([...args, images[name].imageId]);
        runtimes.add(id);
        const state = inspect(id);
        assert.equal(state.Image, images[name].imageId);
        assert.deepEqual(Object.keys(state.NetworkSettings.Networks), [network]);
        let base;
        if (app === 'api' && connectHttp) {
          base = `http://127.0.0.1:${await forward(id, 8080)}`;
        }
        return { id, base, name };
      },
      stop(runtime) {
        assert.ok(runtimes.has(runtime.id));
        run('docker', ['stop', '--time', '10', runtime.id]);
        assert.equal(inspect(runtime.id).State.ExitCode, 0, 'runtime failed to drain on SIGTERM');
      },
      async stopAll() {
        for (const id of runtimes) {
          if (inspect(id).State.Running) run('docker', ['stop', '--time', '10', id]);
        }
      },
      logs(runtime) {
        assert.ok(runtimes.has(runtime.id));
        const result = spawnSync('docker', ['logs', runtime.id], {
          encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, 'could not read owned runtime logs');
        return `${result.stdout}${result.stderr}`;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function apiRequest(runtime, path, { method = 'GET', token, body, status = 200 } = {}) {
  const url = new URL(path, runtime.base);
  assert.equal(url.origin, runtime.base, 'HTTP request left the owned loopback target');
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, status, `${method} ${path}: unexpected HTTP status`);
  return response.json();
}

export async function waitForApi(h, runtime) {
  await until('API startup', async () => {
    assert.equal(h.inspect(runtime.id).State.Running, true, 'API exited before becoming healthy');
    try { return (await apiRequest(runtime, '/health')).status === 'ok'; }
    catch { return false; }
  });
  const version = await apiRequest(runtime, '/version');
  assert.equal(version.commit, h.images[runtime.name].sha);
  assert.equal(version.schema, h.images[runtime.name].requiredSchema);
  const ready = await apiRequest(runtime, '/health/ready');
  assert.equal(ready.checks.schema.ok, true);
  assert.equal(ready.integrations.push, 'mock');
  return version;
}
