import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./today-owner-permissions.cjs') as {
  scenarios: (today: string, hook: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('Today honors owned dependent access without patient-local reminders', () => {
  const today = fileURLToPath(new URL('../app/(tabs)/today.tsx', import.meta.url));
  const hook = fileURLToPath(new URL('../src/hooks/useRequestScope.ts', import.meta.url));
  for (const scenario of scenarios(today, hook)) it(scenario.name, scenario.run);
});
