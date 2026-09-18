import { useEffect, type MutableRefObject } from 'react';
import { AppState as NativeAppState } from 'react-native';
import { subscribeClinicalChanges } from '../api/clinical-changes.js';
import { api, isSignedIn } from '../api/client.js';
import type { TodayResponse } from '../api/types.js';
import type { AppState } from '../state/app-store.js';
import { cacheSchedule } from '../storage/offline-queue.js';
import { captureLocalReminderContext, rescheduleLocalNotifications } from '../notifications/index.js';

export function useSelfReminderRefresh(state: AppState, stateRef: MutableRefObject<AppState>,
  sessionGeneration: MutableRefObject<number>, mounted: MutableRefObject<boolean>): void {
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const snapshot = stateRef.current;
      const self = snapshot.profiles.find(profile => profile.isSelf && profile.role === 'owner');
      if (disposed || !snapshot.signedIn || !self || snapshot.user?.emailVerificationRequired) return;
      const generation = sessionGeneration.current;
      const attempt = ++revision;
      const remindersCurrent = captureLocalReminderContext();
      const current = () => !disposed && mounted.current && attempt === revision
        && generation === sessionGeneration.current && isSignedIn() && remindersCurrent();
      try {
        const res = await api.get<TodayResponse>('/v1/today', { profileId: self.id });
        if (!current()) return;
        const doses = [...res.today, ...res.prefetch];
        await cacheSchedule({ profileId: self.id, cachedAt: new Date().toISOString(), timezone: res.timezone,
          doses: doses.map(d => ({ id: d.id, scheduledAt: d.scheduledAt,
            scheduledLocalTime: d.scheduledLocalTime, scheduledLocalDate: d.scheduledLocalDate,
            medicationName: d.medication.name, doseQuantity: d.doseQuantity, doseUnit: d.doseUnit,
            foodInstruction: d.medication.foodInstruction, status: d.status })) });
        if (!current()) return;
        const prefs = stateRef.current.preferences;
        await rescheduleLocalNotifications(doses, prefs.locale, {
          voiceEnabled: prefs.voiceRemindersEnabled, showMedication: prefs.showMedicationInNotifications,
        });
      } catch { /* Preserve existing reminders offline; foreground/focus retries. */ }
    };
    const invalidate = () => {
      revision++;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 100);
    };
    const unsubscribe = subscribeClinicalChanges(invalidate);
    const sub = NativeAppState.addEventListener('change', state => { if (state === 'active') invalidate(); });
    invalidate();
    return () => { disposed = true; revision++; if (timer) clearTimeout(timer); unsubscribe(); sub.remove(); };
  }, [state.user?.id, state.signedIn, state.user?.emailVerificationRequired, state.profiles.some(p => p.isSelf)]);

}
