/**
 * Drives the real server through a medication and note lifecycle, with the
 * real logger writing to the real stdout, so the calling test can read what
 * the process actually emitted.
 *
 * Run as a subprocess on purpose: pino writes to file descriptor 1 through
 * sonic-boom, not through `process.stdout.write`, so a monkey-patch inside the
 * test process captures nothing. A subprocess is the only honest way to read
 * what a deployed instance would write.
 */
import { startHarness, signIn, authHeaders, PANADOL } from '../harness.js';

const h = await startHarness();
const user = await signIn(h, '+966500778001');
const ip = () => `198.51.104.${Math.floor(Math.random() * 250) + 1}`;

const med = await h.app.inject({
  method: 'POST', url: '/v1/medications', headers: authHeaders(user), remoteAddress: ip(),
  payload: {
    patientProfileId: user.profileId,
    ...PANADOL,
    name: 'Zoprexa-Probe-Med',
    doctorInstructions: 'probe-doctor-says',
    startDate: '2026-09-01',
    schedule: {
      rule: { kind: 'fixed_times', times: ['08:00', '20:00'] },
      doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
    },
  },
});

await h.app.inject({
  method: 'PUT', url: `/v1/emergency/card?profileId=${user.profileId}`,
  headers: authHeaders(user), remoteAddress: ip(),
  payload: { bloodType: 'O+', allergies: ['probe-penicillin'] },
});

const doses = await h.app.inject({
  method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2026-09-30`,
  headers: authHeaders(user), remoteAddress: ip(),
});
const first = doses.json<{ doses: Array<{ id: string }> }>().doses[0];

if (first) {
  // A dose confirmation carrying a symptom note — the `note: { text }` shape
  // the redaction config originally missed.
  await h.app.inject({
    method: 'POST', url: `/v1/doses/${first.id}/taken`, headers: authHeaders(user), remoteAddress: ip(),
    payload: { clientEventId: 'probe-event-0001', note: { tags: ['dizziness'], text: 'probe-felt-dizzy-note' } },
  });
}

await h.app.inject({
  method: 'POST', url: `/v1/notes?profileId=${user.profileId}`, headers: authHeaders(user), remoteAddress: ip(),
  payload: { profileId: user.profileId, tags: ['nausea'], text: 'probe-felt-dizzy-note' },
});

// A scan of the emergency card, whose token is a bearer capability in the path.
const qr = await h.app.inject({
  method: 'POST', url: `/v1/emergency/qr/enable?profileId=${user.profileId}`,
  headers: authHeaders(user), remoteAddress: ip(),
});
if (qr.statusCode === 200) {
  const { token } = qr.json<{ token: string }>();
  await h.app.inject({ method: 'GET', url: `/v1/emergency/scan/${token}`, remoteAddress: ip() });
}

// Errors, too: a 500-shaped failure is where an unredacted error object would
// surface, so the probe provokes one rather than only exercising happy paths.
await h.app.inject({
  method: 'POST', url: `/v1/notes?profileId=${user.profileId}`, headers: authHeaders(user), remoteAddress: ip(),
  payload: {
    profileId: user.profileId, doseOccurrenceId: '00000000-0000-4000-8000-000000000000',
    tags: ['nausea'], text: 'probe-felt-dizzy-note',
  },
});

// Registering the same phone again, so a unique violation with the number in
// its `detail` is raised on a real code path.
await h.app.inject({
  method: 'POST', url: '/v1/auth/register', remoteAddress: ip(),
  payload: { phone: user.phone, displayName: 'dup', password: 'correct horse battery staple', deviceId: 'dup-device' },
});

void med;
await h.close();
process.exit(0);
