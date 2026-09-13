import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./privacy-consent-mutation-scope.cjs') as {
  scenarios: (screen: string, hook: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('privacy consent mutation lifetime and pending-state isolation', () => {
  const screen = fileURLToPath(new URL('../app/settings/privacy.tsx', import.meta.url));
  const hook = fileURLToPath(new URL('../src/hooks/useRequestScope.ts', import.meta.url));
  for (const scenario of scenarios(screen, hook)) it(scenario.name, scenario.run);
});
