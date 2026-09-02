import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Banner, Button, Card, EmptyState, Field, Loading, Row, SafetyNote, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { useApp } from '@/state/app-store';
import { api, ApiError, NetworkError } from '@/api/client';
import { MESSAGES, type MessageKey } from '@dawaee/shared';

/**
 * The emergency card editor.
 *
 * Everything on this card is typed by the patient and shown to a stranger, so
 * two rules hold throughout: the app never suggests a value (no allergy
 * autocomplete, no "did you mean penicillin?" — a wrong suggestion accepted by
 * a tired user could end up in front of a paramedic), and the card always
 * carries the line that says the information is self-reported.
 *
 * The three include switches are the patient's, not the app's. Turning one off
 * removes that section from what a scan returns, immediately.
 */

/**
 * Server error codes map to a localized message when we have one, and to the
 * generic message when the API grows a code this build has never heard of —
 * showing a raw code like `dose_already_resolved` to a patient is not an error
 * message.
 */
function useApiErrorText(): (err: ApiError) => string {
  const { t } = useI18n();
  return useCallback((err: ApiError) => {
    const key = `error.${err.code}`;
    return key in MESSAGES.en ? t(key as MessageKey) : t('error.internal_error');
  }, [t]);
}

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
const MAX_CONTACTS = 5;
const MAX_ALLERGIES = 30;
const E164 = /^\+[1-9]\d{7,14}$/;

interface EmergencyContact {
  name: string;
  phoneE164: string;
  relation: string | null;
}

interface EmergencyCardView {
  bloodType: string | null;
  allergies: string[];
  conditionsNote: string | null;
  emergencyContacts: EmergencyContact[];
  includeMedications: boolean;
  includeAllergies: boolean;
  includeContacts: boolean;
}

const EMPTY_CARD: EmergencyCardView = {
  bloodType: null,
  allergies: [],
  conditionsNote: null,
  emergencyContacts: [],
  includeMedications: true,
  includeAllergies: true,
  includeContacts: true,
};

