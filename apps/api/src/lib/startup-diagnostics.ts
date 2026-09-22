import { serializeLoggedError } from '@dawaee/shared';
import { DatabaseTlsMisconfigured } from './db-tls.js';
import {
  LedgerMissingError, SchemaContractError, requiredMigrations, requiredSchemaRevision,
} from './schema-contract.js';

/** Startup has no logger yet. Only fixed diagnostics and repository-owned
 * migration names may accompany the structured error category. */
export function logStartupFailure(err: unknown): void {
  console.error({ err: serializeLoggedError(err) }, 'fatal startup error');
  if (err instanceof SchemaContractError || err instanceof LedgerMissingError) {
    const known = new Set(requiredMigrations().map(m => m.filename));
    const safeNames = (names: readonly string[]) => names.filter(name => known.has(name));
    console.error(err instanceof SchemaContractError
      ? { missing: safeNames(err.missing), mismatched: safeNames(err.mismatched) }
      : { ledgerMissing: true }, 'database schema is incompatible with this build');
    console.error(
      `this build requires the database to be migrated to ${requiredSchemaRevision()}; ` +
      'run scripts/migrate.sh before starting the API',
    );
  }
  if (err instanceof DatabaseTlsMisconfigured) {
    console.error('database certificate verification configuration is invalid');
  }
}
