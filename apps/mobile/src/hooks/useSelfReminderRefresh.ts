import { useEffect, type MutableRefObject } from 'react';
import { AppState as NativeAppState } from 'react-native';
import { subscribeClinicalChanges } from '../api/clinical-changes.js';
import { api, isSignedIn } from '../api/client.js';
import type { TodayResponse } from '../api/types.js';
import type { AppState } from '../state/app-store.js';
import { cacheSchedule, cacheDose, readQueue, applyQueuedToDoses } from '../storage/offline-queue.js';
import { captureLocalReminderContext, rescheduleLocalNotifications } from '../notifications/index.js';

export function useSelfReminderRefresh(state: AppState, stateRef: MutableRefObject<AppState>,
  sessionGeneration: MutableRefObject<number>, mounted: MutableRefObject<boolean>): void {
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let inFlight = 0;
    let lastSchedule: string | undefined;
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
      inFlight++;
      try {
        const res = await api.get<TodayResponse>('/v1/today', { profileId: self.id });
        if (!current()) return;
        const queued = await readQueue();
        if (!current()) return;
        const doses = applyQueuedToDoses([...res.today, ...res.prefetch], queued);
        await cacheSchedule({ profileId: self.id, cachedAt: new Date().toISOString(), timezone: res.timezone,
          doses: [...res.today, ...res.prefetch].map(cacheDose) });
        if (!current()) return;
        const prefs = stateRef.current.preferences;
        const signature = JSON.stringify([self.id, prefs.locale, prefs.voiceRemindersEnabled,
          prefs.showMedicationInNotifications, doses.map(d => [d.id, d.scheduledAt, d.snoozedUntil,
            ['taken', 'taken_late', 'skipped', 'cancelled', 'missed'].includes(d.status),
            d.medication.name, d.medication.foodInstruction, d.doseQuantity, d.doseUnit])]);
        if (signature === lastSchedule) return;
        const scheduled = await rescheduleLocalNotifications(doses, prefs.locale, {
          voiceEnabled: prefs.voiceRemindersEnabled, showMedication: prefs.showMedicationInNotifications,
        });
        if (scheduled.failed === 0 && !disposed && attempt === revision) lastSchedule = signature;
      } catch { /* Preserve existing reminders offline; foreground/poll retries. */ }
      finally { inFlight--; }
    };
    const invalidate = () => {
      revision++;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 100);
    };
    const unsubscribe = subscribeClinicalChanges(invalidate);
    const sub = NativeAppState.addEventListener('change', state => {
      if (state === 'active') { lastSchedule = undefined; invalidate(); }
    });
    // Web/caregiver writes do not emit this device's clinical-change event.
    // Refresh the owner's schedule even while another screen/profile is open.
    const poll = setInterval(() => {
      if (NativeAppState.currentState === 'active' && inFlight === 0) void refresh();
    }, 30_000);
    invalidate();
    return () => { disposed = true; revision++; if (timer) clearTimeout(timer); clearInterval(poll); unsubscribe(); sub.remove(); };
  }, [state.user?.id, state.signedIn, state.user?.emailVerificationRequired, state.profiles.some(p => p.isSelf)]);

}
