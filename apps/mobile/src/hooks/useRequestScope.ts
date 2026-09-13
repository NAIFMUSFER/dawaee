import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ProfileSummary } from '../api/types.js';

/** Key the clinical view, not the navigator: old patient data and filters must
 * disappear in the first render, before a passive loading effect can run. */
export function profileScopeKey(userId: string | undefined, profile: ProfileSummary | null): string {
  return JSON.stringify([
    userId, profile?.id, profile?.isSelf, profile?.timezone,
    [...(profile?.permissions ?? [])].sort(),
  ]);
}

/**
 * A request belongs to one mounted screen/query context. A profile key change
 * unmounts that screen; query changes invalidate at render, not after an effect.
 * `begin` additionally makes the most recently started load the only writer.
 * `capture` fences action UI without dropping an already-started dose action.
 */
export function useRequestScope(contextKey = '') {
  const ref = useRef({ key: contextKey, epoch: 0, request: 0, active: true });
  if (ref.current.key !== contextKey) {
    ref.current = { key: contextKey, epoch: 0, request: 0, active: true };
  }
  const context = ref.current;

  useLayoutEffect(() => {
    context.active = true;
    return () => { context.active = false; context.epoch++; };
  }, [context]);

  const capture = useCallback(() => {
    const epoch = context.epoch;
    return () => ref.current === context && context.active && context.epoch === epoch;
  }, [context]);

  const begin = useCallback(() => {
    const isCurrent = capture();
    const request = ++context.request;
    return () => isCurrent() && context.request === request;
  }, [capture, context]);

  return useMemo(() => ({ begin, capture }), [begin, capture]);
}
