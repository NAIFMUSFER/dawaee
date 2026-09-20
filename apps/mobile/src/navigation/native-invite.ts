/** Capture native system-link input before the router discards its fragment.
 * Only the latest process-local selection is retained; no token enters route
 * params, logs, browser storage or a second URL. */
interface Selection { revision: number; token: string }
let selection: Selection | null = null;
let revision = 0;
const listeners = new Set<() => void>();
export const getNativeInviteSelection = (): Selection | null => selection;
export function subscribeNativeInvite(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function clearNativeInviteSelection(selected: Selection): void {
  if (selection === selected) selection = null;
}

export function redirectInviteSystemPath(path: string, origin: string, schemes: readonly string[]): string | null {
  try {
    const base = new URL(origin);
    const url = new URL(path, base);
    const sameOrigin = url.protocol === 'https:' && url.origin === base.origin;
    const native = schemes.some(scheme => url.protocol === `${scheme}:`);
    const invitePath = url.pathname === '/invite' && (sameOrigin || (native && !url.host))
      || native && url.hostname === 'invite' && (url.pathname === '' || url.pathname === '/');
    if (!invitePath || url.username || url.password || url.search) return path;
    let token: string;
    try { token = decodeURIComponent(url.hash.slice(1)); } catch { return null; }
    if (token.startsWith('/invite/')) token = token.slice('/invite/'.length);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
    selection = Object.freeze({ revision: ++revision, token });
    for (const listener of listeners) listener();
    return '/invite';
  } catch { return path; }
}
