import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P16 — the gate that keeps the other gates.
 *
 * Every phase from P1 to P15 fixed something and left a test behind to hold it.
 * The failure mode this file exists for is the quiet one: a refactor deletes a
 * suite, or renames the test that was the whole point of it, and CI stays green
 * because nothing was ever asserted about what CI must contain. A security
 * control with no test is indistinguishable from one that was never written.
 *
 * So this asserts the shape of the release itself — which suites exist, which
 * named behaviours they still cover, and which configuration invariants the
 * mobile and deployment surfaces still hold. It is deliberately about
 * ARTEFACTS, not behaviour: the behaviour is tested where it lives, and this
 * checks that the place it lives still exists.
 *
 * The one thing it must not become is a test that passes by matching source
 * strings for behaviour it could have run instead. Where a property is
 * executable it is executed elsewhere and named here; where it is a fact about
 * a config file — `allowBackup`, a Dockerfile stage, a workflow permission —
 * reading the file IS the measurement, because the file is the artefact that
 * ships.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * The tests vitest would actually run, as `file > suite > test` lines.
 *
 * `vitest list` rather than a scan of source: a test that is commented out,
 * `.skip`-ped, or sitting in a file no include glob reaches does not appear
 * here, and each of those is a way a control can be lost while the source
 * still looks like it covers it.
 */
let collectedCache: string[] | null = null;
function collected(): string[] {
  if (collectedCache) return collectedCache;
  const out = execFileSync('npx', ['vitest', 'list'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  collectedCache = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return collectedCache;
}

/**
 * Converts a vitest include glob into a regex over repo-relative paths.
 *
 * One pass, not three. Replacing a doublestar-slash token and then `*` in sequence rewrites the
 * quantifier inside the replacement text that the first pass just emitted —
 * `(?:[^/]+/)*` becomes `(?:[^/]+/)[^/]*` — which silently narrows every glob
 * to "exactly one intermediate directory" and made this check claim the mobile
 * suites were unreachable when they were not.
 */
function globToRegex(glob: string): RegExp {
  const body = glob.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\]/g, (token) => {
    if (token === '**/') return '(?:[^/]+/)*';
    if (token === '**') return '.*';
    if (token === '*') return '[^/]*';
    return `\\${token}`;
  });
  return new RegExp(`^${body}$`);
}

// ---------------------------------------------------------------------------

/**
 * Every suite that must survive a refactor, and the phase that put it there.
 *
 * A file listed here going missing is a release blocker, not a merge conflict
 * to resolve by deletion.
 */
const REQUIRED_SUITES: Array<[phase: string, file: string]> = [
  ['P5 identity enumeration', 'apps/api/test/identity-enumeration.test.ts'],
  ['P6 OTP security', 'apps/api/test/otp-security.test.ts'],
  ['P7 shared rate limit', 'apps/api/test/shared-rate-limit.test.ts'],
  ['P8 privilege boundary', 'apps/api/test/privilege-boundary.test.ts'],
  ['P8 RLS matrix', 'apps/api/test/rls-matrix.test.ts'],
  ['P9 auth sessions', 'apps/api/test/auth-session.test.ts'],
  ['P9 password auth', 'apps/api/test/password-auth.test.ts'],
  ['P10 worker reliability', 'apps/api/test/worker-reliability.test.ts'],
  ['P11 upload and emergency', 'apps/api/test/upload-emergency-security.test.ts'],
  ['P11 notification privacy', 'apps/api/test/notification-privacy.test.ts'],
  ['P12 endpoint authorization', 'apps/api/test/endpoint-authorization.test.ts'],
  ['P13 log redaction', 'apps/api/test/log-redaction.test.ts'],
  ['P13 operational error privacy', 'apps/api/test/operational-error-privacy.test.ts'],
  ['P13 audit privacy', 'apps/api/test/audit-privacy.test.ts'],
  ['P18-R definer privilege model', 'apps/api/test/definer-privilege-model.test.ts'],
  ['P18-R schema startup contract', 'apps/api/test/schema-contract.test.ts'],
  ['P4 database TLS', 'apps/api/test/db-tls.test.ts'],
  ['P1-P3 mobile token store', 'apps/mobile/test/token-store.test.ts'],
  ['P1-P3 mobile secure cache', 'apps/mobile/test/secure-cache.test.ts'],
  ['P1-P3 mobile app lock', 'apps/mobile/test/app-lock.test.ts'],
  ['P9 mobile refresh single flight', 'apps/mobile/test/refresh-single-flight.test.ts'],
];

