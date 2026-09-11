import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./capture-upload-finalization.cjs') as {
  scenarios: () => Array<{ name: string; run: () => Promise<void> }>;
};

describe('capture waits for verified upload finalization', () => {
  for (const scenario of scenarios()) it(scenario.name, scenario.run);
});
