import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** The endpoint inventory must observe the complete production route surface,
 * even on a clean checkout where generated public assets are absent. This runs
 * before test workers start, not in a later test file whose ordering may vary.
 * Build failures abort the run; a stale bundle must not mask a broken build. */
export default function prepareWebTestBundle(): void {
  execFileSync('bash', [join(ROOT, 'scripts/build-web.sh')], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 120_000,
    env: { ...process.env, EXPO_PUBLIC_API_URL: 'https://dawaee.example.com' },
  });
}
