import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const { scenarios } = createRequire(import.meta.url)('./notification-action-persistence.cjs') as {
  scenarios: () => Array<{ name: string; run: () => Promise<void> }>;
};

describe('notification action persistence and listener failure isolation', () => {
  for (const scenario of scenarios()) it(scenario.name, scenario.run);
});
