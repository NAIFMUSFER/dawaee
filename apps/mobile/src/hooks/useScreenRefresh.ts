import { useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { subscribeClinicalChanges } from '../api/clinical-changes';
import { useFocusEffect } from 'expo-router';

/** Refresh on navigation, foreground and while viewing changes from another
 * care-circle member. Keep the current callback without a load/render loop. */
export function useScreenRefresh(load: () => Promise<void>, scope = ''): void {
  const latest = useRef(load);
  latest.current = load;
  useFocusEffect(useCallback(() => {
    let focused = true;
    let running = false;
    let queued = false;
    const refresh = async () => {
      if (!focused || AppState.currentState === 'background') return;
      if (running) { queued = true; return; }
      running = true;
      try { await latest.current(); } finally {
        running = false;
        if (queued && focused) { queued = false; void refresh(); }
      }
    };
    void refresh();
    const unsubscribe = subscribeClinicalChanges(() => { void refresh(); });
    const timer = setInterval(() => { void refresh(); }, 30_000);
    const sub = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { focused = false; unsubscribe(); clearInterval(timer); sub.remove(); };
  }, [scope]));
}
