// One non-identifying timestamp in process memory, so the success receipt
// survives immediate sign-out without leaving account data in URL/storage.
let scheduledFor: string | null = null;
const listeners = new Set<() => void>();
export const getDeletionReceipt = () => scheduledFor;
export function setDeletionReceipt(value: string | null): void {
  scheduledFor = value && Number.isFinite(Date.parse(value)) ? value : null;
  for (const listener of listeners) listener();
}
export function subscribeDeletionReceipt(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
