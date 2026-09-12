import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./notification-schedule-races.cjs') as {
  scenarios: (file: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('native notification mutation ordering', () => {
  const file = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));
  for (const scenario of scenarios(file)) it(scenario.name, scenario.run);
});
