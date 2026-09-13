import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scenarios } = require('./notification-caller-intent.cjs') as {
  scenarios: (notifications: string, today: string, hook: string) => Array<{ name: string; run: () => Promise<void> }>;
};

describe('notification intent across cached rebuild and Today callers', () => {
  const notifications = fileURLToPath(new URL('../src/notifications/index.ts', import.meta.url));
  const today = fileURLToPath(new URL('../app/(tabs)/today.tsx', import.meta.url));
  const hook = fileURLToPath(new URL('../src/hooks/useRequestScope.ts', import.meta.url));
  for (const scenario of scenarios(notifications, today, hook)) it(scenario.name, scenario.run);
});
