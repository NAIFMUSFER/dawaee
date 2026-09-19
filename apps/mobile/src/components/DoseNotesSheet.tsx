import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { PrivacyModal as Modal } from '@/security/PrivacyModal';
import { Banner, Button, Card, Field, Loading, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/i18n';
import { useRequestScope } from '@/hooks/useRequestScope';
import { api, NetworkError } from '@/api/client';
import type { DoseView } from '@/api/types';

interface DoseNote { id: string; text: string | null; tags: string[]; recordedAt: string }
export interface DoseNotesProps {
  profileId: string; dose: DoseView; canWrite: boolean; canRead: boolean; onClose: () => void;
}

/** Parent keys this sheet by account, patient, permissions and dose. No draft
 * or health identifier is placed in URLs, logs or unencrypted local storage. */
export function DoseNotesSheet({ profileId, dose, canWrite, canRead, onClose }: DoseNotesProps) {
  const theme = useTheme();
  const { t, locale, formatDate, formatTime } = useI18n();
  const showNotes = canRead || canWrite;
  const { capture, begin } = useRequestScope(`${profileId}:${dose.id}:${canWrite}:${canRead}`);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState<DoseNote[]>([]);
  const [loading, setLoading] = useState(showNotes);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const locked = useRef(false);
  const load = useCallback(async () => {
    if (!showNotes) return;
    const current = begin();
    setLoading(true); setLoadError(false);
    try {
      const result = await api.get<{ notes: DoseNote[] }>('/v1/notes', { profileId, doseOccurrenceId: dose.id, ...(!canRead ? { own: 'true' } : {}) });
      if (current()) setNotes(result.notes);
    } catch { if (current()) setLoadError(true); }
    finally { if (current()) setLoading(false); }
  }, [begin, showNotes, canRead, profileId, dose.id]);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    const value = text.trim();
    if (!canWrite || locked.current || !value || value.length > 2000) return;
    locked.current = true; setBusy(true); setError(null); setSaved(false);
    const current = capture();
    try {
      await api.post('/v1/notes', { profileId, doseOccurrenceId: dose.id, text: value, tags: [] });
      if (!current()) return;
      setText(''); setSaved(true);
      void load();
    } catch (err) {
      if (current()) setError(t(err instanceof NetworkError ? 'notifications.offlineBanner' : 'notes.failed'));
    } finally { locked.current = false; if (current()) setBusy(false); }
  };
  return <Modal visible animationType="slide" onRequestClose={() => { if (!locked.current) onClose(); }}>
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.colors.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: theme.spacing.lg, paddingTop: theme.spacing.xl * 2, gap: theme.spacing.md }}>
        <Txt variant="h2" weight="bold" accessibilityRole="header">{t('notes.title')}</Txt>
        <Txt weight="bold">{dose.medication.name}</Txt>
        <Txt>{formatDate(dose.scheduledAt, dose.scheduledTimezone)} · {formatTime(dose.scheduledAt, dose.scheduledTimezone)}</Txt>
        <Txt>{t('notes.optional')}</Txt>
        {canWrite ? <View style={{ gap: theme.spacing.md }}>
          <Field label={t('notes.textLabel')} value={text} onChangeText={value => { setText(value); setSaved(false); }} multiline maxLength={2000} editable={!busy} />
          {error ? <Banner tone="warning" title={error} /> : null}
          {saved ? <Banner tone="success" title={t('notes.saved')} /> : null}
          <Button label={t('notes.save')} onPress={() => void save()} loading={busy} disabled={!text.trim() || busy} />
        </View> : null}
        {!canRead && canWrite ? <Txt>{locale === 'ar' ? 'تظهر هنا الملاحظات التي كتبتها أنت فقط.' : 'Only notes you wrote are shown here.'}</Txt> : null}
        {showNotes && loading ? <Loading /> : null}
        {showNotes && loadError ? <Banner tone="warning" title={t('notes.loadFailed')} action={<Button label={t('common.retry')} onPress={() => void load()} />} /> : null}
        {showNotes && !loading && !loadError && notes.length === 0 ? <Txt>{t('notes.empty')}</Txt> : null}
        {showNotes ? notes.map(note => <Card key={note.id}>
          <Txt>{note.text}</Txt>
          {note.tags.length ? <Txt>{note.tags.map(tag => t(`symptom.${tag}` as never)).join('، ')}</Txt> : null}
          <Txt variant="caption">{formatDate(note.recordedAt, dose.scheduledTimezone)} · {formatTime(note.recordedAt, dose.scheduledTimezone)}</Txt>
        </Card>) : null}
        <Button label={t('common.close')} tone="ghost" disabled={busy} onPress={() => { if (!locked.current) onClose(); }} />
      </ScrollView>
    </KeyboardAvoidingView>
  </Modal>;
}
