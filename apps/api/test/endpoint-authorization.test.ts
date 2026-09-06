import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders, resetDatabase, signIn, startHarness, PANADOL, type Harness, type TestUser,
} from './harness.js';

/**
 * P12 — endpoint-wide authorization.
 *
 * The database half of this question already has a suite: `rls-matrix.test.ts`
 * proves that with a real id in hand, one patient's session cannot read or
 * write another's rows. That is the last line of defence and it holds.
 *
 * This suite asks the different question that sits above it. RLS only protects
 * a query that runs inside a user context; a handler that reaches Postgres
 * through `withTransaction` instead of `withUser` carries no `app.user_id`, so
 * its policies see no user and the application layer is the only thing left.
 * So the object here is the HTTP surface itself: every route, exercised as a
 * real request, by a real second account holding real ids belonging to the
 * first.
 *
 * The inventory is taken from Fastify's own route table at runtime rather than
 * from a hand-kept list, because the requirement is that no endpoint is
 * omitted, and a hand-kept list silently stops being true the first time
 * somebody adds a route.
 */

let h: Harness;
/** Patient A — the attacker in every case below. */
let alice: TestUser;
/** Patient B — unrelated to A, and the owner of every id A will try. */
let bob: TestUser;
let admin: TestUser;

const bobIds = {
  profileId: '', medicationId: '', scheduleId: '', doseId: '', relationshipId: '',
  emergencyToken: '', deviceId: '',
};

const BOGUS_UUID = '00000000-0000-4000-8000-000000000000';

async function createMedication(user: TestUser) {
  const res = await send({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId, ...PANADOL, startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '20:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ medication: { id: string }; scheduleId: string }>();
}

/**
 * Fastify prints its routes as a radix tree with shared prefixes collapsed, so
 * a full path is the concatenation of a node's ancestors. Reconstructing it
 * this way — rather than reading the source — is what makes the count below an
 * assertion about the running server.
 */
export function parseRouteTable(tree: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const marker = line.search(/[├└]── /);
    if (marker < 0) continue;
    const depth = marker / 4;
    const rest = line.slice(marker + 4);
    const withMethods = rest.match(/^(.*?) \(([^)]*)\)\s*$/);
    const segment = withMethods ? withMethods[1]! : rest;
    const methods = withMethods ? withMethods[2]!.split(', ') : [];
    stack.length = depth;
    stack[depth] = segment;
    const path = stack.join('');
    for (const method of methods) out.push({ method, path });
  }
  return out;
}

/**
 * A distinct source address per request.
 *
 * The global limiter allows 300 requests a minute per client address, and this
 * suite makes several hundred. Without this it would exhaust its own budget
 * partway through and report 429 where it meant to report "denied" — which is
 * how a rate-limited run can look like a passing authorization matrix. Setting
 * the injected socket address (not a header) is the honest simulation: these
 * are genuinely different clients. Address-keyed limiting is P5/P7's subject
 * and is tested there; the subject here is authorization.
 */
let probeCounter = 0;
function probeAddress(): string {
  probeCounter += 1;
  return `198.51.${Math.floor(probeCounter / 254) % 254}.${(probeCounter % 253) + 1}`;
}

type InjectArgs = Parameters<Harness['app']['inject']>[0] & object;
/** Every request in this file goes through here, so none of them can forget. */
function send(args: InjectArgs) {
  return h.app.inject({ remoteAddress: probeAddress(), ...(args as object) } as InjectArgs);
}

type Exposure =
  /** Reachable with no credentials, by design. */
  | 'public'
  /** Unauthenticated, but gated by a bearer capability in the path or query. */
  | 'capability'
  /** Part of the pre-authentication auth plane: there is no session yet. */
  | 'auth-plane'
  /** Requires a session. */
  | 'authenticated'
  /** Requires a session whose token carries the admin role. */
  | 'admin';

/**
 * Every route the server exposes, and what is supposed to stand in front of it.
 *
 * A route missing from this map fails the inventory test rather than being
 * quietly skipped — that is the mechanism by which "no endpoint is omitted"
 * stays true after this audit is over.
 */
const EXPOSURE: Record<string, Exposure> = {
  'GET /': 'public',
  'GET /health': 'public',
  'GET /health/ready': 'public',
  'GET /app': 'public',

  'POST /v1/auth/otp/request': 'auth-plane',
  'POST /v1/auth/otp/verify': 'auth-plane',
  'POST /v1/auth/register': 'auth-plane',
  'POST /v1/auth/refresh': 'auth-plane',
  'POST /v1/auth/login': 'auth-plane',
  'POST /v1/auth/logout': 'authenticated',
  'POST /v1/auth/logout-all': 'authenticated',
  'POST /v1/auth/password': 'authenticated',
  'GET /v1/auth/sessions': 'authenticated',

  'GET /v1/adherence': 'authenticated',
  'GET /v1/admin/overview': 'admin',
  'GET /v1/admin/deliveries/failed': 'admin',
  'GET /v1/admin/deliveries/stats': 'admin',
  'GET /v1/admin/jobs': 'admin',
  'GET /v1/admin/webhooks/unprocessed': 'admin',

  'POST /v1/devices/push-token': 'authenticated',
  'DELETE /v1/devices/push-token/:deviceId': 'authenticated',

  'GET /v1/doses': 'authenticated',
  'POST /v1/doses/sync': 'authenticated',
  'GET /v1/doses/:doseId': 'authenticated',
  'POST /v1/doses/:doseId/taken': 'authenticated',
  'POST /v1/doses/:doseId/snooze': 'authenticated',
  'POST /v1/doses/:doseId/skip': 'authenticated',
  'POST /v1/doses/:doseId/undo': 'authenticated',

  'GET /v1/me': 'authenticated',
  'PATCH /v1/me': 'authenticated',
  'PATCH /v1/me/preferences': 'authenticated',
  'PUT /v1/me/consents': 'authenticated',
  'POST /v1/me/deletion-request': 'authenticated',

  'GET /v1/medications': 'authenticated',
  'POST /v1/medications': 'authenticated',
  'POST /v1/medications/check-duplicate': 'authenticated',
  'GET /v1/medications/:medicationId': 'authenticated',
  'PATCH /v1/medications/:medicationId': 'authenticated',
  'DELETE /v1/medications/:medicationId': 'authenticated',
  'POST /v1/medications/:medicationId/schedules': 'authenticated',
  'GET /v1/medications/:medicationId/stock': 'authenticated',
  'PUT /v1/medications/:medicationId/stock': 'authenticated',
  'POST /v1/medications/:medicationId/refill': 'authenticated',

  'GET /v1/measurements': 'authenticated',
  'POST /v1/measurements': 'authenticated',
  'GET /v1/notes': 'authenticated',
  'POST /v1/notes': 'authenticated',

  'GET /v1/profiles': 'authenticated',
  'POST /v1/profiles': 'authenticated',
  'GET /v1/profiles/:profileId': 'authenticated',
  'PATCH /v1/profiles/:profileId': 'authenticated',
  'POST /v1/profiles/:profileId/timezone-check': 'authenticated',
  'POST /v1/profiles/:profileId/timezone-decision': 'authenticated',

  'PATCH /v1/schedules/:scheduleId': 'authenticated',
  'DELETE /v1/schedules/:scheduleId': 'authenticated',

  'GET /v1/stock/low': 'authenticated',
  'GET /v1/today': 'authenticated',

  'GET /v1/care-circle': 'authenticated',
  'POST /v1/caregivers/invite': 'authenticated',
  'POST /v1/caregivers/accept': 'authenticated',
  'DELETE /v1/caregivers/:relationshipId': 'authenticated',
  'PATCH /v1/caregivers/:relationshipId/permissions': 'authenticated',
  'PUT /v1/caregivers/:relationshipId/notification-rules': 'authenticated',

  'GET /v1/escalation-policy': 'authenticated',
  'PUT /v1/escalation-policy': 'authenticated',

  'GET /v1/emergency/card': 'authenticated',
  'PUT /v1/emergency/card': 'authenticated',
  'POST /v1/emergency/qr/enable': 'authenticated',
  'POST /v1/emergency/qr/disable': 'authenticated',
  // Deliberately unauthenticated: the token in the path IS the credential, and
  // a paramedic holding the card has no account. Audited in full under P11.
  'GET /v1/emergency/scan/:token': 'capability',

  'POST /v1/uploads/request': 'authenticated',
  'GET /v1/uploads/url': 'authenticated',
  'POST /v1/ocr/analyze': 'authenticated',
  // Development storage sink only; `STORAGE_PROVIDER=local` is refused in
  // production (config.ts). The query-string signature is the credential.
  'PUT /v1/uploads/local/:objectKey': 'capability',
  'GET /v1/uploads/local/:objectKey': 'capability',

  'GET /v1/reports/weekly': 'authenticated',
  'GET /v1/reports/adherence': 'authenticated',
  'GET /v1/reports/clinician': 'authenticated',
  'GET /v1/reports/export': 'authenticated',
};