describe('P16-1 every security suite is still in the tree', () => {
  it('none of them has been deleted', () => {
    const missing = REQUIRED_SUITES
      .filter(([, file]) => !existsSync(resolve(ROOT, file)))
      .map(([phase, file]) => `${phase}: ${file}`);
    expect(missing, 'a security suite from a completed phase is gone').toEqual([]);
  });

  it('and vitest actually collects each of them', () => {
    // Existence is not enough — a file outside the include globs never runs.
    const config = read('vitest.config.ts');
    // The `include:` array only. `exclude:` also holds globs, and treating
    // them as coverage would let a suite sitting in an excluded path pass.
    const includeBlock = config.match(/include:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const globs = [...includeBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(globs.length, 'no include globs found in vitest.config.ts').toBeGreaterThan(0);

    const uncovered = REQUIRED_SUITES
      .filter(([, file]) => !globs.some((g) => globToRegex(g).test(file)))
      .map(([phase]) => phase);
    expect(uncovered, 'these suites exist but no include glob reaches them').toEqual([]);
  });

  /**
   * The count is deliberately a floor rather than an equality. Adding tests
   * must never fail this; losing a third of them must.
   */
  it('and the suite as a whole has not collapsed', () => {
    const n = collected().length;
    expect(n, `only ${n} tests are collected`).toBeGreaterThanOrEqual(800);
  }, 320_000);
});

// ---------------------------------------------------------------------------

/**
 * Named behaviours that must still be covered somewhere.
 *
 * Each entry is a phrase from a test title. Renaming a test freely is fine;
 * deleting the only test of a release-critical property is not, and this is
 * what turns that from a silent loss into a failed build.
 *
 * Matched against vitest's own collected test names, not against source text,
 * so a commented-out or skipped test does not satisfy it.
 */
const REQUIRED_BEHAVIOURS: Array<[phase: string, needle: RegExp]> = [
  ['P8 RLS: cross-patient read', /Patient A supplies Patient B ids directly/i],
  ['P8 worker least privilege', /worker role is scoped to what a worker needs/i],
  ['P9 refresh single winner', /rotat|single|winner|superseded/i],
  ['P9 disabled account', /disabl/i],
  ['P12 BOLA matrix', /Patient A holding Patient B/i],
  ['P12 admin authorization', /admin routes are not reachable/i],
  ['P12 caregiver permission ceiling', /caregiver cannot exceed the permissions granted/i],
  ['P13 log redaction', /neither logger writes what the policy forbids/i],
  ['P13 operational error privacy', /job_runs.*carries none of them/i],
  ['P13 audit integrity', /audit trail cannot be rewritten or misattributed/i],
  ['P1-P3 mobile token storage', /token/i],
];

describe('P16-2 the named release-critical behaviours are still tested', () => {
  it('each one appears among the tests vitest collects', () => {
    const names = collected().join('\n');
    const lost = REQUIRED_BEHAVIOURS
      .filter(([, needle]) => !needle.test(names))
      .map(([phase]) => phase);
    expect(lost, 'these properties are no longer covered by any collected test').toEqual([]);
  }, 320_000);
});

// ---------------------------------------------------------------------------

describe('P16-3 the mobile security posture is still declared', () => {
  const appJson = JSON.parse(read('apps/mobile/app.json')) as {
    expo: { android?: Record<string, unknown>; ios?: Record<string, unknown>; plugins?: unknown[] };
  };

  it('android backups stay off, so an adb backup cannot lift the token store', () => {
    expect(appJson.expo.android?.allowBackup).toBe(false);
  });

  it('the app does not ask for permissions it has no reason to hold', () => {
    const granted = (appJson.expo.android?.permissions ?? []) as string[];
    // Nothing here reads contacts, location, SMS or the call log, and a
    // medication reminder that asked for them would be a finding on its own.
    for (const forbidden of [
      'READ_CONTACTS', 'WRITE_CONTACTS', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION',
      'READ_SMS', 'RECEIVE_SMS', 'READ_CALL_LOG', 'READ_PHONE_STATE', 'READ_EXTERNAL_STORAGE',
    ]) {
      expect(granted, `the app requests ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('secure storage is a dependency, and no plaintext store has replaced it', () => {
    const pkg = JSON.parse(read('apps/mobile/package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toContain('expo-secure-store');
    expect(Object.keys(pkg.dependencies)).toContain('expo-local-authentication');
    // The AEAD used by the encrypted cache. Its removal would mean the cache
    // stopped being authenticated encryption.
    expect(Object.keys(pkg.dependencies)).toContain('@noble/ciphers');
  });

  it('no analytics or crash-reporting SDK has been added', () => {
    // P13 measured the mobile app as having no telemetry sink at all, which is
    // what makes "no PHI leaves the device in a crash report" true. A new
    // dependency here would silently end that.
    const pkg = JSON.parse(read('apps/mobile/package.json')) as {
      dependencies: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ').toLowerCase();
    for (const sdk of ['sentry', 'crashlytics', 'bugsnag', 'datadog', 'amplitude', 'mixpanel', 'segment', 'posthog']) {
      expect(all, `a telemetry SDK (${sdk}) was added to the mobile app`).not.toContain(sdk);
    }
  });

  it('and no console logging has been reintroduced into mobile source', () => {
    // Measured in P13 as zero. This is the artefact check that keeps it there:
    // a console.log in a screen that renders a dose is a medication name on a
    // device log that any installed app with READ_LOGS could once read.
    const out = execFileSync('bash', ['-lc',
      `grep -rn --include='*.ts' --include='*.tsx' -E '(^|[^.\\w])console\\.(log|warn|error|info|debug|trace)\\(' ` +
      `apps/mobile/src apps/mobile/app 2>/dev/null | grep -v node_modules || true`,
    ], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(out, 'console logging found in mobile source').toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('P16-4 the deployment artefacts still say what P15 established', () => {
  const dockerfile = read('Dockerfile');
  const renderYaml = read('render.yaml');

  it('the production image runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER\s+(?!root|0\b)/m);
  });

  it('node is PID 1, so SIGTERM reaches the process that has to handle it', () => {
    // exec form, not shell form: `CMD node …` under a shell makes the shell
    // PID 1 and Render's SIGTERM never reaches node, so in-flight work is
    // killed rather than drained.
    const entry = dockerfile.match(/^(?:CMD|ENTRYPOINT)\s+(.+)$/m)?.[1] ?? '';
    expect(entry, `entrypoint is not exec form: ${entry}`).toMatch(/^\[/);
  });

  it('the image has a runtime stage separate from the build stage', () => {
    expect(dockerfile).toMatch(/AS\s+runtime/i);
    expect(dockerfile.match(/^FROM /gm)?.length ?? 0).toBeGreaterThan(1);
  });

  it('secrets are never baked into the image', () => {
    // A production secret in a layer is in the registry forever, readable by
    // anyone who can pull the image.
    for (const secret of ['JWT_SECRET', 'DATABASE_URL', 'GOOGLE_VISION_API_KEY', 'EXPO_ACCESS_TOKEN']) {
      expect(dockerfile, `${secret} appears in the Dockerfile`)
        .not.toMatch(new RegExp(`(ARG|ENV)\\s+${secret}`));
    }
  });

  it('the build context excludes what must never ship', () => {
    const ignore = read('.dockerignore');
    for (const entry of ['.env', 'node_modules', 'apps/mobile']) {
      expect(ignore, `.dockerignore does not exclude ${entry}`).toContain(entry);
    }
  });

  it('TLS verification is asserted in the blueprint, not left to a default', () => {
    // `no-verify` accepts any certificate from anyone, so whatever can answer
    // for the database host reads and rewrites every query.
    // Both services declare it, and both declare it as the literal "true".
    // A long explanatory comment sits between the key and its value, so this
    // matches the block rather than a fixed window.
    const blocks = renderYaml.match(/key:\s*DATABASE_SSL[\s\S]*?value:\s*\S+/g) ?? [];
    expect(blocks.length, 'DATABASE_SSL is not declared once per service').toBe(2);
    for (const block of blocks) expect(block).toMatch(/value:\s*"true"$/);
    expect(renderYaml, 'a value of no-verify appears in the blueprint')
      .not.toMatch(/value:\s*"?no-verify/);
  });

  it('every credential in the blueprint is supplied per environment, never committed', () => {
    // A literal value for any of these would put a production secret in git.
    for (const key of [
      'DATABASE_URL', 'JWT_SECRET', 'IP_HASH_SALT', 'DATABASE_ROLE_PASSWORD',
      'DAWAEE_WORKER_PASSWORD', 'GOOGLE_VISION_API_KEY', 'STORAGE_SECRET_ACCESS_KEY',
      'EXPO_ACCESS_TOKEN', 'AZURE_DI_KEY',
    ]) {
      const block = renderYaml.match(new RegExp(`key:\\s*${key}\\b[\\s\\S]{0,400}?(?=\\n      - key:|\\n  - type:|$)`, 'g')) ?? [];
      expect(block.length, `${key} is not declared in render.yaml`).toBeGreaterThan(0);
      for (const b of block) {
        expect(b, `${key} carries a literal value in render.yaml`).toMatch(/sync:\s*false/);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('P16-5 a running service can say which commit it is', () => {
  // The over-HTTP half of this lives in endpoint-authorization.test.ts, which
  // already owns a harness. Starting a second one here made the whole run
  // flaky: measured, two full runs were stable without this file and a
  // worker-reliability hook timed out at 60s with it. A release gate that
  // destabilises the suite it is meant to protect is not a gate.

  it('reports what the build passed, and admits it when nothing was passed', async () => {
    const { buildIdentity } = await import('../src/routes/health.js');
    const saved = { ...process.env };
    try {
      delete process.env.GIT_COMMIT; delete process.env.RENDER_GIT_COMMIT;
      delete process.env.APP_VERSION; delete process.env.BUILD_TIME;
      expect(buildIdentity()).toMatchObject({ commit: 'unknown', version: 'unknown', builtAt: 'unknown' });
      // The schema revision comes from the shipped migrations, not the
      // environment, so it is known even when nothing was passed to the build.
      expect(buildIdentity().schema).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);

      // Render sets RENDER_GIT_COMMIT itself, from the commit it built. P18
      // found /version would say `unknown` in production because render.yaml
      // passes no build arguments; the platform's own value takes precedence
      // precisely so nobody has to maintain one by hand.
      process.env.RENDER_GIT_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
      process.env.GIT_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      expect(buildIdentity().commit).toBe('fedcba9876543210fedcba9876543210fedcba98');

      // A malformed platform value must not shadow a good build argument.
      process.env.RENDER_GIT_COMMIT = 'not-a-sha';
      expect(buildIdentity().commit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
      delete process.env.RENDER_GIT_COMMIT;

      process.env.GIT_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      process.env.APP_VERSION = '0.1.0';
      process.env.BUILD_TIME = '2026-09-06T09:00:00Z';
      expect(buildIdentity().commit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
      expect(buildIdentity().version).toBe('0.1.0');

      // A malformed value is rejected rather than echoed. A version endpoint
      // that repeats whatever it was handed is an unauthenticated reflector.
      process.env.GIT_COMMIT = '<script>alert(1)</script>';
      expect(buildIdentity().commit).toBe('unknown');
      process.env.GIT_COMMIT = 'refs/heads/main';
      expect(buildIdentity().commit).toBe('unknown');
    } finally {
      process.env = saved;
    }
  });

  it('discloses nothing about the environment it runs in', async () => {
    const { buildIdentity } = await import('../src/routes/health.js');
    const saved = { ...process.env };
    try {
      process.env.GIT_COMMIT = 'a1b2c3d4e5f6';
      const body = JSON.stringify({ service: 'dawaee-api', ...buildIdentity() });
      // Nothing here may vary with configuration: the endpoint is public.
      for (const leak of ['DATABASE', 'JWT', 'SECRET', 'postgres://', 'node_modules', '/app/']) {
        expect(body, `/version disclosed ${leak}`).not.toContain(leak);
      }
    } finally {
      process.env = saved;
    }
  });

  /**
   * The schema startup contract reads `db/migrations` out of the image to know
   * which migrations this build requires. If the Dockerfile ever stops shipping
   * that directory, the API refuses to start — with an error about a missing
   * directory rather than a missing migration, which is a much worse deploy to
   * debug at 3am. Cheap to assert, expensive to discover.
   */
  it('the image still ships db/migrations, which the startup gate reads', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile, 'the runtime stage no longer copies db/').toMatch(/^COPY db \.\/db$/m);
  });

  it('the Dockerfile freezes the identity into the image rather than reading it at runtime', () => {
    const dockerfile = read('Dockerfile');
    // ARG + ENV in the runtime stage: the value describes the artefact, not
    // whatever the platform was configured with afterwards.
    expect(dockerfile).toMatch(/ARG\s+GIT_COMMIT=unknown/);
    expect(dockerfile).toMatch(/ENV\s+GIT_COMMIT=\$GIT_COMMIT/);
    // And it is also a standard OCI label, so `docker inspect` answers the
    // same question without starting the container.
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.revision/);
  });
});

// ---------------------------------------------------------------------------

/**
 * P16-6 — the CI configuration itself.
 *
 * These read YAML rather than run it, and that is the honest limit: they prove
 * what the workflow SAYS, not that GitHub executed it. The execution evidence
 * is a workflow run, which this audit cannot produce from a sandbox with no
 * egress to GitHub — recorded as NOT RUN.
 *
 * What they are for is the regression direction. Every property below was
 * decided for a reason during this audit, and each is one careless edit from
 * being undone: a `permissions: write-all` added to fix a token error, a
 * Postgres version dropped back to 16 to make a matrix faster, a `|| true`
 * appended to a red security step on a Friday. A test is the only thing that
 * makes those edits argue with someone.
 */
describe('P16-6 the CI configuration keeps its security properties', () => {
  const workflows = ['.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/workflows/security-schedule.yml'];
  const yaml = Object.fromEntries(workflows.map((f) => [f, read(f)]));

  it('every workflow exists and declares a default permission', () => {
    for (const [file, text] of Object.entries(yaml)) {
      expect(text, `${file} has no top-level permissions block`).toMatch(/^permissions:/m);
      expect(text, `${file} grants blanket write`).not.toMatch(/permissions:\s*write-all/);
    }
  });

  it('no workflow grants a write scope it does not need', () => {
    for (const [file, text] of Object.entries(yaml)) {
      // `security-events: write` is required to upload SARIF and is the only
      // write scope anything here should hold.
      const writes = [...text.matchAll(/^\s+([a-z-]+):\s*write\s*$/gm)].map((m) => m[1]);
      const unexpected = writes.filter((w) => w !== 'security-events');
      expect(unexpected, `${file} grants write on: ${unexpected.join(', ')}`).toEqual([]);
    }
  });

  it('CI runs against the PostgreSQL major version production uses', () => {
    // Supabase runs 17. CI ran only 16 until P16, which meant every security
    // property the suite proves was proven against a version the patients'
    // data does not live on.
    expect(yaml['.github/workflows/ci.yml']).toMatch(/postgres:\s*\[[^\]]*'17'/);
  });

  it('the security-critical steps are not neutered', () => {
    for (const [file, text] of Object.entries(yaml)) {
      // Only two forms of "do not fail" are permitted, and each must sit
      // beside the word `informational` so the exemption is deliberate.
      for (const line of text.split('\n')) {
        if (!/continue-on-error:\s*true/.test(line)) continue;
        const idx = text.indexOf(line);
        const context = text.slice(Math.max(0, idx - 600), idx + 200);
        expect(context.toLowerCase(), `${file}: continue-on-error without an informational label`)
          .toContain('informational');
      }
    }
  });

  it('the blocking gates are actually invoked', () => {
    const ci = yaml['.github/workflows/ci.yml'];
    for (const gate of ['npm ci', 'npx eslint .', 'npm run typecheck', 'npm test', 'rls_probe.sql',
      'scripts/migrate.sh', 'audit-gate.mjs', 'container-checks.sh']) {
      expect(ci, `CI no longer runs ${gate}`).toContain(gate);
    }
  });

  it('the pipeline never uses pull_request_target', () => {
    // `pull_request_target` runs with the base repository's secrets while
    // checking out the fork's code. Combined with any checkout of the PR head
    // it hands a stranger the repository's tokens.
    for (const [file, text] of Object.entries(yaml)) {
      expect(text, `${file} uses pull_request_target`).not.toContain('pull_request_target');
    }
  });

  it('no untrusted GitHub context is interpolated into a shell command', () => {
    // A branch name or PR title is attacker-controlled text. Inside `run:` it
    // is attacker-controlled shell.
    for (const [file, text] of Object.entries(yaml)) {
      const runBlocks = [...text.matchAll(/run:\s*\|?\s*\n((?:[ \t]+.*\n)+)/g)].map((m) => m[1]!);
      for (const block of runBlocks) {
        expect(block, `${file}: untrusted context inside a run: block`)
          .not.toMatch(/\$\{\{\s*(github\.event\.|github\.head_ref|inputs\.)/);
      }
    }
  });

  it('the Node version is a line, not a frozen patch', () => {
    // An exact patch is reproducible and wrong: it freezes CI on whatever
    // patch was current, including past the release that fixes a CVE in it.
    const nvmrc = read('.nvmrc').trim();
    expect(nvmrc, `.nvmrc pins an exact patch (${nvmrc})`).toMatch(/^\d+$/);
    expect(yaml['.github/workflows/ci.yml']).toContain('node-version-file: .nvmrc');
  });

  it('the dependency gate is the real one, not npm audit with a shrug', () => {
    const all = Object.values(yaml).join('\n');
    expect(all, 'a security command is suppressed with || true').not.toMatch(/npm audit[^\n]*\|\|\s*true/);
    expect(all).toContain('audit-gate.mjs');
  });
});
