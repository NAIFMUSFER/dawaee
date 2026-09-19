import { api, DEMO_MODE, NetworkError } from './client.js';

const MAX_WAIT_MS = 75_000;
const PROBE_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_500;

function cancelled(): Error { return new Error('Authentication screen closed'); }

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Wait only with anonymous, read-only probes. Never retry a credential POST:
 * a lost response cannot establish whether registration already committed. */
export async function waitForAuthServer(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw cancelled();
  if (DEMO_MODE) return;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
    let retry = true;
    try {
      const response = await fetch(`${api.baseUrl}/health`, {
        method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { status?: string; service?: string } | null;
        if (signal.aborted) throw cancelled();
        if (body?.status === 'ok' && body.service === 'dawaee-api') return;
        // A hosting wake-up HTML page is not an acknowledgement from the API.
      } else {
        retry = response.status >= 500;
      }
    } catch {
      if (signal.aborted) throw cancelled();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    if (!retry || Date.now() >= deadline) break;
    await pause(Math.min(RETRY_DELAY_MS, deadline - Date.now()), signal);
  }
  throw new NetworkError('Authentication service did not become reachable');
}
