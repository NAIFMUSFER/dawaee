import React, { useMemo } from 'react';
import { Card, Txt } from './ui.js';
import { Picker } from './Picker.js';
import { useApp } from '../state/app-store.js';
import { useTheme } from '../hooks/useTheme.js';

export function ProfileSwitcher({ compact = false }: { compact?: boolean }) {
  const { profiles, activeProfile, setActiveProfile, preferences } = useApp();
  const theme = useTheme();
  const arabic = preferences.locale === 'ar';

  const options = useMemo(() => profiles.map((profile) => ({
    value: profile.id,
    label: profile.isSelf
      ? `${profile.displayName} · ${arabic ? 'ملفي' : 'My profile'}`
      : `${profile.displayName} · ${arabic ? 'أتابعه' : 'I care for'}`,
  })), [arabic, profiles]);

  if (!activeProfile || profiles.length <= 1) return null;

  const picker = (
    <Picker
      label={arabic ? 'اختر الملف' : 'Choose profile'}
      options={options}
      value={activeProfile.id}
      onChange={setActiveProfile}
      hint={arabic ? 'كل الأدوية والمواعيد أدناه تخص الملف المحدد.' : 'Medications and schedules below belong to the selected profile.'}
    />
  );

  if (compact) return picker;
  return (
    <Card style={{ gap: theme.spacing.xs }}>
      <Txt variant="bodySmall" weight="bold" color={theme.colors.primary700}>
        {arabic ? 'الملف الحالي' : 'Current profile'}
      </Txt>
      {picker}
    </Card>
  );
}

export function canAddMedicationToActiveProfile() {
  return true;
}