function isStaticAsset(path: string): boolean {
  return path.startsWith('/_expo/');
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();

  alice = await signIn(h, '+966500090001');
  bob = await signIn(h, '+966500090002');
  admin = await signIn(h, '+966500090003');

  // Admin is a database fact, not something a request can ask for. Set as the
  // owner, exactly as an operator would, then re-authenticate so the claim is
  // in the token.
  execFileSync('psql', ['-d', 'dawaee_test', '-c',
    `UPDATE users SET is_admin = true WHERE id = '${admin.userId}'`], {
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    stdio: 'pipe',
  });
  const refreshed = await send({
    method: 'POST', url: '/v1/auth/refresh', remoteAddress: '10.99.99.1',
    payload: { refreshToken: admin.refreshToken },
  });
  expect(refreshed.statusCode, refreshed.body).toBe(200);
  admin = { ...admin, token: refreshed.json<{ accessToken: string }>().accessToken };

  // Everything Patient A will later try to reach, all of it Patient B's.
  bobIds.profileId = bob.profileId;
  const med = await createMedication(bob);
  bobIds.medicationId = med.medication.id;
  bobIds.scheduleId = med.scheduleId;

  const doses = await send({
    method: 'GET',
    url: `/v1/doses?profileId=${bob.profileId}&from=2026-09-01&to=2026-09-30`,
    headers: authHeaders(bob),
  });
  expect(doses.statusCode, doses.body).toBe(200);
  bobIds.doseId = doses.json<{ doses: Array<{ id: string }> }>().doses[0]!.id;

  const qr = await send({
    method: 'POST', url: `/v1/emergency/qr/enable?profileId=${bob.profileId}`,
    headers: authHeaders(bob),
  });
  expect(qr.statusCode, qr.body).toBe(200);
  bobIds.emergencyToken = qr.json<{ token: string }>().token;

  // A caregiver relationship that belongs to B's circle and has nothing to do
  // with A. B invites the admin account purely so a third party fills the role.
  const invite = await send({
    method: 'POST', url: '/v1/caregivers/invite', headers: authHeaders(bob),
    payload: {
      patientProfileId: bob.profileId, invitedName: 'Third party',
      invitedPhone: admin.phone, role: 'caregiver',
      permissions: ['view_schedule'], escalationPriority: 1,
    },
  });
  expect(invite.statusCode, invite.body).toBe(200);
  bobIds.relationshipId = invite.json<{ relationshipId: string }>().relationshipId;

  bobIds.deviceId = `bob-device-${Date.now()}`;
  const dev = await send({
    method: 'POST', url: '/v1/devices/push-token', headers: authHeaders(bob),
    payload: { deviceId: bobIds.deviceId, token: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', platform: 'ios' },
  });
  expect(dev.statusCode, dev.body).toBe(200);
}, 180_000);

afterAll(async () => {
  await h.close();
});

// ---------------------------------------------------------------------------

describe('P12-1 the inventory covers the whole surface', () => {
  it('classifies every route the server actually registers', () => {
    const routes = parseRouteTable(h.app.printRoutes({ commonPrefix: false }))
      .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .filter((r) => !isStaticAsset(r.path));

    const unclassified = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !(key in EXPOSURE));

    expect(unclassified, 'routes exist that this audit never considered').toEqual([]);
  });

  it('has no entry for a route that no longer exists', () => {
    const live = new Set(
      parseRouteTable(h.app.printRoutes({ commonPrefix: false }))
        .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
        .map((r) => `${r.method} ${r.path}`),
    );
    expect(Object.keys(EXPOSURE).filter((k) => !live.has(k))).toEqual([]);
  });

  it('finds the surface it expects to find', () => {
    const routes = parseRouteTable(h.app.printRoutes({ commonPrefix: false }))
      .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .filter((r) => !isStaticAsset(r.path));
    // A floor, not an equality: adding a route should not fail this test, it
    // should fail the classification test above, which says something useful.
    expect(routes.length).toBeGreaterThanOrEqual(77);
  });
});

describe('P12-2 nothing that needs a session is reachable without one', () => {
  it('refuses every authenticated and admin route with no credentials', async () => {
    const failures: string[] = [];
    for (const [key, exposure] of Object.entries(EXPOSURE)) {
      if (exposure !== 'authenticated' && exposure !== 'admin') continue;
      const [method, template] = key.split(' ') as [string, string];
      const url = template.replace(/:\w+/g, BOGUS_UUID);
      const res = await send({
        method: method as 'GET', url,
        payload: method === 'GET' || method === 'DELETE' ? undefined : {},
      });
      if (res.statusCode !== 401) failures.push(`${key} -> ${res.statusCode}`);
    }
    expect(failures, 'these routes answered without a session').toEqual([]);
  }, 120_000);

  it('refuses them with a structurally valid but forged bearer token', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJzaWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYWRtaW4ifQ.not-a-real-signature';
    const failures: string[] = [];
    for (const [key, exposure] of Object.entries(EXPOSURE)) {
      if (exposure !== 'authenticated' && exposure !== 'admin') continue;
      const [method, template] = key.split(' ') as [string, string];
      const res = await send({
        method: method as 'GET', url: template.replace(/:\w+/g, BOGUS_UUID),
        headers: { authorization: `Bearer ${forged}` },
        payload: method === 'GET' || method === 'DELETE' ? undefined : {},
      });
      if (res.statusCode !== 401) failures.push(`${key} -> ${res.statusCode}`);
    }
    expect(failures, 'a forged token was accepted').toEqual([]);
  }, 120_000);
});

