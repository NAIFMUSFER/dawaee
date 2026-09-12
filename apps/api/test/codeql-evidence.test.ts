import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('../../../scripts/test-codeql-evidence.cjs') as {
  scenarios: () => Array<{ name: string; run: () => void }>;
};

describe('CodeQL evidence metadata and log privacy', () => {
  for (const scenario of scenarios()) it(scenario.name, scenario.run);
});
