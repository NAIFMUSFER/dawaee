type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeClinicalChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** No patient data in events. A successful write invalidates authorized reads. */
export function notifyClinicalChange(method: string, path: string): void {
  if (method === 'GET' || !/^\/v1\/(medications?|schedules?|doses?|sync|notes|caregivers|profiles?)(?:\/|$)/.test(path)) return;
  for (const listener of listeners) {
    // A view failure must never turn a committed write into an apparent error.
    try { listener(); } catch { /* The next focus refresh will retry the view. */ }
  }
}
