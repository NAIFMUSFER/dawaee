import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const gate = readFileSync(resolve(ROOT, 'apps/mobile/src/security/AppLockGate.tsx'), 'utf8');

describe('App Lock assistive-technology boundary', () => {
  it('hides the mounted route tree for preview, whole-app and per-area locks', () => {
    expect(gate).toContain(
      "const contentHiddenFromAccessibility = presentationPhase !== 'unlocked' || areaLocked;",
    );
  });

  it('removes locked descendants from Android, iOS and ARIA accessibility trees', () => {
    const wrapperStart = gate.indexOf('aria-hidden={contentHiddenFromAccessibility}');
    const areaOverlay = gate.indexOf('Area gate. Drawn over the screen');
    expect(wrapperStart).toBeGreaterThan(-1);
    expect(areaOverlay).toBeGreaterThan(wrapperStart);

    const wrapper = gate.slice(wrapperStart, areaOverlay);
    expect(wrapper).toContain('accessibilityElementsHidden={contentHiddenFromAccessibility}');
    expect(wrapper).toContain(
      "importantForAccessibility={contentHiddenFromAccessibility ? 'no-hide-descendants' : 'auto'}",
    );
    expect(wrapper).toContain('{children}');
  });

  it('keeps both lock overlays modal to assistive technology', () => {
    expect([...gate.matchAll(/accessibilityViewIsModal/g)]).toHaveLength(2);
  });
});
