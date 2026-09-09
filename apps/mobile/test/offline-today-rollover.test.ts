import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./offline-today-rollover.cjs') as {
  scenarios: (screenFile: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('offline Today occurrence identity and local-date selection', () => {
  const screen = fileURLToPath(new URL('../app/(tabs)/today.tsx', import.meta.url));
  for (const scenario of scenarios(screen)) it(scenario.name, scenario.run);
});
