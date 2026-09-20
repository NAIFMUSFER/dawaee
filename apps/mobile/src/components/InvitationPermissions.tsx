import React from 'react';
import { View } from 'react-native';
import type { CaregiverPermission, CaregiverRole } from '@dawaee/shared';
import { useI18n } from '@/i18n';
import { Card, Txt } from './ui';

export interface InvitationPreview {
  id: string;
  patientName: string;
  role: CaregiverRole;
  permissions: CaregiverPermission[];
  expiresAt: string;
}
const CHANGES: readonly CaregiverPermission[] = [
  'edit_schedule', 'add_medication', 'edit_medication', 'update_stock', 'confirm_dose', 'manage_caregivers',
];
/** The same permission list is visible before acceptance in both entry paths. */
export function InvitationPermissions({ invitation }: { invitation: InvitationPreview }) {
  const { t, formatDate } = useI18n();
  const permissions = invitation.permissions ?? [];
  return <Card>
    <Txt variant="bodyLarge" weight="bold">{invitation.patientName}</Txt>
    <Txt>{t(`relationship.${invitation.role}`)}</Txt>
    {[false, true].map(changes => <View key={String(changes)}>
      <Txt weight="bold">{t(changes ? 'family.canChange' : 'family.canSee')}</Txt>
      {permissions.filter(permission => CHANGES.includes(permission) === changes).map(permission =>
        <Txt key={permission}>{`• ${t(`permission.${permission}`)}`}</Txt>)}
    </View>)}
    {permissions.length === 0 ? <Txt>{t('family.seesNothing')}</Txt> : null}
    <Txt>{t('accept.expiresAt', { date: formatDate(invitation.expiresAt) })}</Txt>
    <Txt variant="bodySmall">{t('family.permissionsSetByPatient')}</Txt>
    <Txt variant="bodySmall">{t('accept.reviewBody')}</Txt>
  </Card>;
}
