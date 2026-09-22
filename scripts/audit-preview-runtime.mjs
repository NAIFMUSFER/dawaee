import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The isolated preview shares one free instance, not a production topology.
 * Stop the pair if either child exits; a surviving API must not hide a dead
 * worker. During a platform shutdown, allow in-flight work to drain, then kill
 * any remaining child before the platform's own shutdown deadline.
 */
export function supervisePreview(runtime, {
  spawnProcess = spawn, signals = process, shutdownMs = 20_000,
} = {}) {
  return new Promise((resolveDone) => {
    const children = new Set();
    let stopping = false;
    let failed = false;
    let started = false;
    let timer;
    const finish = () => {
      if (!started || children.size) return;
      clearTimeout(timer);
      signals.off('SIGTERM', terminate);
      signals.off('SIGINT', interrupt);
      resolveDone(failed ? 1 : 0);
    };
    const stop = (signal = 'SIGTERM', failure = false) => {
      failed ||= failure;
      if (!stopping) {
        stopping = true;
        for (const child of children) child.kill(signal);
        if (children.size) timer = setTimeout(() => {
          failed = true;
          for (const child of children) child.kill('SIGKILL');
        }, shutdownMs);
      }
      finish();
    };
    const terminate = () => stop('SIGTERM');
    const interrupt = () => stop('SIGINT');
    signals.once('SIGTERM', terminate);
    signals.once('SIGINT', interrupt);
    for (const kind of ['worker', 'api']) {
      if (stopping) break;
      try {
        const child = spawnProcess(process.execPath, [`apps/${kind}/dist/index.js`], {
          cwd: ROOT, env: runtime[kind], stdio: 'inherit',
        });
        children.add(child);
        child.once('error', () => stop('SIGTERM', true));
        child.once('close', (code) => {
          children.delete(child);
          stop('SIGTERM', !stopping || (code !== null && code !== 0));
        });
      } catch {
        stop('SIGTERM', true);
      }
    }
    started = true;
    finish();
  });
}
