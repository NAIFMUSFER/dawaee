type Listener = (profileId: string | null) => void;
const listeners = new Set<Listener>();
export function subscribeAccessDenied(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Only authenticated, current-session refusals reach this boundary. */
export function notifyAccessDenied(profileId: string | null): void {
  for (const listener of listeners) {
    try { listener(profileId); } catch { /* Preserve the original API error. */ }
  }
}
