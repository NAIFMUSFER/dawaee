import { describe, expect, it } from 'vitest';
import {
  contrastRatio, ELDERLY_TYPE_MULTIPLIER, PAIRS_TO_AUDIT, TOUCH_TARGET, touchTarget, typeSize,
} from '../src/design.js';

describe('WCAG 2.1 AA contrast', () => {
  for (const pair of PAIRS_TO_AUDIT) {
    const required = pair.large ? 3 : 4.5;
    it(`${pair.name} meets ${required}:1`, () => {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(ratio, `${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(required);
    });
  }

  it('computes known ratios correctly', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('touch targets', () => {
  it('exceeds the WCAG 2.5.5 minimum of 44px everywhere', () => {
    expect(TOUCH_TARGET.min).toBeGreaterThanOrEqual(44);
    expect(touchTarget(false)).toBeGreaterThanOrEqual(44);
  });
  it('is substantially larger in elderly mode', () => {
    expect(touchTarget(true)).toBeGreaterThan(touchTarget(false));
    expect(touchTarget(true)).toBeGreaterThanOrEqual(72);
  });
});

describe('type scale', () => {
  it('scales up in elderly mode', () => {
    expect(typeSize('body', { elderlyMode: true })).toBe(Math.round(16 * ELDERLY_TYPE_MULTIPLIER));
    expect(typeSize('body')).toBe(16);
  });
  it('compounds with the user text-size setting', () => {
    expect(typeSize('body', { elderlyMode: true, textScale: 1.2 })).toBe(Math.round(16 * 1.35 * 1.2));
  });
  it('keeps elderly body text at or above 20pt', () => {
    expect(typeSize('body', { elderlyMode: true })).toBeGreaterThanOrEqual(20);
  });
});
