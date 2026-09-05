import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The worker must outlive a database outage.
 *
 * It did not. The tick interval was unref'd and a never-settling promise stood
 * in as the keep-alive, which is not a handle — so the only thing holding the
 * event loop open was whatever sockets the database pool happened to have. With
 * the database reachable that is invisible. With it unreachable the pool holds
 * nothing, the event loop empties, and the process exits ZERO: no error, no
 * stack, indistinguishable from a clean shutdown. Reminders stop and the logs
 * say nothing is wrong.
 *
 * So the assertion is specifically about the unreachable-database case, because
 * the healthy case passed throughout the entire time the bug existed.
 */
const ROOT = resolve(import.meta.dirname, '../../..');

function runWorker(databaseUrl: string, ms: number): Promise<number | null> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, ['apps/worker/dist/index.js'], {
      cwd: ROOT,
      stdio: 'ignore',
      // Deliberately NOT `...process.env`. This test is about which handles
      // hold the event loop open, and an inherited variable can add one — with
      // the bug reintroduced and the parent's environment spread in here, this
      // test passed. An explicit, minimal environment is the only way it
      // measures what it claims to.
      //
      // WORKER_ENABLED matters for the opposite reason: the suite's setup file
      // sets it to 'false' so that importing the worker never starts one, and
      // this test runs the real entry point, so it must opt back in — otherwise
      // the child exits having done nothing and the assertion passes wrongly.
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'development',
        WORKER_ENABLED: 'true',
        LOG_LEVEL: 'silent',
        WORKER_TICK_SECONDS: '1',
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: 'false',
        JWT_SECRET: 'x'.repeat(64),
        IP_HASH_SALT: 'not-the-dev-salt',
      },
    });

    let exitCode: number | null = null;
    child.on('exit', (code) => { exitCode = code; });
    setTimeout(() => {
      const seen = exitCode;
      child.kill('SIGKILL');
      resolveExit(seen);
    }, ms);
  });
}

describe('worker liveness', () => {
  it('keeps running when the database cannot be reached', async () => {
    // Port 5499 has nothing on it, so every tick fails to connect.
    const exit = await runWorker('postgres://nobody:nope@127.0.0.1:5499/nothing', 12_000);
    expect(exit, 'the worker exited instead of retrying').toBeNull();
  }, 30_000);
});
