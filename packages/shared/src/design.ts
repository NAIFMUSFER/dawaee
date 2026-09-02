/**
 * Design tokens shared by the mobile app and the caregiver portal.
 *
 * Contrast note: every foreground/background pair listed in `PAIRS_TO_AUDIT`
 * is checked against WCAG 2.1 AA (4.5:1 body, 3:1 large text and UI) by
 * `design.test.ts`, so a token change that breaks contrast fails CI.
 */

export const PALETTE = {
  // Calm clinical teal — reads as "care", not "alarm".
  primary900: '#062F2B',
  primary700: '#0B5F56',
  primary600: '#0E7A6E',
  primary500: '#12988A',
  primary200: '#9FDCD3',
  primary100: '#D6F1EC',
  primary50: '#EFFAF8',

  // Status
  success700: '#186A3B',
  success500: '#22A45D',
  success100: '#DFF5E8',
  warning700: '#8A5200',
  warning500: '#C77700',
  warning100: '#FEF0DA',
  danger700: '#8E1B1B',
  danger500: '#C62828',
  danger100: '#FBE3E3',
  info700: '#1A4F87',
  info500: '#2270BE',
  info100: '#E1EEFB',

  // Neutrals
  ink900: '#101817',
  ink700: '#33403E',
  ink500: '#5C6B69',
  ink300: '#93A19F',
  ink200: '#C8D2D0',
  ink100: '#E6ECEB',
  surface: '#FFFFFF',
  surfaceAlt: '#F6F9F8',
  background: '#F1F5F4',
  overlay: 'rgba(16, 24, 23, 0.55)',
} as const;

/** High-contrast overrides applied when the user enables the accessibility setting. */
export const HIGH_CONTRAST_OVERRIDES = {
  ink700: '#000000',
  ink500: '#1A1A1A',
  ink300: '#3D3D3D',
  ink200: '#6B6B6B',
  primary600: '#00504A',
  primary700: '#003A35',
  success500: '#0E6B36',
  warning500: '#7A4A00',
  danger500: '#9B0000',
  background: '#FFFFFF',
  surfaceAlt: '#FFFFFF',
} as const;

export const DOSE_STATUS_COLORS = {
  upcoming: { fg: PALETTE.ink700, bg: PALETTE.ink100 },
  due: { fg: PALETTE.primary700, bg: PALETTE.primary100 },
  pending_confirmation: { fg: PALETTE.warning700, bg: PALETTE.warning100 },
  snoozed: { fg: PALETTE.info700, bg: PALETTE.info100 },
  taken: { fg: PALETTE.success700, bg: PALETTE.success100 },
  taken_late: { fg: PALETTE.warning700, bg: PALETTE.warning100 },
  skipped: { fg: PALETTE.ink500, bg: PALETTE.ink100 },
  missed: { fg: PALETTE.danger700, bg: PALETTE.danger100 },
  cancelled: { fg: PALETTE.ink300, bg: PALETTE.ink100 },
} as const;

export const SPACING = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

/** Base (standard mode) type scale in points. */
export const TYPE_SCALE = {
  display: 34,
  h1: 28,
  h2: 24,
  h3: 20,
  bodyLarge: 18,
  body: 16,
  bodySmall: 14,
  caption: 12,
} as const;

/**
 * Elderly mode is a *scale factor plus layout simplification*, not a separate
 * theme. Multiplying the base scale keeps a single source of truth.
 */
export const ELDERLY_TYPE_MULTIPLIER = 1.35;
export const ELDERLY_TOUCH_TARGET = 72;

/** WCAG 2.5.5 asks for 44×44; we exceed it everywhere and go much larger in elderly mode. */
export const TOUCH_TARGET = { min: 48, comfortable: 56, elderly: ELDERLY_TOUCH_TARGET } as const;

export function typeSize(key: keyof typeof TYPE_SCALE, opts?: { elderlyMode?: boolean; textScale?: number }): number {
  const base = TYPE_SCALE[key];
  const elderly = opts?.elderlyMode ? ELDERLY_TYPE_MULTIPLIER : 1;
  const user = opts?.textScale ?? 1;
  return Math.round(base * elderly * user);
}

export function touchTarget(elderlyMode: boolean): number {
  return elderlyMode ? TOUCH_TARGET.elderly : TOUCH_TARGET.comfortable;
}

// ------------------------------------------------------- contrast tooling

function channel(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channel(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pairs the accessibility test asserts on. `large` pairs need 3:1, the rest 4.5:1. */
export const PAIRS_TO_AUDIT: Array<{ name: string; fg: string; bg: string; large?: boolean }> = [
  { name: 'body on surface', fg: PALETTE.ink900, bg: PALETTE.surface },
  { name: 'secondary text on surface', fg: PALETTE.ink700, bg: PALETTE.surface },
  { name: 'muted text on surface', fg: PALETTE.ink500, bg: PALETTE.surface },
  { name: 'body on background', fg: PALETTE.ink900, bg: PALETTE.background },
  { name: 'secondary on background', fg: PALETTE.ink700, bg: PALETTE.background },
  { name: 'primary button label', fg: PALETTE.surface, bg: PALETTE.primary700 },
  { name: 'danger button label', fg: PALETTE.surface, bg: PALETTE.danger700 },
  { name: 'success button label', fg: PALETTE.surface, bg: PALETTE.success700 },
  { name: 'link on surface', fg: PALETTE.primary700, bg: PALETTE.surface },
  { name: 'status taken', fg: DOSE_STATUS_COLORS.taken.fg, bg: DOSE_STATUS_COLORS.taken.bg },
  { name: 'status taken_late', fg: DOSE_STATUS_COLORS.taken_late.fg, bg: DOSE_STATUS_COLORS.taken_late.bg },
  { name: 'status missed', fg: DOSE_STATUS_COLORS.missed.fg, bg: DOSE_STATUS_COLORS.missed.bg },
  { name: 'status due', fg: DOSE_STATUS_COLORS.due.fg, bg: DOSE_STATUS_COLORS.due.bg },
  { name: 'status snoozed', fg: DOSE_STATUS_COLORS.snoozed.fg, bg: DOSE_STATUS_COLORS.snoozed.bg },
  { name: 'status skipped', fg: DOSE_STATUS_COLORS.skipped.fg, bg: DOSE_STATUS_COLORS.skipped.bg },
  { name: 'status upcoming', fg: DOSE_STATUS_COLORS.upcoming.fg, bg: DOSE_STATUS_COLORS.upcoming.bg },
];
