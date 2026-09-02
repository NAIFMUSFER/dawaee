import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Txt } from './ui.js';
import { useTheme } from '../hooks/useTheme.js';

/**
 * Single-choice picker rendered as a scrollable row of chips.
 *
 * A native picker wheel is unreadable at the type sizes elderly mode uses and
 * hides every option but one, so the choices stay visible and each chip is a
 * full touch target. The chips carry radio semantics, which is what lets a
 * screen reader announce "2 of 12" rather than reading a wall of buttons.
 */

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

export function Picker<T extends string>({
  label, options, value, onChange, hint, error, disabled,
}: {
  label: string;
  options: ReadonlyArray<PickerOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{label}</Txt>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.xxs }}
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected, disabled: Boolean(disabled) }}
              style={({ pressed }) => [{
                minHeight: theme.touch,
                justifyContent: 'center',
                paddingHorizontal: theme.spacing.lg,
                borderRadius: theme.radius.pill,
                borderWidth: 2,
                borderColor: selected ? theme.colors.primary700 : theme.colors.ink200,
                backgroundColor: selected ? theme.colors.primary700 : theme.colors.surface,
                opacity: disabled ? 0.45 : pressed ? 0.9 : 1,
              }]}
            >
              <Txt
                variant="body"
                weight={selected ? 'bold' : 'regular'}
                color={selected ? theme.colors.surface : theme.colors.ink700}
              >
                {option.label}
              </Txt>
            </Pressable>
          );
        })}
      </ScrollView>
      {hint && !error ? <Txt variant="caption" color={theme.colors.ink500}>{hint}</Txt> : null}
      {error ? <Txt variant="caption" color={theme.colors.danger700}>{error}</Txt> : null}
    </View>
  );
}

/**
 * Multi-choice variant, used for the weekday selector. Kept beside `Picker`
 * so both share one visual language and one set of accessibility semantics.
 */
export function MultiPicker<T extends string>({
  label, options, values, onToggle, hint, error,
}: {
  label: string;
  options: ReadonlyArray<PickerOption<T>>;
  values: readonly T[];
  onToggle: (value: T) => void;
  hint?: string;
  error?: string | null;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="medium" color={theme.colors.ink700}>{label}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        {options.map((option) => {
          const selected = values.includes(option.value);
          return (
            <Pressable
              key={option.value}
              onPress={() => onToggle(option.value)}
              accessibilityRole="checkbox"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected }}
              style={({ pressed }) => [{
                minHeight: theme.touch,
                justifyContent: 'center',
                paddingHorizontal: theme.spacing.lg,
                borderRadius: theme.radius.pill,
                borderWidth: 2,
                borderColor: selected ? theme.colors.primary700 : theme.colors.ink200,
                backgroundColor: selected ? theme.colors.primary100 : theme.colors.surface,
                opacity: pressed ? 0.9 : 1,
              }]}
            >
              <Txt
                variant="body"
                weight={selected ? 'bold' : 'regular'}
                color={selected ? theme.colors.primary700 : theme.colors.ink700}
              >
                {option.label}
              </Txt>
            </Pressable>
          );
        })}
      </View>
      {hint && !error ? <Txt variant="caption" color={theme.colors.ink500}>{hint}</Txt> : null}
      {error ? <Txt variant="caption" color={theme.colors.danger700}>{error}</Txt> : null}
    </View>
  );
}
