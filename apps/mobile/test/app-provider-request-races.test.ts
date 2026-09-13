import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./app-provider-request-races.cjs') as {
  scenarios: (file: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('AppProvider read and sync request ownership', () => {
  const file = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
  for (const scenario of scenarios(file)) it(scenario.name, scenario.run);
});
