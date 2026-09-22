import React, { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '@/i18n';
import { getLocalScheduleStatus, getPushRegistrationStatus, subscribeNotificationStatus } from '@/notifications';
import { Banner, Button } from './ui';

export function NotificationHealthNotice() {
  const { t, formatDate, formatTime } = useI18n();
  const push = useSyncExternalStore(subscribeNotificationStatus, getPushRegistrationStatus, getPushRegistrationStatus);
  const schedule = useSyncExternalStore(subscribeNotificationStatus, getLocalScheduleStatus, getLocalScheduleStatus);
  const next = schedule?.nextUnscheduledAt;
  return <View>
    {push === 'failed' ? <Banner tone="warning" title={t('notifications.registrationFailed')}
      body={t('notifications.registrationFailedBody')}
      action={<Button label={t('settings.notifications')} onPress={() => router.push('/settings/notifications')} />} /> : null}
    {schedule?.failed ? <Banner tone="warning" title={t('notifications.scheduleFailed')} /> : null}
    {next ? <Banner tone="warning" title={t('notifications.capacityTitle')}
      body={t('notifications.capacityBody', { date: formatDate(next), time: formatTime(next) })} /> : null}
  </View>;
}
