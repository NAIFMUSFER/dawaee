import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./profile-screen-scenarios.cjs') as {
  scenarios: (directory: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('profile-scoped screen request boundaries', () => {
  const screens = fileURLToPath(new URL('../app/(tabs)/', import.meta.url));
  for (const scenario of scenarios(screens)) it(scenario.name, scenario.run);
});
