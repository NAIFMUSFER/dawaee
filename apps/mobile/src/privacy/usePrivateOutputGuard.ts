import { useCallback, useLayoutEffect, useRef } from 'react';
import { useAppLock } from '@/security/AppLockContext';
import { closeWebPatientReport } from './web-patient-report';

/** Locking cancels an output operation permanently, even if the user unlocks
 * before a slow PDF/file operation completes. The profile scope remains owned
 * by the screen so its loading state can still settle after a lock. */
export function usePrivateOutputGuard(scopeKey = '') {
  const { contentBlocked } = useAppLock();
  const state = useRef({ blocked: contentBlocked, generation: 0 });
  if (contentBlocked !== state.current.blocked) {
    state.current.blocked = contentBlocked;
    if (contentBlocked) state.current.generation++;
  }
  useLayoutEffect(() => {
    if (contentBlocked) closeWebPatientReport();
    return closeWebPatientReport;
  }, [contentBlocked, scopeKey]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    // AppState dispatches through React. A hidden/visible pair may occur
    // before the intermediate locked render commits, so cancel synchronously
    // at the browser event boundary as well. Returning never revives a share.
    const invalidate = () => {
      state.current.generation++;
      closeWebPatientReport();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') invalidate();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', invalidate);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', invalidate);
    };
  }, []);
  return useCallback((requestCurrent: () => boolean) => {
    const generation = state.current.generation;
    return () => requestCurrent() && !state.current.blocked && state.current.generation === generation
      && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
  }, []);
}
