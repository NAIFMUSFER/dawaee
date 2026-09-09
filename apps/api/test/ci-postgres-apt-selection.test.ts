import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('../../../scripts/test-ci-postgres-apt-selection.cjs') as {
  scenarios: (workflowFile: string) => Array<{ name: string; run: () => void }>;
};

describe('real APT source selection for the CI PostgreSQL setup', () => {
  const workflow = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
  for (const scenario of scenarios(workflow)) it(scenario.name, scenario.run);
});
