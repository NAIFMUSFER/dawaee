import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The schema this build requires, and the refusal to run without it.
 *
 * WHY THIS EXISTS
 *
 * P18 measured what happened when the release candidate was pointed at the
 * schema production actually runs (0019):
 *
 *   process boots            yes
 *   GET /health              200  {"status":"ok"}
 *   GET /health/ready        200  {"status":"ready"}
 *   POST /v1/auth/register   500
 *   POST /v1/auth/login      500, twelve times out of twelve
 *
 * It failed closed — nobody signed in, no limiter was bypassed, nothing was
 * served incorrectly — but nothing NOTICED. `render.yaml` health-checks
 * `/health`, which is liveness only, and `/health/ready` ran `SELECT 1` and
 * asked nothing about the schema. Render would have marked the service live and
 * routed traffic to an API where every authentication request returned 500.
 *
 * WHAT THE CONTRACT IS
 *
 * The migration ledger, not a list of function names. `db/migrations` ships in
 * the image (`COPY db ./db`), so the build carries the exact set of migrations
 * it was written against, checksums included. Every one of them must be present
 * in `schema_migrations` with a matching checksum.
 *
 * That gives the three properties this needs, without a second source of truth
 * to keep in sync:
 *
 *   * behind    — a required migration is absent      -> refuse
 *   * divergent — present but a different checksum    -> refuse
 *   * ahead     — the database has migrations this build does not know about
 *                 -> ALLOWED. It is how a migrate-first deploy works, and P18
 *                    proved the old code keeps serving correctly against the
 *                    newer schema. Refusing here would forbid the only safe
 *                    deploy order.
 */

export class SchemaContractError extends Error {
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];

  constructor(missing: readonly string[], mismatched: readonly string[]) {
    // Filenames only. They are in the repository and in the image; they are not
    // secrets, and naming them is the difference between an operator fixing
    // this in a minute and reading pod logs for an hour.
    const parts: string[] = [];
    if (missing.length) parts.push(`not applied: ${missing.join(', ')}`);
    if (mismatched.length) parts.push(`checksum differs: ${mismatched.join(', ')}`);
    super(`database schema is incompatible with this build (${parts.join('; ')})`);
    this.name = 'SchemaContractError';
    this.missing = missing;
    this.mismatched = mismatched;
  }
}

export class LedgerMissingError extends Error {
  constructor() {
    super('database has no schema_migrations ledger — it has never been migrated');
    this.name = 'LedgerMissingError';
  }
}

let cachedDir: string | null = null;

/**
 * Where `db/migrations` lives, for this process.
 *
 * Walked rather than hard-coded because the layout differs by three levels
 * between the repository (`apps/api/src/lib`), the compiled output
 * (`apps/api/dist/lib`) and the image (`/app/apps/api/dist/lib`, with `db` at
 * `/app/db`). An explicit override exists for anything unusual.
 */
export function migrationsDir(): string {
  if (cachedDir) return cachedDir;
  const override = process.env.DAWAEE_MIGRATIONS_DIR;
  if (override) {
    if (!existsSync(override)) throw new Error(`DAWAEE_MIGRATIONS_DIR does not exist: ${override}`);
    cachedDir = resolve(override);
    return cachedDir;
  }
  let here = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(here, 'db', 'migrations');
    if (existsSync(candidate)) {
      cachedDir = candidate;
      return cachedDir;
    }
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  throw new Error('could not locate db/migrations; set DAWAEE_MIGRATIONS_DIR');
}

export interface RequiredMigration {
  filename: string;
  checksum: string;
}

/**
 * The migrations this build was compiled against.
 *
 * md5, because that is what `scripts/migrate.sh` writes into the ledger. The
 * choice is not a security one — nothing here defends against an attacker who
 * can already write the ledger — it is an equality check against the deploy
 * script, and it has to be the same function the deploy script uses.
 */
export function requiredMigrations(): readonly RequiredMigration[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      checksum: createHash('md5').update(readFileSync(join(dir, filename))).digest('hex'),
    }));
}

/** The highest migration this build knows about, for logging and /version. */
export function requiredSchemaRevision(): string {
  const all = requiredMigrations();
  return all.length ? all[all.length - 1]!.filename : 'none';
}

export interface SchemaCheck {
  ok: boolean;
  required: number;
  applied: number;
  revision: string;
  missing: readonly string[];
  mismatched: readonly string[];
}

type Queryable = { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * Compares the ledger against this build. Throws `LedgerMissingError` when the
 * database has never been migrated, and returns a report otherwise — callers
 * decide whether a bad report is fatal (startup) or a 503 (readiness).
 */
export async function checkSchemaContract(db: Queryable): Promise<SchemaCheck> {
  const present = await db.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) throw new LedgerMissingError();

  const { rows } = await db.query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map<string, string>();
  for (const r of rows) applied.set(String(r.filename), String(r.checksum));

  const missing: string[] = [];
  const mismatched: string[] = [];
  const required = requiredMigrations();
  for (const m of required) {
    const got = applied.get(m.filename);
    if (got === undefined) missing.push(m.filename);
    else if (got !== m.checksum) mismatched.push(m.filename);
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    required: required.length,
    applied: applied.size,
    revision: requiredSchemaRevision(),
    missing,
    mismatched,
  };
}

export interface AssertOptions {
  /** Connection attempts before giving up. A deploy should tolerate a database
   *  that is a few seconds behind the service, and nothing more. */
  attempts?: number;
  delayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Startup gate. Refuses to return unless the schema satisfies the contract.
 *
 * A database that is unreachable is retried, because a deploy legitimately
 * races the database coming back; a database that is reachable and behind is
 * NOT retried, because waiting cannot fix it and a slow failure is worse than
 * a fast one.
 */
export async function assertSchemaContract(db: Queryable, opts: AssertOptions = {}): Promise<SchemaCheck> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 2000;

  let lastError: Error | null = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const check = await checkSchemaContract(db);
      if (!check.ok) throw new SchemaContractError(check.missing, check.mismatched);
      return check;
    } catch (err) {
      // A schema verdict is final. Only a failure to reach the database is
      // worth another go.
      if (err instanceof SchemaContractError || err instanceof LedgerMissingError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i === attempts) break;
      opts.onRetry?.(i, lastError);
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error('could not verify the database schema');
}
