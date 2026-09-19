import React, { useState } from 'react';
import { View } from 'react-native';
import { DOSE_UNITS, FORM_DOSE_UNITS, type DoseUnit, type MedicationForm, type MessageKey } from '@dawaee/shared';
import { Picker } from './Picker.js';
import { Button, Txt } from './ui.js';
import { useI18n } from '../i18n/index.js';

export function DoseUnitPicker({ form, value, onChange }: {
  form: MedicationForm; value: DoseUnit; onChange: (unit: DoseUnit) => void;
}) {
  const { t, locale } = useI18n();
  const [extras, setExtras] = useState(false);
  const common = FORM_DOSE_UNITS[form];
  // Keep an existing uncommon unit visible. Form changes never overwrite it.
  const visible = extras ? DOSE_UNITS : [...new Set([...common, value])];
  const label = locale === 'ar' ? 'وحدة كمية الجرعة' : 'Dose amount unit';
  return <View style={{ gap: 8 }}>
    <Txt weight="bold">{label}: {t(`unit.${value}` as MessageKey)}</Txt>
    <Picker wrap label={label} options={visible.map((unit) => ({ value: unit, label: t(`unit.${unit}` as MessageKey) }))}
      value={value} onChange={onChange} />
    <Button tone="ghost" label={locale === 'ar' ? (extras ? 'إخفاء الوحدات الإضافية' : 'وحدات إضافية') : (extras ? 'Hide additional units' : 'Additional units')}
      onPress={() => setExtras(!extras)} />
    <Txt variant="caption">{locale === 'ar'
      ? 'هذه وحدة الكمية التي تتناولها، وليست تركيز العبوة. لا يحوّل التطبيق بين ملغم ومل أو الأقراص.'
      : 'This is the amount you take, separate from package strength. The app does not convert between mg, mL or tablets.'}</Txt>
  </View>;
}
