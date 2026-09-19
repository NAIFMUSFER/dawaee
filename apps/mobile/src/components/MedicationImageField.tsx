import React, { useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Banner, Button, Card, Txt } from '@/components/ui';
import { MedicationPhoto } from '@/components/MedicationPhoto';
import { useRequestScope } from '@/hooks/useRequestScope';
import { useI18n } from '@/i18n';
import { uploadMedicationImage } from '@/medication/upload-image';

/** The parent saves the finalized key with the medication. OCR is optional and
 * never required to give an older patient a recognition photo. */
export function MedicationImageField({ profileId, imageKey, name, disabled, onChange, onBusyChange }: {
  profileId: string; imageKey: string | null; name: string; disabled?: boolean;
  onChange: (key: string | null) => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { capture } = useRequestScope();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const choose = async () => {
    if (disabled || locked.current) return;
    const current = capture();
    locked.current = true; setBusy(true); onBusyChange(true); setError(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) { setError(t('capture.permissionBody')); return; }
      const selected = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
      if (!current() || selected.canceled || !selected.assets?.[0]) return;
      const photo = selected.assets[0];
      const key = await uploadMedicationImage({ uri: photo.uri, mimeType: photo.mimeType, patientProfileId: profileId, isCurrent: current });
      if (current() && key) onChange(key);
    } catch { if (current()) setError(t('capture.failed')); }
    finally {
      locked.current = false;
      if (current()) { setBusy(false); onBusyChange(false); }
    }
  };
  return <Card>
    <Txt weight="bold">{locale === 'ar' ? 'صورة الدواء' : 'Medication photo'}</Txt>
    <Txt>{locale === 'ar' ? 'تظهر في بطاقة تأكيد الجرعة لتسهيل التعرّف على الدواء.' : 'Shown on the dose confirmation card to help recognize the medicine.'}</Txt>
    <MedicationPhoto imageKey={imageKey} name={name} prominent />
    {error ? <Banner tone="warning" title={error} /> : null}
    <Button label={imageKey ? (locale === 'ar' ? 'تغيير الصورة' : 'Change photo') : t('medication.uploadImage')} loading={busy} disabled={disabled || busy} onPress={() => void choose()} />
    {imageKey ? <Button label={locale === 'ar' ? 'إزالة الصورة' : 'Remove photo'} tone="ghost" disabled={disabled || busy} onPress={() => onChange(null)} /> : null}
  </Card>;
}
