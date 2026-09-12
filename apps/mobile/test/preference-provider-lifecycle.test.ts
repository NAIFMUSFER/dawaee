import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./preference-provider-lifecycle.cjs') as {
  scenarios: (store: string, notifications: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('whole provider preference intent and session lifecycle', () => {
  const store = fileURLToPath(new URL('../src/state/app-store.tsx', import.meta.url));
  const notifications = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));
  for (const scenario of scenarios(store, notifications)) it(scenario.name, scenario.run);
});