export default function EmergencyCardScreen() {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { activeProfile } = useApp();
  const apiErrorText = useApiErrorText();

  const [card, setCard] = useState<EmergencyCardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [allergyDraft, setAllergyDraft] = useState('');
  const [contactErrors, setContactErrors] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ card: EmergencyCardView | null }>('/v1/emergency/card', {
        profileId: activeProfile.id,
      });
      setCard(res.card ? { ...EMPTY_CARD, ...res.card } : { ...EMPTY_CARD });
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError) setError(apiErrorText(err));
      else setError(t('error.internal_error'));
    } finally {
      setLoading(false);
    }
  }, [activeProfile, apiErrorText, t]);

  useEffect(() => { void load(); }, [load]);

  const patch = (changes: Partial<EmergencyCardView>) => {
    setSaved(false);
    setCard((current) => (current ? { ...current, ...changes } : current));
  };

  const addAllergy = () => {
    const value = allergyDraft.trim();
    if (!card || value.length === 0 || card.allergies.length >= MAX_ALLERGIES) return;
    // Stored verbatim: no normalisation, no matching against a drug list.
    patch({ allergies: [...card.allergies, value.slice(0, 120)] });
    setAllergyDraft('');
  };

  const save = async () => {
    if (!card || !activeProfile) return;

    const errors: Record<number, string> = {};
    card.emergencyContacts.forEach((contact, index) => {
      if (contact.name.trim().length === 0 || !E164.test(contact.phoneE164.trim())) {
        errors[index] = t('emergency.contactPhoneInvalid');
      }
    });
    setContactErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setError(null);
    try {
      await api.put('/v1/emergency/card', {
        bloodType: card.bloodType,
        allergies: card.allergies,
        conditionsNote: card.conditionsNote?.trim() ? card.conditionsNote.trim() : null,
        emergencyContacts: card.emergencyContacts.map((c) => ({
          name: c.name.trim(),
          phoneE164: c.phoneE164.trim(),
          relation: c.relation?.trim() ? c.relation.trim() : null,
        })),
        includeMedications: card.includeMedications,
        includeAllergies: card.includeAllergies,
        includeContacts: card.includeContacts,
      }, { profileId: activeProfile.id });
      setSaved(true);
      setOffline(false);
    } catch (err) {
      if (err instanceof NetworkError) setOffline(true);
      else if (err instanceof ApiError) setError(t('emergency.saveFailed'));
      else setError(t('error.internal_error'));
    } finally {
      setSaving(false);
    }
  };

  const IncludeSwitch = ({
    label, value, onChange,
  }: { label: string; value: boolean; onChange: (next: boolean) => void }) => (
    <Row style={{ justifyContent: 'space-between' }} gap={theme.spacing.md}>
      <Txt variant="bodyLarge" style={{ flex: 1 }}>{label}</Txt>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityHint={t('emergency.includeHint')}
        trackColor={{ false: theme.colors.ink200, true: theme.colors.primary500 }}
      />
    </Row>
  );

  if (!activeProfile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen><EmptyState title={t('settings.switchProfile')} /></Screen>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h1" weight="bold" accessibilityRole="header">{t('emergency.title')}</Txt>
          <Button label={t('common.back')} tone="ghost" fullWidth={false} onPress={() => router.back()} />
        </Row>

        <Banner tone="info" title={t('emergency.userProvided')} />

        {offline ? (
          <Banner
            tone="warning"
            title={t('notifications.offlineBanner')}
            action={<Button label={t('common.retry')} tone="ghost" fullWidth={false} onPress={() => void load()} />}
          />
        ) : null}
        {error ? <Banner tone="danger" title={error} /> : null}
        {saved ? <Banner tone="success" title={t('common.saved')} /> : null}

        {loading && !card ? <Loading label={t('common.loading')} /> : null}

        {card ? (
          <>
            <SectionTitle>{t('emergency.bloodType')}</SectionTitle>
            <Row gap={theme.spacing.sm} wrap>
              {[null, ...BLOOD_TYPES].map((type) => {
                const selected = card.bloodType === type;
                const label = type ?? t('emergency.bloodTypeUnknown');
                return (
                  <Pressable
                    key={label}
                    onPress={() => patch({ bloodType: type })}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={label}
                    style={({ pressed }) => [{
                      minHeight: theme.touch,
                      minWidth: theme.touch,
                      paddingHorizontal: theme.spacing.lg,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: theme.radius.pill,
                      borderWidth: 2,
                      borderColor: selected ? theme.colors.primary600 : theme.colors.ink200,
                      backgroundColor: selected ? theme.colors.primary100 : theme.colors.surface,
                      opacity: pressed ? 0.85 : 1,
                    }]}
                  >
                    <Txt
                      variant="bodyLarge"
                      weight={selected ? 'bold' : 'regular'}
                      color={selected ? theme.colors.primary700 : theme.colors.ink700}
                    >
                      {label}
                    </Txt>
                  </Pressable>
                );
              })}
            </Row>

            <SectionTitle>{t('emergency.allergies')}</SectionTitle>
            <Txt variant="bodySmall" color={theme.colors.ink500}>{t('emergency.allergyHint')}</Txt>
            <Card>
              <Field
                label={t('emergency.allergyAdd')}
                value={allergyDraft}
                onChangeText={setAllergyDraft}
                placeholder={t('emergency.allergyPlaceholder')}
                maxLength={120}
              />
              <Button
                label={t('common.add')}
                tone="secondary"
                onPress={addAllergy}
                disabled={allergyDraft.trim().length === 0 || card.allergies.length >= MAX_ALLERGIES}
              />
            </Card>

            {card.allergies.length === 0 ? (
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('emergency.noAllergies')}</Txt>
            ) : (
              <Row gap={theme.spacing.sm} wrap>
                {card.allergies.map((allergy, index) => (
                  <Pressable
                    key={`${allergy}-${index}`}
                    onPress={() => patch({ allergies: card.allergies.filter((_, i) => i !== index) })}
                    accessibilityRole="button"
                    accessibilityLabel={t('emergency.allergyRemove', { name: allergy })}
                    style={({ pressed }) => [{
                      minHeight: theme.touch,
                      paddingHorizontal: theme.spacing.lg,
                      justifyContent: 'center',
                      borderRadius: theme.radius.pill,
                      backgroundColor: theme.colors.danger100,
                      opacity: pressed ? 0.85 : 1,
                    }]}
                  >
                    <Row gap={theme.spacing.sm}>
                      <Txt variant="bodyLarge" color={theme.colors.danger700}>{allergy}</Txt>
                      <Txt variant="bodyLarge" weight="bold" color={theme.colors.danger700}>×</Txt>
                    </Row>
                  </Pressable>
                ))}
              </Row>
            )}

            <SectionTitle>{t('emergency.conditions')}</SectionTitle>
            <Field
              label={t('emergency.conditions')}
              value={card.conditionsNote ?? ''}
              onChangeText={(v) => patch({ conditionsNote: v })}
              hint={t('emergency.conditionsHint')}
              multiline
              maxLength={1000}
            />

            <SectionTitle>{t('emergency.contacts')}</SectionTitle>
            <Txt variant="bodySmall" color={theme.colors.ink500}>
              {t('emergency.contactsLimit', { count: formatNumber(MAX_CONTACTS) })}
            </Txt>

            {card.emergencyContacts.length === 0 ? (
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('emergency.noContacts')}</Txt>
            ) : null}

            {card.emergencyContacts.map((contact, index) => (
              <Card key={`contact-${index}`}>
                <Field
                  label={t('emergency.contactName')}
                  value={contact.name}
                  onChangeText={(v) => patch({
                    emergencyContacts: card.emergencyContacts.map((c, i) => (i === index ? { ...c, name: v } : c)),
                  })}
                  maxLength={80}
                />
                <Field
                  label={t('emergency.contactPhone')}
                  value={contact.phoneE164}
                  onChangeText={(v) => patch({
                    emergencyContacts: card.emergencyContacts.map((c, i) => (i === index ? { ...c, phoneE164: v } : c)),
                  })}
                  keyboardType="phone-pad"
                  error={contactErrors[index] ?? null}
                  hint={t('emergency.contactPhoneInvalid')}
                />
                <Field
                  label={t('emergency.contactRelation')}
                  value={contact.relation ?? ''}
                  onChangeText={(v) => patch({
                    emergencyContacts: card.emergencyContacts.map((c, i) => (i === index ? { ...c, relation: v } : c)),
                  })}
                  maxLength={40}
                />
                <Button
                  label={t('emergency.contactRemove', { name: contact.name || t('emergency.contactName') })}
                  tone="ghost"
                  onPress={() => patch({
                    emergencyContacts: card.emergencyContacts.filter((_, i) => i !== index),
                  })}
                />
              </Card>
            ))}

            {card.emergencyContacts.length < MAX_CONTACTS ? (
              <Button
                label={t('emergency.contactAdd')}
                tone="secondary"
                onPress={() => patch({
                  emergencyContacts: [...card.emergencyContacts, { name: '', phoneE164: '', relation: null }],
                })}
              />
            ) : null}

            <SectionTitle>{t('emergency.whatToShow')}</SectionTitle>
            <Card>
              <Txt variant="bodySmall" color={theme.colors.ink500}>{t('emergency.includeHint')}</Txt>
              <IncludeSwitch
                label={t('emergency.includeMedications')}
                value={card.includeMedications}
                onChange={(v) => patch({ includeMedications: v })}
              />
              <IncludeSwitch
                label={t('emergency.includeAllergies')}
                value={card.includeAllergies}
                onChange={(v) => patch({ includeAllergies: v })}
              />
              <IncludeSwitch
                label={t('emergency.includeContacts')}
                value={card.includeContacts}
                onChange={(v) => patch({ includeContacts: v })}
              />
            </Card>

            <Button label={t('common.save')} size="large" loading={saving} onPress={() => void save()} />

            <View style={{ marginTop: theme.spacing.sm }}>
              <Button
                label={t('emergency.qr')}
                tone="ghost"
                onPress={() => router.push('/settings/emergency-qr')}
              />
            </View>
          </>
        ) : null}

        <SafetyNote textKey="emergency.userProvided" />
      </Screen>
    </SafeAreaView>
  );
}
