import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type AccessibilityRole, type StyleProp, type TextStyle, type ViewStyle,
} from 'react-native';
import { useTheme } from '../hooks/useTheme.js';
import { useI18n } from '../i18n/index.js';
import type { Theme } from '../theme/index.js';

/**
 * The shared component set.
 *
 * Accessibility is built in here rather than left to each screen:
 * every interactive element gets a role, a label and a target that meets or
 * exceeds WCAG 2.5.5, and text alignment follows the writing direction
 * automatically. A screen that uses these components is accessible by default.
 */

export function Screen({
  children, scroll = true, padded = true, style,
}: { children: React.ReactNode; scroll?: boolean; padded?: boolean; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const content = (
    <View style={[padded && { padding: theme.spacing.lg, gap: theme.spacing.md }, style]}>{children}</View>
  );
  if (!scroll) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }}>{content}</View>;
  }
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}

type TypeKey = keyof Theme['font'];

export function Txt({
  children, variant = 'body', color, weight = 'regular', align, style, numberOfLines, accessibilityRole,
}: {
  children: React.ReactNode;
  variant?: TypeKey;
  color?: string;
  weight?: 'regular' | 'medium' | 'bold';
  align?: 'start' | 'center' | 'end';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  accessibilityRole?: AccessibilityRole;
}) {
  const theme = useTheme();
  const { isRtl } = useI18n();
  const size = theme.font[variant];
  const textAlign =
    align === 'center' ? 'center'
      : align === 'end' ? (isRtl ? 'left' : 'right')
        : (isRtl ? 'right' : 'left');
  return (
    <Text
      accessibilityRole={accessibilityRole}
      numberOfLines={numberOfLines}
      style={[
        {
          fontSize: size,
          lineHeight: theme.lineHeight(size),
          color: color ?? theme.colors.ink900,
          fontWeight: weight === 'bold' ? '700' : weight === 'medium' ? '600' : '400',
          textAlign,
          // Keeps mixed Arabic/Latin strings (e.g. "Panadol ٥٠٠") from
          // reordering unexpectedly.
          writingDirection: isRtl ? 'rtl' : 'ltr',
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Card({
  children, onPress, style, accessibilityLabel,
}: { children: React.ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>; accessibilityLabel?: string }) {
  const theme = useTheme();
  const base: StyleProp<ViewStyle> = [
    {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
      borderWidth: theme.hairline,
      borderColor: theme.colors.ink100,
    },
    theme.shadow,
    style,
  ];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [base, pressed && { opacity: 0.85 }]}
    >
      {children}
    </Pressable>
  );
}

export type ButtonTone = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost';

export function Button({
  label, onPress, tone = 'primary', disabled, loading, fullWidth = true, accessibilityHint, testID, size = 'regular',
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  accessibilityHint?: string;
  testID?: string;
  size?: 'regular' | 'large';
}) {
  const theme = useTheme();
  const palette: Record<ButtonTone, { bg: string; fg: string; border?: string }> = {
    primary: { bg: theme.colors.primary700, fg: theme.colors.surface },
    secondary: { bg: theme.colors.surface, fg: theme.colors.primary700, border: theme.colors.primary200 },
    success: { bg: theme.colors.success700, fg: theme.colors.surface },
    danger: { bg: theme.colors.danger700, fg: theme.colors.surface },
    ghost: { bg: 'transparent', fg: theme.colors.ink700 },
  };
  const c = palette[tone];
  // The primary action on a reminder is deliberately oversized: it is the one
  // thing an elderly user must be able to hit without aiming.
  const height = size === 'large' ? Math.max(theme.touch * 1.25, 72) : theme.touch;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      style={({ pressed }) => [
        {
          minHeight: height,
          paddingHorizontal: theme.spacing.xl,
          borderRadius: theme.radius.lg,
          backgroundColor: c.bg,
          borderWidth: c.border ? 2 : 0,
          borderColor: c.border,
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          opacity: disabled ? 0.45 : pressed ? 0.9 : 1,
        },
      ]}
    >
      {loading
        ? <ActivityIndicator color={c.fg} />
        : <Txt variant={size === 'large' ? 'h3' : 'bodyLarge'} weight="bold" color={c.fg} align="center">{label}</Txt>}
    </Pressable>
  );
}

export function Field({
  label, value, onChangeText, placeholder, keyboardType, hint, error, secureTextEntry, autoFocus,
  maxLength, multiline, autoCapitalize, autoCorrect,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad' | 'phone-pad' | 'decimal-pad' | 'email-address';
  hint?: string;
  error?: string | null;
  secureTextEntry?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  multiline?: boolean;
  /**
   * Matters for identifiers and passwords: a mobile keyboard capitalises the
   * first letter by default, which turns a typed email or password into one
   * that does not match — and the person cannot see why.
   */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
}) {
  const theme = useTheme();
  const { isRtl } = useI18n();
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{label}</Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.ink300}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoFocus={autoFocus}
        maxLength={maxLength}
        multiline={multiline}
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={{
          minHeight: multiline ? theme.touch * 2 : theme.touch,
          borderWidth: 2,
          borderColor: error ? theme.colors.danger500 : theme.colors.ink200,
          borderRadius: theme.radius.md,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          fontSize: theme.font.bodyLarge,
          color: theme.colors.ink900,
          backgroundColor: theme.colors.surface,
          // Phone numbers and quantities read left-to-right even in Arabic UI.
          textAlign: keyboardType === 'phone-pad' || keyboardType === 'number-pad' || keyboardType === 'decimal-pad'
            ? 'left'
            : isRtl ? 'right' : 'left',
          writingDirection: keyboardType?.includes('pad') ? 'ltr' : isRtl ? 'rtl' : 'ltr',
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {hint && !error ? <Txt variant="caption" color={theme.colors.ink500}>{hint}</Txt> : null}
      {error ? <Txt variant="caption" color={theme.colors.danger700}>{error}</Txt> : null}
    </View>
  );
}

export function Badge({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  const theme = useTheme();
  return (
    <View style={{
      backgroundColor: bg, borderRadius: theme.radius.pill,
      paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.xs, alignSelf: 'flex-start',
    }}>
      <Txt variant="caption" weight="bold" color={fg}>{label}</Txt>
    </View>
  );
}

export function Row({ children, gap, align = 'center', wrap, style }: {
  children: React.ReactNode; gap?: number; align?: 'center' | 'flex-start' | 'flex-end' | 'baseline';
  wrap?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View style={[{
      flexDirection: 'row', alignItems: align, gap: gap ?? theme.spacing.sm,
      flexWrap: wrap ? 'wrap' : 'nowrap',
    }, style]}>
      {children}
    </View>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={{ height: theme.hairline, backgroundColor: theme.colors.ink100, marginVertical: theme.spacing.sm }} />;
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between', marginTop: theme.spacing.md }}>
      <Txt variant="h3" weight="bold" accessibilityRole="header">{children}</Txt>
      {action}
    </Row>
  );
}

export function Banner({
  tone = 'info', title, body, action,
}: { tone?: 'info' | 'warning' | 'danger' | 'success'; title: string; body?: string; action?: React.ReactNode }) {
  const theme = useTheme();
  const map = {
    info: { bg: theme.colors.info100, fg: theme.colors.info700 },
    warning: { bg: theme.colors.warning100, fg: theme.colors.warning700 },
    danger: { bg: theme.colors.danger100, fg: theme.colors.danger700 },
    success: { bg: theme.colors.success100, fg: theme.colors.success700 },
  }[tone];
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: map.bg, borderRadius: theme.radius.md, padding: theme.spacing.md, gap: theme.spacing.xs }}
    >
      <Txt variant="bodySmall" weight="bold" color={map.fg}>{title}</Txt>
      {body ? <Txt variant="bodySmall" color={map.fg}>{body}</Txt> : null}
      {action}
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.xxxl }}>
      <Txt variant="h3" weight="bold" align="center">{title}</Txt>
      {body ? <Txt variant="body" color={theme.colors.ink500} align="center">{body}</Txt> : null}
      {action}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingVertical: theme.spacing.xxxl, alignItems: 'center', gap: theme.spacing.md }}>
      <ActivityIndicator size="large" color={theme.colors.primary600} />
      {label ? <Txt variant="bodySmall" color={theme.colors.ink500}>{label}</Txt> : null}
    </View>
  );
}

/**
 * The medical-safety footer. Rendered on adherence, reports and anywhere a
 * number could be mistaken for a clinical claim.
 */
export function SafetyNote({ textKey }: { textKey: 'adherence.disclaimer' | 'reports.disclaimer' | 'safety.notMedicalAdvice' | 'missed.guidance' | 'emergency.userProvided' }) {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <View style={{
      borderStartWidth: 4, borderStartColor: theme.colors.ink200,
      paddingStart: theme.spacing.md, paddingVertical: theme.spacing.xs, marginTop: theme.spacing.sm,
    }}>
      <Txt variant="caption" color={theme.colors.ink500}>{t(textKey)}</Txt>
    </View>
  );
}

/**
 * States plainly that this build is a preview with sample data. Rendered by
 * the root layout above every screen, because a person showing this to someone
 * else must never have to explain that the numbers are not real.
 */
export function PreviewBanner({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: theme.colors.warning100,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.xs,
        borderBottomWidth: theme.hairline,
        borderBottomColor: theme.colors.warning500,
      }}
    >
      <Txt variant="caption" weight="medium" color={theme.colors.warning700} align="center">{label}</Txt>
    </View>
  );
}

export const styles = StyleSheet.create({ flex: { flex: 1 } });
