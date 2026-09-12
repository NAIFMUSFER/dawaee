/**
 * Isolated Render transport acceptance harness, NOT a deployment entry point.
 * Product sources are frozen at CANDIDATE. No external DB/provider credentials
 * are accepted. Native storage adapters are memory-only; HTTP is NOT mocked.
 * One bounded run creates synthetic data on a loopback-only PostgreSQL cluster,
 * calls this service through Render's public HTTPS edge, then removes the DB.
 * A random per-process gate prevents public callers from reaching the API.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const CANDIDATE = 'a50846f215513d2842747bfa390fc35210803f5f';
const BRANCH = 'audit/render-transport-proof-2026-09-12';
const SERVICE = 'dawaee-transport-proof-v2-20260912';
const ORIGIN = `https://${SERVICE}.onrender.com`;
const FILE = 'scripts/render-transport-proof.mjs';
const FORBIDDEN_ENV = [
  'DATABASE_URL', 'WORKER_DATABASE_URL', 'DATABASE_ROLE', 'DATABASE_ROLE_PASSWORD',
  'MIGRATION_DATABASE_URL', 'GOOGLE_VISION_API_KEY', 'AZURE_DI_KEY', 'EXPO_ACCESS_TOKEN',
  'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'JWT_SECRET',
];

function validateEnvironment(env) {
  assert.equal(env.DAWAEE_ISOLATED_TRANSPORT_PROOF, '1', 'explicit isolated proof opt-in required');
  assert.equal(env.RENDER_SERVICE_NAME, SERVICE, 'refusing any other service');
  assert.equal(env.RENDER_GIT_BRANCH, BRANCH, 'refusing any other branch');
  assert.equal(env.RENDER_EXTERNAL_URL, ORIGIN, 'refusing any other origin');
  assert.notEqual(env.NODE_ENV, 'production', 'not a production entry point');
  for (const key of FORBIDDEN_ENV) assert.ok(!env[key], `refusing inherited ${key}`);
}

function allowedPublicUrl(raw) {
  const u = new URL(raw);
  return u.origin === ORIGIN && !u.username && !u.password;
}

function safePath(raw, sentinels) {
  let result = new URL(raw).pathname + new URL(raw).search;
  for (const value of sentinels) {
    if (!value) continue;
    result = result.split(value).join('<synthetic>');
    result = result.split(encodeURIComponent(value)).join('<synthetic>');
  }
  return result.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/ig, '<synthetic>');
}

if (process.argv.includes('--self-test')) {
  const good = {
    DAWAEE_ISOLATED_TRANSPORT_PROOF: '1', RENDER_SERVICE_NAME: SERVICE,
    RENDER_GIT_BRANCH: BRANCH, RENDER_EXTERNAL_URL: ORIGIN, NODE_ENV: 'development',
  };
  validateEnvironment(good);
  for (const [key, value] of [
    ['DAWAEE_ISOLATED_TRANSPORT_PROOF', '0'], ['RENDER_SERVICE_NAME', 'dawaee-api'],
    ['RENDER_GIT_BRANCH', 'main'], ['RENDER_EXTERNAL_URL', 'https://dawaee-api.onrender.com'],
    ['NODE_ENV', 'production'], ...FORBIDDEN_ENV.map(key => [key, 'present']),
  ]) assert.throws(() => validateEnvironment({ ...good, [key]: value }));
  assert.equal(allowedPublicUrl(ORIGIN + '/v1/profile'), true);
  assert.equal(allowedPublicUrl('https://dawaee-api.onrender.com/v1/profile'), false);
  assert.equal(allowedPublicUrl(ORIGIN + '.example.invalid/v1/profile'), false);
  assert.equal(allowedPublicUrl(ORIGIN.replace('https://', 'https://x:y@') + '/'), false);
  const sentinel = '11111111-2222-4333-8444-555555555555';
  assert.equal(safePath(ORIGIN + '/v1/profiles/' + sentinel, [sentinel]), '/v1/profiles/<synthetic>');
  console.log('ISOLATED_HARNESS_SAFETY: 22 cases passed');
} else {
  validateEnvironment(process.env);
  await main();
}

async function main() {
  // Render deploys a shallow Git checkout. Fetch only the pinned candidate
  // when absent, then retain the unchanged source-equivalence assertion.
  try { execFileSync('git', ['cat-file', '-e', `${CANDIDATE}^{commit}`], { stdio: 'pipe' }); }
  catch { execFileSync('git', ['fetch', '--depth=1', 'https://github.com/NAIFMUSFER/dawaee.git', CANDIDATE], { stdio: 'pipe', timeout: 30000 }); }
  // Only this harness may differ from the already-green candidate.
  execFileSync('git', ['diff', '--exit-code', CANDIDATE, 'HEAD', '--', '.', `:(exclude)${FILE}`], { stdio: 'pipe' });
  const state = {
    auditOnly: true, candidate: CANDIDATE, harnessCommit: process.env.RENDER_GIT_COMMIT,
    phase: 'bootstrapping', startedAt: new Date().toISOString(), steps: [], requests: [],
    platformLogVerification: 'PENDING_EXTERNAL_REVIEW', productionCutover: 'NOT_PERFORMED',
    nativeDevices: 'NOT_TESTED', providers: 'MOCK_PUSH_AND_OCR_LOCAL_STORAGE',
    database: 'TEMPORARY_LOOPBACK_ONLY', dataPlane: 'blocked',
  };
  const privateSentinels = [];
  const transportRecords = [];
  const gate = randomBytes(32).toString('hex');
  privateSentinels.push(gate);
  let app;
  let embedded;
  let closePool;
  let apiReady = false;
  let closed = false;
  let step = 'bootstrap';
  const nativeFetch = globalThis.fetch;
  const port = Number(process.env.PORT || 10000);
  const apiPort = 18081;
  const pgPort = 15433;
  const directory = await mkdtemp(join(tmpdir(), 'dawaee-proof-'));

  function report() { console.log('DAWAEE_TRANSPORT_PROOF ' + JSON.stringify(state)); }
  function safeError(error) {
    let text = String(error?.message || error).slice(0, 1200);
    for (const value of privateSentinels) if (value) text = text.split(value).join('<redacted>');
    return text.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/ig, '<synthetic>');
  }
  function answer(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
    res.end(JSON.stringify(body));
  }
  const gateway = createServer({ requestTimeout: 30000, headersTimeout: 15000 }, (req, res) => {
    if (req.method === 'GET' && ['/', '/audit/health', '/audit/status'].includes(req.url)) {
      return answer(res, 200, state);
    }
    const presented = typeof req.headers['x-dawaee-audit-gate'] === 'string' ? req.headers['x-dawaee-audit-gate'] : '';
    const presentedBytes = Buffer.from(presented);
    if (closed || !apiReady || presentedBytes.length !== Buffer.byteLength(gate) || !timingSafeEqual(presentedBytes, Buffer.from(gate))) {
      req.resume();
      return answer(res, 404, { auditOnly: true });
    }
    // A constant loopback destination. No caller-selected proxy target.
    const headers = { ...req.headers };
    delete headers['x-dawaee-audit-gate'];
    const upstream = proxyRequest({
      hostname: '127.0.0.1', port: apiPort, method: req.method, path: req.url,
      headers, timeout: 25000,
    }, reply => {
      res.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) answer(res, 502, { error: { code: 'audit_upstream_unavailable' } }); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(port, '0.0.0.0', resolve); });

  async function cleanup() {
    if (closed) return;
    closed = true;
    apiReady = false;
    state.dataPlane = 'disabled';
    globalThis.fetch = nativeFetch;
    const results = await Promise.allSettled([app?.close(), closePool?.()]);
    if (results.some(r => r.status === 'rejected')) state.cleanupWarning = 'API_POOL_CLOSE_FAILED';
    try { if (embedded) await embedded.stop(); state.database = 'STOPPED_AND_EPHEMERAL'; }
    catch { state.cleanupWarning = 'DATABASE_STOP_FAILED'; }
  }
  const deadline = setTimeout(() => {
    state.phase = 'TIMED_OUT';
    void cleanup().then(report);
  }, 15 * 60 * 1000);
  deadline.unref();
  process.once('SIGTERM', () => { void cleanup().finally(() => gateway.close(() => process.exit(0))); });

  async function check(name, work) {
    if (closed) throw new Error('audit deadline exceeded');
    step = name;
    const before = transportRecords.length;
    try {
      await work();
      state.steps.push({ name, result: 'PASS', requests: transportRecords.length - before });
    } catch (error) {
      state.steps.push({ name, result: 'FAIL', error: safeError(error), requests: transportRecords.length - before });
      throw error;
    }
  }
  let legacyControl = false;
  globalThis.fetch = async (input, init = {}) => {
    const raw = input instanceof Request ? input.url : String(input);
    assert.ok(allowedPublicUrl(raw), 'audit outbound origin allowlist failed');
    const u = new URL(raw);
    const publicTarget = u.pathname + u.search;
    const leaking = privateSentinels.some(v => v && (publicTarget.includes(v) || publicTarget.includes(encodeURIComponent(v))));
    if (!legacyControl) {
      assert.equal(leaking, false, 'sensitive synthetic value would enter a public URL');
      assert.equal(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(publicTarget), false, 'UUID in public URL');
      for (const key of ['profileId', 'medicationId', 'doseId', 'relationshipId', 'objectKey', 'token']) assert.equal(u.searchParams.has(key), false, `public query contains ${key}`);
      assert.equal(/\/doses\/[^/]+\/(taken|snooze|skip|undo)/.test(u.pathname), false, 'legacy action route leaked');
    }
    const headers = new Headers(init.headers);
    headers.set('x-dawaee-audit-gate', gate);
    const response = await nativeFetch(raw, { ...init, headers, redirect: 'error', signal: init.signal || AbortSignal.timeout(25000) });
    const record = { case: step, method: init.method || 'GET', path: safePath(raw, privateSentinels), status: response.status,
      renderRequestId: response.headers.get('rndr-id'), legacyControl, sensitiveValueInPublicUrl: leaking };
    transportRecords.push(record);
    state.requests.push(record);
    assert.ok(record.renderRequestId, 'missing independent Render edge correlation header');
    return response;
  };

  try {
    const requireProof = createRequire(join(process.cwd(), '.audit-proof-deps/package.json'));
    const { default: EmbeddedPostgres } = await import(pathToFileURL(requireProof.resolve('embedded-postgres')).href);
    const password = randomBytes(24).toString('hex');
    const migratorPassword = randomBytes(24).toString('hex');
    const appPassword = randomBytes(24).toString('hex');
    const workerPassword = randomBytes(24).toString('hex');
    const jwtSecret = randomBytes(48).toString('hex');
    privateSentinels.push(password, migratorPassword, appPassword, workerPassword, jwtSecret);
    embedded = new EmbeddedPostgres({
      databaseDir: join(directory, 'db'), user: 'postgres', password, port: pgPort,
      persistent: false, authMethod: 'scram-sha-256',
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'shared_buffers=32MB', '-c', 'max_connections=40'],
      onLog: () => {}, onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    const databaseEnv = {
      ...process.env, PGHOST: '127.0.0.1', PGPORT: String(pgPort), PGUSER: 'postgres', PGPASSWORD: password,
      DAWAEE_MIGRATOR_PASSWORD: migratorPassword, DAWAEE_APP_PASSWORD: appPassword, DAWAEE_WORKER_PASSWORD: workerPassword,
    };
    execFileSync('bash', ['scripts/db-reset.sh', 'dawaee_transport_proof'], { env: databaseEnv, stdio: 'pipe', timeout: 120000 });
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `postgres://dawaee_app:${appPassword}@127.0.0.1:${pgPort}/dawaee_transport_proof`,
      WORKER_DATABASE_URL: `postgres://dawaee_worker:${workerPassword}@127.0.0.1:${pgPort}/dawaee_transport_proof`,
      DATABASE_SSL: 'false', DATABASE_POOL_MAX: '4', JWT_SECRET: jwtSecret, IP_HASH_SALT: randomBytes(24).toString('hex'),
      PUSH_PROVIDER: 'mock', OCR_PROVIDER: 'mock', STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: join(directory, 'objects'),
      PUBLIC_APP_URL: ORIGIN, TRUST_CF_CONNECTING_IP: 'true', TRUST_PROXY_HOPS: '1', LOG_LEVEL: 'info',
    });
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const roles = await db.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('dawaee_app','dawaee_worker','dawaee_migrator') ORDER BY rolname");
      assert.equal(roles.rows.length, 3);
      assert.ok(roles.rows.every(r => !r.rolsuper && !r.rolbypassrls));
      const migrations = await db.query('SELECT count(*)::int AS n FROM schema_migrations');
      assert.equal(migrations.rows[0].n, 74);
      const version = await db.query("SELECT current_setting('server_version') AS version");
      state.postgresVersion = version.rows[0].version;
      state.migrationCount = migrations.rows[0].n;
      state.roleBoundary = 'NOSUPERUSER_NOBYPASSRLS';
    } finally { await db.end(); }

    const { setClockSource } = await import('../apps/api/dist/lib/clock.js');
    setClockSource(() => new Date('2026-09-12T05:30:00.000Z'));
    const built = await (await import('../apps/api/dist/server.js')).buildServer();
    app = built.app;
    const dbModule = await import('../apps/api/dist/lib/db.js');
    closePool = dbModule.closePool;
    await app.listen({ host: '127.0.0.1', port: apiPort });
    apiReady = true;
    state.phase = 'waiting_for_public_edge';
    state.dataPlane = 'random_gate_only';
    report();

    let publicReady = false;
    for (let attempt = 0; attempt < 36; attempt++) {
      try {
        const response = await nativeFetch(ORIGIN + '/audit/health', { signal: AbortSignal.timeout(5000), redirect: 'error' });
        const body = await response.json();
        if (response.ok && body.harnessCommit === state.harnessCommit && response.headers.get('rndr-id')) { publicReady = true; break; }
      } catch { /* Initial Render edge cutover can lag process startup. */ }
      await delay(5000);
    }
    assert.ok(publicReady, 'Render public edge did not become ready');
    state.phase = 'running';

    const { build } = await import('esbuild');
    const bundle = await build({
      entryPoints: ['apps/mobile/src/api/client.ts'], bundle: true, platform: 'node', format: 'esm', write: false, packages: 'external',
      define: { 'process.env.EXPO_PUBLIC_API_URL': JSON.stringify(ORIGIN), 'process.env.EXPO_PUBLIC_DEMO': '"0"' },
      plugins: [{ name: 'synthetic-native-storage-only', setup(b) {
        b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|expo-constants|\.\/token-store\.js|\.\/demo-backend\.js)$/ }, args => ({ path: args.path, namespace: 'audit-adapter' }));
        b.onLoad({ filter: /.*/, namespace: 'audit-adapter' }, args => ({ loader: 'js', contents:
          args.path === 'expo-constants' ? 'export default {expoConfig:{extra:{}}};' :
          args.path.includes('async-storage') ? 'const m=new Map();export default {getItem:async k=>m.get(k)??null,setItem:async(k,v)=>{m.set(k,v)},removeItem:async k=>{m.delete(k)}};' :
          args.path === './token-store.js' ? 'let s=null;export const readSession=async()=>s;export const writeSession=async v=>{s=v};export const clearStoredSession=async()=>{s=null};' :
          'export class DemoUnavailable extends Error{};export function handleDemoRequest(){throw new Error("demo prohibited in transport proof")};',
        }));
      } }],
    });
    const clientPath = join(directory, 'client.mjs');
    await writeFile(clientPath, bundle.outputFiles[0].text);
    const a = await import(pathToFileURL(clientPath).href + '?a');
    const b = await import(pathToFileURL(clientPath).href + '?b');
    assert.equal(a.DEMO_MODE, false);
    assert.equal(b.DEMO_MODE, false);
    let pa, pb, ma, dose, doseScheduledAt, schedule, relationship, objectKey, qrToken;
    const deviceId = 'dev-synthetic-transport-a';
    privateSentinels.push(deviceId);
    async function register(client, label, device) {
      const email = `transport-${label}-${randomBytes(8).toString('hex')}@example.invalid`;
      const secret = randomBytes(24).toString('base64url');
      privateSentinels.push(email, secret);
      const tokens = await client.api.anonymous.post('/v1/auth/register', { email, password: secret, displayName: `Synthetic ${label}`, deviceId: device });
      privateSentinels.push(tokens.accessToken, tokens.refreshToken);
      await client.storeSession(tokens);
      const list = await client.api.get('/v1/profiles');
      assert.equal(list.profiles.length, 1);
      const profile = list.profiles[0].id;
      assert.ok(profile);
      privateSentinels.push(profile);
      return profile;
    }
    await check('register_synthetic_accounts', async () => { pa = await register(a, 'a', deviceId); pb = await register(b, 'b', 'dev-synthetic-transport-b'); });
    await check('owner_profile_private_path', async () => { const r = await a.api.get(`/v1/profiles/${pa}`); assert.equal(r.profile.id, pa); });
    await check('cross_account_profile_denied', async () => { await assert.rejects(b.api.get(`/v1/profiles/${pa}`), e => e.status === 404); });
    await check('dependent_creation', async () => { const r = await a.api.post('/v1/profiles', { displayName: 'Synthetic dependent', timezone: 'Asia/Riyadh', isSelf: false }); assert.ok(r.profile.id); privateSentinels.push(r.profile.id); });
    await check('medication_creation', async () => { const r = await a.api.post('/v1/medications', { patientProfileId: pa, name: 'SYNTHETIC_TRANSPORT_MED', form: 'tablet', startDate: '2026-09-12', acknowledgeDuplicate: true }); ma = r.medication.id; assert.ok(ma); privateSentinels.push(ma); });
    await check('medication_list_private_query', async () => { const r = await a.api.get('/v1/medications', { profileId: pa, status: 'active' }); assert.ok(r.medications.some(m => m.id === ma)); });
    await check('medication_detail_private_path', async () => { const r = await a.api.get(`/v1/medications/${ma}`); assert.equal(r.medication.id, ma); });
    await check('cross_account_medication_denied', async () => { await assert.rejects(b.api.get(`/v1/medications/${ma}`), e => e.status === 404); });
    await check('anonymous_medication_denied', async () => { await assert.rejects(a.api.anonymous.get(`/v1/medications/${ma}`), e => e.status === 401); });
    await check('stock_private_path', async () => { await a.api.get(`/v1/medications/${ma}/stock`); });
    await check('schedule_create_private_path', async () => { const r = await a.api.post(`/v1/medications/${ma}/schedules`, { rule: { kind: 'fixed_times', times: ['08:00'] }, doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-12' }); schedule = r.schedule.id; assert.ok(schedule); privateSentinels.push(schedule); });
    await check('dose_history_private_filters', async () => { const r = await a.api.get('/v1/doses', { profileId: pa, medicationId: ma, from: '2026-09-12', to: '2026-09-13' }); assert.ok(r.doses.length > 0); assert.ok(r.doses.every(d => d.medicationId === ma)); const selected = [...r.doses].sort((x,y) => x.scheduledAt.localeCompare(y.scheduledAt))[0]; dose = selected.id; doseScheduledAt = selected.scheduledAt; assert.ok(dose); assert.ok(Number.isFinite(Date.parse(doseScheduledAt))); privateSentinels.push(dose); });
    await check('dose_detail_private_path', async () => { const r = await a.api.get(`/v1/doses/${dose}`); assert.ok(JSON.stringify(r).includes(dose)); });
    // The initial run correctly returned 422 for a future occurrence. Use the
    // occurrence's own scheduled instant; do not weaken the product guard.
    await check('early_dose_action_still_denied', async () => {
      setClockSource(() => new Date(Date.parse(doseScheduledAt) - 16 * 60000));
      await assert.rejects(a.api.post('/v1/dose/action', { doseId: dose, action: 'taken', clientEventId: randomUUID(), deviceId, method: 'app' }), e => e.status === 422);
      setClockSource(() => new Date(doseScheduledAt));
    });
    await check('dose_taken_fixed_body', async () => { await a.api.post('/v1/dose/action', { doseId: dose, action: 'taken', clientEventId: randomUUID(), deviceId, method: 'app' }); });
    await check('dose_undo_fixed_body', async () => { await a.api.post('/v1/dose/action', { doseId: dose, action: 'undo' }); });
    await check('cross_account_dose_action_denied', async () => { await assert.rejects(b.api.post('/v1/dose/action', { doseId: dose, action: 'undo' }), e => e.status === 404); });
    await check('schedule_update_private_path', async () => { await a.api.patch(`/v1/schedules/${schedule}`, { active: false }); });
    await check('timezone_check_private_path', async () => { await a.api.post(`/v1/profiles/${pa}/timezone-check`, { deviceTimezone: 'Asia/Riyadh' }); });
    await check('push_registration_synthetic', async () => { await a.api.post('/v1/devices/push-token', { token: 'ExponentPushToken[synthetic-transport-only]', platform: 'ios', deviceId }); });
    await check('push_deregistration_bodyless_private_path', async () => { await a.api.delete(`/v1/devices/push-token/${deviceId}`); });
    await check('caregiver_link_invitation', async () => { const r = await a.api.post('/v1/caregivers/invite', { patientProfileId: pa, invitedName: 'Synthetic link only', invitedPhone: '+966511234501', role: 'other', permissions: ['view_adherence'], escalationPriority: 5, channel: 'link', expiresInHours: 72 }); relationship = r.relationshipId; assert.ok(relationship); privateSentinels.push(relationship); });
    await check('caregiver_permissions_fixed_body', async () => { await a.api.patch('/v1/caregivers/permissions', { relationshipId: relationship, permissions: ['view_adherence', 'view_medications'], escalationPriority: 4 }); });
    await check('caregiver_cross_account_denied', async () => { await assert.rejects(b.api.post('/v1/caregivers/revoke', { relationshipId: relationship }), e => e.status === 404); });
    await check('caregiver_revoke_fixed_body', async () => { const r = await a.api.post('/v1/caregivers/revoke', { relationshipId: relationship }); assert.equal(r.revoked, true); });
    await check('upload_ticket_synthetic_metadata', async () => {
      const r = await a.api.post('/v1/uploads/request', { purpose: 'prescription_image', contentType: 'image/jpeg', byteSize: 128, patientProfileId: pa });
      objectKey = r.objectKey; assert.ok(objectKey); privateSentinels.push(objectKey);
      const me = await a.api.get('/v1/me');
      // Transport-only fixture, matching the existing independent routing test.
      // This is NOT an upload/finalization or object-store acceptance claim.
      await dbModule.withUser(me.user.id, tx => tx.query("UPDATE stored_objects SET uploaded_at=now(), scan_status='clean' WHERE object_key=$1 AND owner_user_id=$2", [objectKey, me.user.id]));
    });
    await check('upload_signed_url_private_header', async () => { const r = await a.api.get('/v1/uploads/url', { objectKey }); assert.equal(r.expiresInSeconds, 300); assert.ok(r.url); });
    await check('upload_cross_account_denied', async () => { await assert.rejects(b.api.get('/v1/uploads/url', { objectKey }), e => e.status === 404); });
    await check('emergency_enable_fragment_capability', async () => { const r = await a.api.post('/v1/emergency/qr/enable', undefined, { profileId: pa }); qrToken = r.token; assert.ok(qrToken); privateSentinels.push(qrToken); const u = new URL(r.qrUrl); assert.equal(u.origin, ORIGIN); assert.equal(u.pathname, '/e'); assert.equal(u.search, ''); assert.equal(u.hash.slice(1), qrToken); });
    await check('emergency_scan_authorization_header', async () => { const r = await fetch(ORIGIN + '/v1/emergency/scan/card', { headers: { authorization: `Bearer ${qrToken}` } }); assert.equal(r.status, 200); assert.equal((await r.text()).includes(qrToken), false); });
    await check('legacy_own_profile_positive_control', async () => {
      // Deliberately synthetic, NOT production. This establishes that upstream
      // log inspection really sees a URL id when one is sent by an old client.
      legacyControl = true;
      try { const r = await a.api.get(`/v1/medications?profileId=${pa}`); assert.ok(r.medications.some(m => m.id === ma)); }
      finally { legacyControl = false; }
      assert.equal(transportRecords.at(-1).sensitiveValueInPublicUrl, true);
    });
    await check('new_client_no_public_identifier_regression', async () => {
      const r = await a.api.get('/v1/medications', { profileId: pa }); assert.ok(r.medications.some(m => m.id === ma));
      assert.ok(transportRecords.filter(r => !r.legacyControl).every(r => !r.sensitiveValueInPublicUrl && r.renderRequestId));
      assert.equal(transportRecords.filter(r => r.legacyControl).length, 1);
    });
    await check('external_api_gate_closed', async () => {
      const r = await nativeFetch(ORIGIN + '/v1/profiles', { signal: AbortSignal.timeout(15000), redirect: 'error' });
      assert.equal(r.status, 404); assert.deepEqual(await r.json(), { auditOnly: true });
    });
    assert.ok(pb && pb !== pa);
    state.phase = 'CANDIDATE_TRANSPORT_PASS';
    state.legacyTransport = 'STILL_SUPPORTED_CUTOVER_BLOCKER_OPEN';
  } catch (error) {
    if (state.phase !== 'TIMED_OUT') state.phase = 'FAILED';
    state.failedStage = step;
    state.error = safeError(error);
  } finally {
    clearTimeout(deadline);
    await cleanup();
    state.finishedAt = new Date().toISOString();
    report();
  }
}
