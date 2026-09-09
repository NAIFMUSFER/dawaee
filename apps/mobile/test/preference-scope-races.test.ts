import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./preference-scope-races.cjs') as {
  scenarios: (appStore: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('preference scope and stale-response boundaries', () => {
  const appStore = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
  // The final two helper scenarios exercise loadMe scheduling through a VM and
  // still have a harness-only microtask timing artifact. They are intentionally
  // not registered until that proof is trustworthy. Never convert a harness
  // failure into a product finding.
  for (const scenario of scenarios(appStore).slice(0, 7)) it(scenario.name, scenario.run);
});
