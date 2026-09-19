import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const { createHarness, deferred } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const screens: any[] = [];
const token = 'A'.repeat(32);
function setup() {
  const requests: any[] = [];
  const location = { hash: `#${token}`, pathname: '/e', search: '' };
  const history: string[] = [];
  const h = createHarness(resolve('apps/mobile/app/e/index.tsx'), undefined, {}, {
    __globals: { window: { location, history: { replaceState: (_state: unknown, _title: string, url: string) => {
      history.push(url); location.hash = '';
    } } }, fetch: (url: string, options: any) => {
      const gate = deferred(); requests.push({ url, options, ...gate }); return gate.promise;
    } },
    'react-native': { Platform: { OS: 'web' }, Linking: {}, ScrollView: 'ScrollView', View: 'View', Pressable: 'Pressable' },
    '@dawaee/shared': { PALETTE: { primary600: '#075' } },
    '@/api/client': { api: { baseUrl: 'https://example.test' } },
  });
  screens.push(h); return { h, requests, location, history };
}
const card = { patientName: 'Synthetic patient', bloodType: null, allergies: [], conditionsNote: null,
  emergencyContacts: [], medications: [], notice: 'User provided' };
afterEach(() => { for (const h of screens.splice(0)) h.unmount(); });
describe('public emergency scan recovery without widening disclosure', () => {
  it('retries after fragment removal using only the mounted capability and shows neutral missing information', async () => {
    const { h, requests, location, history } = setup(); await h.flush();
    expect(location.hash).toBe(''); expect(history).toEqual(['/e']);
    requests[0].reject(new Error('network')); await h.flush();
    const retry = h.find('Pressable', (p: any) => p.testID === 'emergency-scan-retry');
    expect(retry).toBeTruthy(); retry.onPress(); await h.flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe('https://example.test/v1/emergency/scan/card');
    expect(requests[1].options.headers.authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(history)).not.toContain(token);
    requests[1].resolve({ ok: true, json: async () => card }); await h.flush();
    expect(h.text()).toContain('No allergy information displayed');
    expect(h.text()).not.toContain('None recorded');
    expect(h.text()).not.toContain(token);
  });
  it.each([429, 503])('keeps HTTP%s retryable without claiming that the code was disabled', async status => {
    const { h, requests } = setup(); await h.flush();
    requests[0].resolve({ ok: false, status }); await h.flush();
    expect(h.find('Pressable')).toBeTruthy();
    expect(h.text()).not.toContain('This emergency code is not active');
  });
  it('does not offer a retry for a server-rejected capability and aborts work when closed', async () => {
    const { h, requests } = setup(); await h.flush();
    requests[0].resolve({ ok: false, status: 404 }); await h.flush();
    expect(h.find('Pressable')).toBeNull();
    h.unmount(); expect(requests[0].options.signal.aborted).toBe(true);
  });
});