describe('P12-3 admin routes are not reachable by an ordinary account', () => {
  it('answers 403, not 200, for a signed-in non-admin', async () => {
    const adminRoutes = Object.entries(EXPOSURE).filter(([, e]) => e === 'admin');
    expect(adminRoutes.length).toBeGreaterThan(0);
    for (const [key] of adminRoutes) {
      const [method, path] = key.split(' ') as [string, string];
      const res = await send({ method: method as 'GET', url: path, headers: authHeaders(alice) });
      expect(res.statusCode, `${key} answered an ordinary account`).toBe(403);
    }
  });

  it('and the account cannot promote itself through the profile update route', async () => {
    const res = await send({
      method: 'PATCH', url: '/v1/me', headers: authHeaders(alice),
      payload: { displayName: 'Alice', isAdmin: true, is_admin: true, role: 'admin' },
    });
    expect([200, 400]).toContain(res.statusCode);

    const rows = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT is_admin FROM users WHERE id = '${alice.userId}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();
    expect(rows, 'the account promoted itself to administrator').toBe('f');
  });

  it('positive control: the admin account does reach them', async () => {
    for (const [key, exposure] of Object.entries(EXPOSURE)) {
      if (exposure !== 'admin') continue;
      const [method, path] = key.split(' ') as [string, string];
      const res = await send({ method: method as 'GET', url: path, headers: authHeaders(admin) });
      expect(res.statusCode, `${key}: ${res.body}`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * The BOLA matrix.
 *
 * Every entry is a request Patient A is entitled to make in general, aimed at
 * an object belonging to Patient B. A must be refused every time, and must be
 * refused in a way that does not distinguish "B's object exists" from "no such
 * object" — otherwise the API is an existence oracle for other patients' ids.
 */
interface Attempt {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: () => string;
  payload?: () => unknown;
}

const ATTEMPTS: Attempt[] = [
  { name: 'read B’s profile', method: 'GET', url: () => `/v1/profiles/${bobIds.profileId}` },
  { name: 'rename B’s profile', method: 'PATCH', url: () => `/v1/profiles/${bobIds.profileId}`, payload: () => ({ displayName: 'taken over' }) },
  { name: 'probe B’s timezone', method: 'POST', url: () => `/v1/profiles/${bobIds.profileId}/timezone-check`, payload: () => ({ deviceTimezone: 'Europe/Berlin' }) },
  { name: 'decide B’s timezone', method: 'POST', url: () => `/v1/profiles/${bobIds.profileId}/timezone-decision`, payload: () => ({ decision: 'keep_home' }) },

  { name: 'list B’s medications', method: 'GET', url: () => `/v1/medications?profileId=${bobIds.profileId}` },
  { name: 'read B’s medication', method: 'GET', url: () => `/v1/medications/${bobIds.medicationId}` },
  { name: 'edit B’s medication', method: 'PATCH', url: () => `/v1/medications/${bobIds.medicationId}`, payload: () => ({ notes: 'taken over' }) },
  { name: 'delete B’s medication', method: 'DELETE', url: () => `/v1/medications/${bobIds.medicationId}` },
  { name: 'add a schedule to B’s medication', method: 'POST', url: () => `/v1/medications/${bobIds.medicationId}/schedules`, payload: () => ({ rule: { kind: 'fixed_times', times: ['09:00'] }, doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01' }) },
  { name: 'read B’s stock', method: 'GET', url: () => `/v1/medications/${bobIds.medicationId}/stock` },
  { name: 'change B’s stock', method: 'PUT', url: () => `/v1/medications/${bobIds.medicationId}/stock`, payload: () => ({ trackingEnabled: true, remainingQuantity: 1 }) },
  { name: 'refill B’s medication', method: 'POST', url: () => `/v1/medications/${bobIds.medicationId}/refill`, payload: () => ({ quantityAdded: 30, unit: 'tablet' }) },
  { name: 'duplicate-check against B’s profile', method: 'POST', url: () => '/v1/medications/check-duplicate', payload: () => ({ patientProfileId: bobIds.profileId, name: 'Panadol' }) },
  { name: 'create a medication on B’s profile', method: 'POST', url: () => '/v1/medications', payload: () => ({ patientProfileId: bobIds.profileId, ...PANADOL, startDate: '2026-09-01', schedule: { rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01' } }) },

  { name: 'edit B’s schedule', method: 'PATCH', url: () => `/v1/schedules/${bobIds.scheduleId}`, payload: () => ({ doseQuantity: 99 }) },
  { name: 'delete B’s schedule', method: 'DELETE', url: () => `/v1/schedules/${bobIds.scheduleId}` },

  { name: 'list B’s doses', method: 'GET', url: () => `/v1/doses?profileId=${bobIds.profileId}&from=2026-09-01&to=2026-09-30` },
  { name: 'read B’s dose', method: 'GET', url: () => `/v1/doses/${bobIds.doseId}` },
  { name: 'confirm B’s dose', method: 'POST', url: () => `/v1/doses/${bobIds.doseId}/taken`, payload: () => ({}) },
  { name: 'snooze B’s dose', method: 'POST', url: () => `/v1/doses/${bobIds.doseId}/snooze`, payload: () => ({ minutes: 10 }) },
  { name: 'skip B’s dose', method: 'POST', url: () => `/v1/doses/${bobIds.doseId}/skip`, payload: () => ({}) },
  { name: 'undo B’s dose', method: 'POST', url: () => `/v1/doses/${bobIds.doseId}/undo`, payload: () => ({}) },

  { name: 'read B’s notes', method: 'GET', url: () => `/v1/notes?profileId=${bobIds.profileId}` },
  { name: 'write a note on B’s profile', method: 'POST', url: () => `/v1/notes?profileId=${bobIds.profileId}`, payload: () => ({ profileId: bobIds.profileId, tags: ['nausea'], text: 'injected' }) },
  { name: 'read B’s measurements', method: 'GET', url: () => `/v1/measurements?profileId=${bobIds.profileId}` },
  { name: 'write a measurement on B’s profile', method: 'POST', url: () => `/v1/measurements?profileId=${bobIds.profileId}`, payload: () => ({ profileId: bobIds.profileId, type: 'weight', valuePrimary: 70, unit: 'kg', measuredAt: '2026-09-01T08:00:00.000Z' }) },

  { name: 'read B’s adherence', method: 'GET', url: () => `/v1/adherence?profileId=${bobIds.profileId}&from=2026-09-01&to=2026-09-30` },
  { name: 'read B’s low stock', method: 'GET', url: () => `/v1/stock/low?profileId=${bobIds.profileId}` },
  { name: 'read B’s weekly report', method: 'GET', url: () => `/v1/reports/weekly?profileId=${bobIds.profileId}` },
  { name: 'read B’s adherence report', method: 'GET', url: () => `/v1/reports/adherence?profileId=${bobIds.profileId}&from=2026-09-01&to=2026-09-30` },
  { name: 'read B’s clinician report', method: 'GET', url: () => `/v1/reports/clinician?profileId=${bobIds.profileId}&from=2026-09-01&to=2026-09-30` },
  { name: 'export B’s whole record', method: 'GET', url: () => `/v1/reports/export?profileId=${bobIds.profileId}` },

  { name: 'read B’s emergency card', method: 'GET', url: () => `/v1/emergency/card?profileId=${bobIds.profileId}` },
  { name: 'rewrite B’s emergency card', method: 'PUT', url: () => `/v1/emergency/card?profileId=${bobIds.profileId}`, payload: () => ({ bloodType: 'O+', allergies: ['injected'] }) },
  { name: 'mint a QR for B', method: 'POST', url: () => `/v1/emergency/qr/enable?profileId=${bobIds.profileId}` },
  { name: 'revoke B’s QR', method: 'POST', url: () => `/v1/emergency/qr/disable?profileId=${bobIds.profileId}` },

  { name: 'revoke a caregiver in B’s circle', method: 'DELETE', url: () => `/v1/caregivers/${bobIds.relationshipId}` },
  { name: 'widen a caregiver in B’s circle', method: 'PATCH', url: () => `/v1/caregivers/${bobIds.relationshipId}/permissions`, payload: () => ({ permissions: ['view_schedule', 'view_history', 'edit_medications'] }) },
  { name: 'retune notifications in B’s circle', method: 'PUT', url: () => `/v1/caregivers/${bobIds.relationshipId}/notification-rules`, payload: () => ({ notifyOnMissed: true }) },
  { name: 'read B’s care circle', method: 'GET', url: () => `/v1/care-circle?profileId=${bobIds.profileId}` },
  { name: 'read B’s escalation policy', method: 'GET', url: () => `/v1/escalation-policy?profileId=${bobIds.profileId}` },
  { name: 'rewrite B’s escalation policy', method: 'PUT', url: () => `/v1/escalation-policy?profileId=${bobIds.profileId}`, payload: () => ({ enabled: true, delayMinutes: 5 }) },

];

/**
 * `DELETE /v1/devices/push-token/:deviceId` is deliberately not in the table
 * above, because a status code cannot answer the question for it. The handler
 * updates `WHERE user_id = $1 AND device_id = $2` with the caller's own id, so
 * Patient A's request matches zero rows and returns `{ok:true}` — a vacuous
 * success, not a cross-tenant write. That is also the non-leaking behaviour:
 * the response is identical whether or not the device exists. The only honest
 * assertion is on the row itself.
 */
const DEVICE_ATTEMPT = {
  name: 'unregister B’s device',
  url: () => `/v1/devices/push-token/${bobIds.deviceId}`,
};

describe('P12-4 Patient A holding Patient B’s real ids', () => {
  it('is refused on every route, with a status that is not a success', async () => {
    const leaks: string[] = [];
    for (const a of ATTEMPTS) {
      const res = await send({
        method: a.method, url: a.url(), headers: authHeaders(alice),
        payload: a.payload ? a.payload() : a.method === 'GET' || a.method === 'DELETE' ? undefined : {},
      });
      if (res.statusCode < 400) leaks.push(`${a.name}: ${a.method} -> ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(leaks, 'Patient A reached Patient B').toEqual([]);
  }, 180_000);

  it('never returns Patient B’s medication name, profile name or emergency token in the body', async () => {
    const secrets = [PANADOL.name, bob.phone, bobIds.emergencyToken];
    const leaks: string[] = [];
    for (const a of ATTEMPTS) {
      const res = await send({
        method: a.method, url: a.url(), headers: authHeaders(alice),
        payload: a.payload ? a.payload() : a.method === 'GET' || a.method === 'DELETE' ? undefined : {},
      });
      for (const s of secrets) {
        if (s && res.body.includes(s)) leaks.push(`${a.name} leaked "${s.slice(0, 12)}…"`);
      }
    }
    expect(leaks).toEqual([]);
  }, 180_000);

  /**
   * The existence oracle. If B's real id answers 403 and a random id answers
   * 404, then A can enumerate which ids belong to somebody — which is the
   * finding, even though neither response carried data.
   */
  it('does not distinguish “B’s object” from “no such object”', async () => {
    const oracles: string[] = [];
    for (const a of ATTEMPTS) {
      const real = a.url();
      const fake = real
        .replace(bobIds.profileId, BOGUS_UUID)
        .replace(bobIds.medicationId, BOGUS_UUID)
        .replace(bobIds.scheduleId, BOGUS_UUID)
        .replace(bobIds.doseId, BOGUS_UUID)
        .replace(bobIds.relationshipId, BOGUS_UUID)
        .replace(bobIds.deviceId, 'no-such-device');
      if (fake === real) continue;

      const sendTo = (url: string) => send({
        method: a.method, url, headers: authHeaders(alice),
        payload: a.payload ? a.payload() : a.method === 'GET' || a.method === 'DELETE' ? undefined : {},
      });
      const [onReal, onFake] = [await sendTo(real), await sendTo(fake)];
      if (onReal.statusCode !== onFake.statusCode) {
        oracles.push(`${a.name}: real=${onReal.statusCode} absent=${onFake.statusCode}`);
      }
    }
    expect(oracles, 'the status code reveals whether another patient’s id exists').toEqual([]);
  }, 180_000);

  it('cannot silence Patient B’s device, whatever the status code says', async () => {
    const active = () => execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT active FROM push_tokens WHERE user_id = '${bob.userId}' AND device_id = '${bobIds.deviceId}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();

    expect(active(), 'setup: B’s device should start active').toBe('t');
    const res = await send({ method: 'DELETE', url: DEVICE_ATTEMPT.url(), headers: authHeaders(alice) });
    expect(active(), `A silenced B’s reminders (status ${res.statusCode})`).toBe('t');

    // Positive control: the owner can, so the row is genuinely reachable.
    await send({ method: 'DELETE', url: DEVICE_ATTEMPT.url(), headers: authHeaders(bob) });
    expect(active(), 'B could not deactivate B’s own device — the check above proves nothing').toBe('f');
  });

  it('positive control: every one of those requests succeeds for Patient B', async () => {
    // Without this, a route that is simply broken would pass the whole matrix
    // above by failing for everybody.
    const broken: string[] = [];
    const readOnly = ATTEMPTS.filter((a) => a.method === 'GET');
    expect(readOnly.length).toBeGreaterThan(10);
    for (const a of readOnly) {
      const res = await send({ method: 'GET', url: a.url(), headers: authHeaders(bob) });
      if (res.statusCode !== 200) broken.push(`${a.name} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    expect(broken, 'these routes fail for their own owner, so the denial above proves nothing').toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------

describe('P12-5 client-supplied fields cannot reassign ownership', () => {
  it('ignores an ownerUserId/userId/id smuggled into a profile creation', async () => {
    const res = await send({
      method: 'POST', url: '/v1/profiles', headers: authHeaders(alice),
      payload: {
        displayName: 'Mass assignment', relationship: 'parent', timezone: 'Asia/Riyadh',
        id: BOGUS_UUID, ownerUserId: bob.userId, owner_user_id: bob.userId,
        linkedUserId: bob.userId, linked_user_id: bob.userId, createdAt: '1999-01-01T00:00:00Z',
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const created = res.json<{ profile: { id: string } }>().profile.id;
    expect(created).not.toBe(BOGUS_UUID);
    const owner = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT owner_user_id, linked_user_id IS NULL, is_self FROM patient_profiles WHERE id = '${created}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();
    expect(owner, 'the created profile did not belong to its creator').toBe(`${alice.userId}|t|f`);
  });

  /**
   * `isSelf` is a legitimate schema field, so a client may send it — but only
   * one profile per account can be the account holder, and registration
   * already made one. The refusal comes from the database (the insert is
   * rejected under the caller's own RLS context and reported as a 404 so the
   * API cannot be used to probe), which is the right place for it: an
   * application-layer check alone could be bypassed by any future code path
   * that inserts a profile.
   */
  it('cannot mint a second “this is me” profile for the account', async () => {
    const res = await send({
      method: 'POST', url: '/v1/profiles', headers: authHeaders(alice),
      payload: { displayName: 'Second self', timezone: 'Asia/Riyadh', isSelf: true },
    });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);

    const count = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT count(*) FROM patient_profiles WHERE owner_user_id = '${alice.userId}' AND is_self`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();
    expect(count, 'the account has more than one self profile').toBe('1');
  });

  it('ignores a patientProfileId swap on a note whose profile is given in the query', async () => {
    const res = await send({
      method: 'POST', url: `/v1/notes?profileId=${alice.profileId}`, headers: authHeaders(alice),
      payload: { profileId: bobIds.profileId, patientProfileId: bobIds.profileId, tags: ['nausea'], text: 'ownership probe' },
    });
    // Whether it is accepted for A's own profile or rejected outright, the one
    // outcome that must not occur is a row landing on B's profile.
    const onBob = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT count(*) FROM symptom_notes WHERE patient_profile_id = '${bobIds.profileId}' AND text = 'ownership probe'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();
    expect(onBob, `a note landed on Patient B (status ${res.statusCode})`).toBe('0');
  });

  it('ignores unknown and privileged keys on the account update', async () => {
    const before = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT is_admin, disabled_at IS NULL FROM users WHERE id = '${alice.userId}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();

    await send({
      method: 'PATCH', url: '/v1/me', headers: authHeaders(alice),
      payload: { displayName: 'Alice', isAdmin: true, disabledAt: null, phone: bob.phone, phoneE164: bob.phone, id: bob.userId },
    });

    const after = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT is_admin, disabled_at IS NULL FROM users WHERE id = '${alice.userId}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();
    expect(after).toBe(before);

    // And the phone was not stolen from B.
    const bobPhoneStillBobs = execFileSync('psql', ['-d', 'dawaee_test', '-tAc',
      `SELECT count(*) FROM users WHERE id = '${alice.userId}' AND phone_e164 = '${bob.phone}'`], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
    }).toString().trim();
    expect(bobPhoneStillBobs).toBe('0');
  });
});

// ---------------------------------------------------------------------------

/**
 * Malformed input must be the caller's error, not the server's.
 *
 * This is not cosmetic. A 500 is logged as an unhandled error, so a single
 * mistyped query parameter both produces operational noise and tells the caller
 * they reached something the server did not expect — which is exactly the
 * signal an attacker probes for. Measured against Postgres 16, the handler
 * already mapped `22P02`, so a bad UUID or a bad enum value was correctly a
 * 400. Two classes were not mapped and did reach the 500 branch: `22007`
 * (malformed date) and `2201W` (negative LIMIT).
 */
describe('P12-6 malformed input is refused, not crashed into', () => {
  const CASES: Array<[string, string]> = [
    ['bad uuid in a path', `/v1/medications/not-a-uuid`],
    ['bad uuid in a query', `/v1/medications?profileId=not-a-uuid`],
    ['unknown enum value', `/v1/medications?profileId=${alicePlaceholder()}&status=wat`],
    ['negative limit', `/v1/doses?profileId=${alicePlaceholder()}&from=2026-09-01&to=2026-09-02&limit=-5`],
    ['non-numeric limit', `/v1/doses?profileId=${alicePlaceholder()}&from=2026-09-01&to=2026-09-02&limit=abc`],
    ['fractional limit', `/v1/doses?profileId=${alicePlaceholder()}&from=2026-09-01&to=2026-09-02&limit=1.5`],
    ['malformed date in a range', `/v1/notes?profileId=${alicePlaceholder()}&from=abc`],
    ['malformed report anchor', `/v1/reports/weekly?profileId=${alicePlaceholder()}&endDate=abc`],
    ['malformed report range', `/v1/reports/adherence?profileId=${alicePlaceholder()}&from=abc&to=def`],
    ['unbounded report range', `/v1/reports/clinician?profileId=${alicePlaceholder()}&from=0001-01-01&to=9999-12-31`],
    ['repeated limit parameter', `/v1/doses?profileId=${alicePlaceholder()}&from=2026-09-01&to=2026-09-02&limit=1&limit=2`],
    ['unknown measurement type', `/v1/measurements?profileId=${alicePlaceholder()}&type=wat`],
    ['unknown delivery channel', `/v1/admin/deliveries/failed?channel=wat`],
  ];

  // The placeholder is substituted at call time, because `alice` is only
  // populated in beforeAll and this table is built at module load.
  function alicePlaceholder() { return '__ALICE_PROFILE__'; }

  it('answers 4xx for every one of them', async () => {
    const crashes: string[] = [];
    for (const [name, template] of CASES) {
      const url = template.replace('__ALICE_PROFILE__', alice.profileId);
      const headers = url.includes('/admin/') ? authHeaders(admin) : authHeaders(alice);
      const res = await send({ method: 'GET', url, headers });
      if (res.statusCode >= 500) crashes.push(`${name} -> ${res.statusCode}`);
      if (res.statusCode < 400) crashes.push(`${name} -> ${res.statusCode} (accepted)`);
    }
    expect(crashes, 'malformed input reached the 500 branch or was accepted').toEqual([]);
  }, 120_000);

  /**
   * Naming the field is what separates edge validation from the database's own
   * refusal. Postgres already produced a 400 for a bad enum (via the `22P02`
   * mapping), so without this assertion the guards added on `status`,
   * `channel` and `type` would be untestable — the status code alone cannot
   * tell "refused at the edge" from "refused by the database". The message can.
   */
  it('names the offending field rather than answering generically', async () => {
    const cases: Array<[string, RegExp]> = [
      [`/v1/admin/deliveries/failed?channel=wat`, /channel/i],
      [`/v1/medications?profileId=__ALICE_PROFILE__&status=wat`, /status/i],
      [`/v1/measurements?profileId=__ALICE_PROFILE__&type=wat`, /type/i],
      [`/v1/notes?profileId=__ALICE_PROFILE__&from=abc`, /from/i],
      [`/v1/reports/weekly?profileId=__ALICE_PROFILE__&endDate=abc`, /endDate/i],
    ];
    for (const [template, expected] of cases) {
      const url = template.replace('__ALICE_PROFILE__', alice.profileId);
      const res = await send({
        method: 'GET', url,
        headers: url.includes('/admin/') ? authHeaders(admin) : authHeaders(alice),
      });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(400);
      const body = res.json<{ error: { message: string; details?: Array<{ path: string; message: string }> } }>();
      const text = `${body.error.message} ${JSON.stringify(body.error.details ?? [])}`;
      expect(text, `${url} gave no indication of which field was wrong`).toMatch(expected);
    }
  }, 60_000);

  it('says which field was wrong instead of “an unexpected error occurred”', async () => {
    const res = await send({
      method: 'GET',
      url: `/v1/doses?profileId=${alice.profileId}&from=2026-09-01&to=2026-09-02&limit=-5`,
      headers: authHeaders(alice),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/limit/i);
  });

  it('leaks no database detail in the message', async () => {
    for (const [, template] of CASES) {
      const url = template.replace('__ALICE_PROFILE__', alice.profileId);
      const headers = url.includes('/admin/') ? authHeaders(admin) : authHeaders(alice);
      const res = await send({ method: 'GET', url, headers });
      expect(res.body).not.toMatch(/invalid input syntax|bigint|pg_|SQLSTATE|relation "/i);
    }
  }, 120_000);

  it('positive control: the same requests with sound values succeed', async () => {
    const ok = [
      `/v1/medications?profileId=${alice.profileId}&status=active`,
      `/v1/doses?profileId=${alice.profileId}&from=2026-09-01&to=2026-09-02&limit=5`,
      `/v1/notes?profileId=${alice.profileId}&from=2026-09-01`,
      `/v1/reports/weekly?profileId=${alice.profileId}&endDate=2026-09-07`,
      `/v1/reports/adherence?profileId=${alice.profileId}&from=2026-09-01&to=2026-09-07`,
      `/v1/measurements?profileId=${alice.profileId}&type=weight`,
    ];
    for (const url of ok) {
      const res = await send({ method: 'GET', url, headers: authHeaders(alice) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
    const adminOk = await send({
      method: 'GET', url: '/v1/admin/deliveries/failed?channel=push&limit=10', headers: authHeaders(admin),
    });
    expect(adminOk.statusCode, adminOk.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('P12-7 the free-text note body is validated', () => {
  it('refuses a tag that is not one of the known symptoms', async () => {
    const res = await send({
      method: 'POST', url: `/v1/notes?profileId=${alice.profileId}`, headers: authHeaders(alice),
      payload: { profileId: alice.profileId, tags: ['<script>alert(1)</script>'], text: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a tags value that is not an array, rather than passing it to Postgres', async () => {
    const res = await send({
      method: 'POST', url: `/v1/notes?profileId=${alice.profileId}`, headers: authHeaders(alice),
      payload: { profileId: alice.profileId, tags: 'nausea', text: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('caps the free-text body', async () => {
    const res = await send({
      method: 'POST', url: `/v1/notes?profileId=${alice.profileId}`, headers: authHeaders(alice),
      payload: { profileId: alice.profileId, tags: [], text: 'x'.repeat(50_000) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('positive control: a well-formed note is still accepted and stored verbatim', async () => {
    const text = 'felt dizzy about an hour after';
    const res = await send({
      method: 'POST', url: `/v1/notes?profileId=${alice.profileId}`, headers: authHeaders(alice),
      payload: { profileId: alice.profileId, tags: ['dizziness'], text },
    });
    expect(res.statusCode, res.body).toBe(200);

    const list = await send({
      method: 'GET', url: `/v1/notes?profileId=${alice.profileId}`, headers: authHeaders(alice),
    });
    expect(list.json<{ notes: Array<{ text: string }> }>().notes.some((n) => n.text === text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * P12-8 — the owner path.
 *
 * A denial matrix proves nothing about a route that is broken for everybody,
 * and this is not hypothetical: `POST /v1/profiles` returned 404 to every
 * caller at the baseline commit and had no test anywhere in the suite, so the
 * whole family-care feature — adding a second patient — was unreachable and
 * nothing said so. The reason it stayed hidden is that the failure looks
 * exactly like a correct authorization denial from the outside.
 *
 * So every mutating route is walked here as its legitimate owner, in
 * dependency order, on an account created for this purpose. A route that is
 * broken now fails as a broken route rather than passing as a strict one.
 */
describe('P12-8 every route works for the person entitled to use it', () => {
  let carol: TestUser;
  const own = { profileId: '', medicationId: '', scheduleId: '', doseId: '', relationshipId: '' };

  beforeAll(async () => {
    carol = await signIn(h, '+966500090004');
  }, 60_000);

  const ok = async (label: string, args: InjectArgs) => {
    const res = await send({ headers: authHeaders(carol), ...(args as object) } as InjectArgs);
    expect(res.statusCode, `${label}: ${res.body}`).toBe(200);
    return res;
  };

  it('creates a second patient profile', async () => {
    const res = await ok('POST /v1/profiles', {
      method: 'POST', url: '/v1/profiles',
      payload: { displayName: 'Umm Naif', timezone: 'Asia/Riyadh', birthYear: 1955 },
    });
    own.profileId = res.json<{ profile: { id: string } }>().profile.id;
    expect(own.profileId).toBeTruthy();
    expect(own.profileId).not.toBe(carol.profileId);
  });

  it('reads and renames it', async () => {
    await ok('GET /v1/profiles/:id', { method: 'GET', url: `/v1/profiles/${own.profileId}` });
    await ok('PATCH /v1/profiles/:id', {
      method: 'PATCH', url: `/v1/profiles/${own.profileId}`, payload: { displayName: 'Umm Naif A.' },
    });
  });

  it('runs the timezone check and decision on it', async () => {
    await ok('POST timezone-check', {
      method: 'POST', url: `/v1/profiles/${own.profileId}/timezone-check`,
      payload: { deviceTimezone: 'Europe/London' },
    });
    await ok('POST timezone-decision', {
      method: 'POST', url: `/v1/profiles/${own.profileId}/timezone-decision`,
      payload: { detectedTimezone: 'Europe/London', decision: 'keep_home_time' },
    });
  });

  it('adds a medication with a schedule and stock, then reads it back', async () => {
    const res = await ok('POST /v1/medications', {
      method: 'POST', url: '/v1/medications',
      payload: {
        patientProfileId: own.profileId, ...PANADOL, startDate: '2026-09-01',
        schedule: {
          rule: { kind: 'fixed_times', times: ['08:00', '20:00'] },
          doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
        },
        stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
      },
    });
    const body = res.json<{ medication: { id: string }; scheduleId: string }>();
    own.medicationId = body.medication.id;
    own.scheduleId = body.scheduleId;

    await ok('POST check-duplicate', {
      method: 'POST', url: '/v1/medications/check-duplicate',
      payload: { patientProfileId: own.profileId, name: 'Panadol' },
    });
    await ok('GET /v1/medications', { method: 'GET', url: `/v1/medications?profileId=${own.profileId}` });
    await ok('GET /v1/medications/:id', { method: 'GET', url: `/v1/medications/${own.medicationId}` });
    await ok('PATCH /v1/medications/:id', {
      method: 'PATCH', url: `/v1/medications/${own.medicationId}`, payload: { notes: 'after breakfast' },
    });
  });

  it('manages the stock on it', async () => {
    await ok('GET stock', { method: 'GET', url: `/v1/medications/${own.medicationId}/stock` });
    await ok('PUT stock', {
      method: 'PUT', url: `/v1/medications/${own.medicationId}/stock`,
      payload: { trackingEnabled: true, remainingQuantity: 20, unit: 'tablet' },
    });
    await ok('POST refill', {
      method: 'POST', url: `/v1/medications/${own.medicationId}/refill`,
      payload: { quantityAdded: 30, unit: 'tablet' },
    });
    await ok('GET /v1/stock/low', { method: 'GET', url: `/v1/stock/low?profileId=${own.profileId}` });
  });

  it('adds a second schedule and edits it', async () => {
    const res = await ok('POST schedules', {
      method: 'POST', url: `/v1/medications/${own.medicationId}/schedules`,
      payload: {
        rule: { kind: 'fixed_times', times: ['13:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
    });
    const extra = res.json<{ schedule?: { id: string }; id?: string }>();
    const extraId = extra.schedule?.id ?? extra.id;
    expect(extraId, `no schedule id in ${res.body}`).toBeTruthy();
    // A dose change is refused until the patient confirms it explicitly. That
    // is a medical-safety control, not a bug, so it is asserted rather than
    // stepped around — and then the confirmed form is asserted to succeed.
    const unconfirmed = await send({
      method: 'PATCH', url: `/v1/schedules/${extraId}`,
      headers: authHeaders(carol), payload: { doseQuantity: 2 },
    });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(409);
    expect(unconfirmed.json<{ error: { code: string } }>().error.code)
      .toBe('high_risk_confirmation_required');
    await ok('PATCH schedule (confirmed)', {
      method: 'PATCH', url: `/v1/schedules/${extraId}`,
      payload: { doseQuantity: 2, confirmHighRiskChange: true },
    });
    await ok('DELETE schedule', { method: 'DELETE', url: `/v1/schedules/${extraId}` });
  });

  it('confirms, snoozes, skips and undoes a dose', async () => {
    const list = await ok('GET /v1/doses', {
      method: 'GET', url: `/v1/doses?profileId=${own.profileId}&from=2026-09-01&to=2026-09-30`,
    });
    const doses = list.json<{ doses: Array<{ id: string }> }>().doses;
    expect(doses.length).toBeGreaterThan(2);
    own.doseId = doses[0]!.id;

    await ok('GET /v1/doses/:id', { method: 'GET', url: `/v1/doses/${own.doseId}` });
    const evt = (n: string) => `p12-${n}-${Date.now()}`;
    await ok('POST taken', {
      method: 'POST', url: `/v1/doses/${own.doseId}/taken`, payload: { clientEventId: evt('taken') },
    });
    await ok('POST undo', { method: 'POST', url: `/v1/doses/${own.doseId}/undo`, payload: { clientEventId: evt('undo') } });
    await ok('POST snooze', {
      method: 'POST', url: `/v1/doses/${doses[1]!.id}/snooze`,
      payload: { minutes: 15, clientEventId: evt('snooze') },
    });
    await ok('POST skip', {
      method: 'POST', url: `/v1/doses/${doses[2]!.id}/skip`, payload: { clientEventId: evt('skip') },
    });
    await ok('POST /v1/doses/sync', {
      method: 'POST', url: '/v1/doses/sync',
      payload: {
        deviceId: 'carol-offline',
        actions: [{
          type: 'taken', doseOccurrenceId: doses[3]!.id,
          at: '2026-09-01T08:05:00.000Z', clientEventId: evt('sync'),
        }],
      },
    });
  });

  it('records a note and a measurement', async () => {
    await ok('POST /v1/notes', {
      method: 'POST', url: `/v1/notes?profileId=${own.profileId}`,
      payload: { profileId: own.profileId, tags: ['nausea'], text: 'mild, passed quickly' },
    });
    await ok('GET /v1/notes', { method: 'GET', url: `/v1/notes?profileId=${own.profileId}` });
    await ok('POST /v1/measurements', {
      method: 'POST', url: `/v1/measurements?profileId=${own.profileId}`,
      payload: { profileId: own.profileId, type: 'blood_pressure', valuePrimary: 128, valueSecondary: 82, unit: 'mmHg', measuredAt: '2026-09-01T08:30:00.000Z' },
    });
    await ok('GET /v1/measurements', { method: 'GET', url: `/v1/measurements?profileId=${own.profileId}` });
  });

  it('reads every report', async () => {
    await ok('GET /v1/today', { method: 'GET', url: `/v1/today?profileId=${own.profileId}` });
    await ok('GET /v1/adherence', { method: 'GET', url: `/v1/adherence?profileId=${own.profileId}&from=2026-09-01&to=2026-09-30` });
    await ok('GET weekly', { method: 'GET', url: `/v1/reports/weekly?profileId=${own.profileId}` });
    await ok('GET adherence report', { method: 'GET', url: `/v1/reports/adherence?profileId=${own.profileId}&from=2026-09-01&to=2026-09-30` });
    await ok('GET clinician report', { method: 'GET', url: `/v1/reports/clinician?profileId=${own.profileId}&from=2026-09-01&to=2026-09-30` });
    await ok('GET export', { method: 'GET', url: `/v1/reports/export?profileId=${own.profileId}` });
  });

  it('manages the emergency card and its QR', async () => {
    await ok('PUT emergency card', {
      method: 'PUT', url: `/v1/emergency/card?profileId=${own.profileId}`,
      payload: { bloodType: 'A+', allergies: ['penicillin'] },
    });
    await ok('GET emergency card', { method: 'GET', url: `/v1/emergency/card?profileId=${own.profileId}` });
    await ok('POST qr/enable', { method: 'POST', url: `/v1/emergency/qr/enable?profileId=${own.profileId}` });
    await ok('POST qr/disable', { method: 'POST', url: `/v1/emergency/qr/disable?profileId=${own.profileId}` });
  });

  it('invites a caregiver, tunes them, and revokes them', async () => {
    const invite = await ok('POST caregivers/invite', {
      method: 'POST', url: '/v1/caregivers/invite',
      payload: {
        patientProfileId: own.profileId, invitedName: 'Helper',
        invitedPhone: '+966500090005', role: 'caregiver',
        permissions: ['view_schedule'], escalationPriority: 1,
      },
    });
    own.relationshipId = invite.json<{ relationshipId: string }>().relationshipId;

    await ok('GET /v1/care-circle', { method: 'GET', url: `/v1/care-circle?profileId=${own.profileId}` });
    await ok('PATCH permissions', {
      method: 'PATCH', url: `/v1/caregivers/${own.relationshipId}/permissions`,
      payload: { permissions: ['view_schedule', 'view_history'] },
    });
    await ok('PUT notification-rules', {
      method: 'PUT', url: `/v1/caregivers/${own.relationshipId}/notification-rules`,
      payload: { channel: 'push', mode: 'missed_only', consecutiveMissedThreshold: 2 },
    });
    await ok('DELETE caregiver', { method: 'DELETE', url: `/v1/caregivers/${own.relationshipId}` });
  });

  it('reads and writes the escalation policy', async () => {
    await ok('GET escalation-policy', { method: 'GET', url: `/v1/escalation-policy?profileId=${own.profileId}` });
    await ok('PUT escalation-policy', {
      method: 'PUT', url: `/v1/escalation-policy?profileId=${own.profileId}`,
      payload: {
        enabled: true,
        stages: [
          { afterMinutes: 15, target: 'patient', channels: ['push'] },
          { afterMinutes: 60, target: 'primary_caregiver', channels: ['push', 'in_app'] },
        ],
      },
    });
  });

  it('manages the account itself', async () => {
    await ok('GET /v1/me', { method: 'GET', url: '/v1/me' });
    await ok('PATCH /v1/me', { method: 'PATCH', url: '/v1/me', payload: { displayName: 'Carol' } });
    await ok('PATCH preferences', { method: 'PATCH', url: '/v1/me/preferences', payload: { elderlyMode: true } });
    await ok('PUT consents', {
      method: 'PUT', url: '/v1/me/consents', payload: { type: 'privacy_policy', granted: true },
    });
    await ok('GET sessions', { method: 'GET', url: '/v1/auth/sessions' });
    await ok('POST push-token', {
      method: 'POST', url: '/v1/devices/push-token',
      payload: { deviceId: 'carol-device', token: 'ExponentPushToken[cccccccccccccccccccccc]', platform: 'android' },
    });
    await ok('DELETE push-token', { method: 'DELETE', url: '/v1/devices/push-token/carol-device' });
  });

  it('requests an upload and reads the object back', async () => {
    const req = await ok('POST /v1/uploads/request', {
      method: 'POST', url: '/v1/uploads/request',
      payload: {
        purpose: 'medication_image', contentType: 'image/png',
        byteSize: 24_000, patientProfileId: own.profileId,
      },
    });
    const { objectKey } = req.json<{ objectKey: string }>();
    expect(objectKey).toBeTruthy();
    await ok('GET /v1/uploads/url', { method: 'GET', url: `/v1/uploads/url?objectKey=${encodeURIComponent(objectKey)}` });
  });

  it('finally deletes the medication it created', async () => {
    await ok('DELETE /v1/medications/:id', {
      method: 'DELETE', url: `/v1/medications/${own.medicationId}?force=true`,
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * P12-9 — the error handler's backstop, tested on its own.
 *
 * Route-level validation now rejects every malformed date and limit before a
 * query runs, which is the right order — but it also means no route in the app
 * can currently reach the handler's `22007` / `2201W` branch, so nothing above
 * exercises it. Removing that branch does not fail a single test, which is
 * exactly how a backstop rots.
 *
 * It is therefore tested directly, on a second Fastify instance carrying the
 * same `registerErrorHandler`, with errors raised by the real database rather
 * than by a stub. The point is that a future route which forgets to validate
 * returns 400 rather than a false 500 — and that this stays true.
 */
describe('P12-9 unvalidated input reaching Postgres still ends in a 4xx', () => {
  let probe: Awaited<ReturnType<typeof buildProbeServer>>;

  async function buildProbeServer() {
    const Fastify = (await import('fastify')).default;
    const { registerErrorHandler } = await import('../src/middleware/error-handler.js');
    const { Pool } = (await import('pg')).default;
    const pool = new Pool({ connectionString: 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test', max: 2 });

    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    // Each route runs a query the database will refuse, with no validation in
    // front of it — the shape a future contributor might write by accident.
    app.get('/probe/date', async (req) => {
      const { v } = req.query as { v: string };
      return (await pool.query('SELECT 1 WHERE $1::date IS NOT NULL', [v])).rows;
    });
    app.get('/probe/limit', async (req) => {
      const { v } = req.query as { v: string };
      return (await pool.query('SELECT 1 LIMIT $1', [Number(v)])).rows;
    });
    app.get('/probe/uuid', async (req) => {
      const { v } = req.query as { v: string };
      return (await pool.query('SELECT 1 WHERE $1::uuid IS NOT NULL', [v])).rows;
    });
    await app.ready();
    return { app, close: async () => { await app.close(); await pool.end(); } };
  }

  beforeAll(async () => { probe = await buildProbeServer(); }, 60_000);
  afterAll(async () => { await probe.close(); });

  it('maps a malformed date (22007) to 400, not 500', async () => {
    const res = await probe.app.inject({ method: 'GET', url: '/probe/date?v=abc' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('maps a negative LIMIT (2201W) to 400, not 500', async () => {
    const res = await probe.app.inject({ method: 'GET', url: '/probe/limit?v=-5' });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('still maps a malformed uuid (22P02) to 400', async () => {
    const res = await probe.app.inject({ method: 'GET', url: '/probe/uuid?v=nope' });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('leaks no database text in any of them', async () => {
    for (const url of ['/probe/date?v=abc', '/probe/limit?v=-5', '/probe/uuid?v=nope']) {
      const res = await probe.app.inject({ method: 'GET', url });
      expect(res.body).not.toMatch(/invalid input syntax|LIMIT must not|bigint|date"/i);
    }
  });

  it('positive control: sound values reach the database and return a row', async () => {
    for (const url of ['/probe/date?v=2026-09-01', '/probe/limit?v=1', `/probe/uuid?v=${BOGUS_UUID}`]) {
      const res = await probe.app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
  });
});
