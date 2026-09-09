import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./preference-scope-races.cjs') as {
  scenarios: (appStore: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('preference scope and stale-response boundaries', () => {
  const appStore = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
  for (const scenario of scenarios(appStore)) it(scenario.name, scenario.run);
});
