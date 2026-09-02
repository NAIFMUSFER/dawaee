import { I18nManager, Platform, StyleSheet } from 'react-native';
import {
  DOSE_STATUS_COLORS, HIGH_CONTRAST_OVERRIDES, PALETTE, RADIUS, SPACING,
  touchTarget, typeSize, type DoseStatus,
} from '@dawaee/shared';

/**
 * The theme is derived from the shared design tokens, so the app and the
 * caregiver portal cannot drift apart, and the contrast audit that runs in CI
 * covers what actually ships here.
 *
 * Elderly mode is a *scale*, not a second theme: one multiplier applied to the
 * type ramp and the touch targets, plus fewer elements per screen. That keeps a
 * single visual language instead of a "normal" app and a "big" app that get
 * out of sync.
 */

export interface ThemeOptions {
  elderlyMode: boolean;
  highContrast: boolean;
  textScale: number;
  isRtl: boolean;
}

export function buildTheme(opts: ThemeOptions) {
  const colors = opts.highContrast ? { ...PALETTE, ...HIGH_CONTRAST_OVERRIDES } : PALETTE;
  const t = (key: Parameters<typeof typeSize>[0]) =>
    typeSize(key, { elderlyMode: opts.elderlyMode, textScale: opts.textScale });

  return {
    colors,
    doseStatus: DOSE_STATUS_COLORS,
    spacing: opts.elderlyMode
      ? { ...SPACING, md: 16, lg: 20, xl: 28, xxl: 40 }
      : SPACING,
    radius: RADIUS,
    isRtl: opts.isRtl,
    elderlyMode: opts.elderlyMode,
    touch: touchTarget(opts.elderlyMode),
    font: {
      display: t('display'), h1: t('h1'), h2: t('h2'), h3: t('h3'),
      bodyLarge: t('bodyLarge'), body: t('body'), bodySmall: t('bodySmall'), caption: t('caption'),
    },
    // Arabic needs a little more line height than Latin at the same size.
    lineHeight: (size: number) => Math.round(size * (opts.isRtl ? 1.6 : 1.45)),
    shadow: Platform.select({
      ios: { shadowColor: '#0B1F1C', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 3 },
      default: { boxShadow: '0 4px 12px rgba(11,31,28,0.08)' },
    }) as object,
    hairline: StyleSheet.hairlineWidth,
  };
}

export type Theme = ReturnType<typeof buildTheme>;

/**
 * Direction-aware helpers.
 *
 * React Native flips `flexDirection: 'row'` automatically under RTL, so the
 * app is authored in logical terms (start/end) rather than left/right. Nothing
 * here "reverses" a layout — that is exactly the fake-RTL the brief warns about.
 */
export const dir = {
  /** Text alignment that follows the writing direction. */
  align: (isRtl: boolean) => (isRtl ? 'right' : 'left') as 'right' | 'left',
  /** The visual side a "back" chevron should point. */
  backIcon: (isRtl: boolean) => (isRtl ? '›' : '‹'),
  forwardIcon: (isRtl: boolean) => (isRtl ? '‹' : '›'),
  /** True when React Native's own RTL flag matches what we want to render. */
  isNativeRtl: () => I18nManager.isRTL,
};

export function statusColors(status: DoseStatus) {
  return DOSE_STATUS_COLORS[status] ?? DOSE_STATUS_COLORS.upcoming;
}
