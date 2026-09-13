import { describe, expect, it } from 'vitest';
import path from 'node:path';

const { createHarness } = require('./profile-screen-harness.cjs') as {
  createHarness: (file: string, hookFile: string, profile?: object, overrides?: object) => any;
};

const screen = path.resolve(process.cwd(), 'apps/mobile/app/settings/emergency.tsx');
const hook = path.resolve(process.cwd(), 'apps/mobile/src/hooks/useRequestScope.ts');

const card = (label: string) => ({
  card: {
    bloodType: 'O+',
    allergies: [`SYNTHETIC-${label}-ALLERGY`],
    conditionsNote: `SYNTHETIC-${label}-CONDITION`,
    emergencyContacts: [{ name: `SYNTHETIC-${label}-CONTACT`, phoneE164: '+966500000000', relation: 'test' }],
    includeMedications: false,
    includeAllergies: true,
    includeContacts: true,
    includeConditions: true,
  },
});

describe('emergency card profile isolation', () => {
  it('does not render patient A emergency data on the first patient B frame', async () => {
    const h = createHarness(screen, hook);
    try {
      const initial = h.requests.find((request: any) => request.method === 'GET' && request.route === '/v1/emergency/card');
      expect(initial).toBeTruthy();
      initial.resolve(card('A'));
      await h.flush();
      expect(h.text()).toContain('SYNTHETIC-A-CONDITION');

      // Inspect the render produced by the profile change before B's passive
      // loading effect runs. Patient A's emergency PHI must disappear in that
      // first frame; a request fence alone cannot erase already-rendered state.
      h.switchProfile('B', false);
      expect(h.app.activeProfile.id).toBe('B');
      expect(h.text()).not.toContain('SYNTHETIC-A-CONDITION');
      expect(h.text()).not.toContain('SYNTHETIC-A-CONTACT');
    } finally {
      h.unmount();
    }
  });
});
