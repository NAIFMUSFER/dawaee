// Drives rebuilt images through their unchanged entrypoints and real HTTP.
// Only disposable synthetic data and test providers are used; no deploy occurs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecoveryHarness } from './release-recovery-harness.mjs';
import { apiRequest, createRuntimeHarness, until, waitForApi } from './release-runtime-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHONE = '+966500000201';
const PASSWORD = 'RuntimeRecovery!Synthetic123';
const JOBS = ['materialize', 'reminders', 'dispatch', 'mark-missed', 'stock-alerts', 'digests', 'housekeeping'];

async function session(api) {
  const login = await apiRequest(api, '/v1/auth/login', { method: 'POST',
    body: { identifier: PHONE, password: PASSWORD, deviceId: 'runtime-recovery-login' } });
  assert.equal(typeof login.accessToken, 'string', 'login did not issue a session');
  const refreshed = await apiRequest(api, '/v1/auth/refresh', { method: 'POST',
    body: { refreshToken: login.refreshToken } });
  assert.equal(typeof refreshed.accessToken, 'string', 'refresh did not issue a session');
  assert.notEqual(refreshed.refreshToken, login.refreshToken, 'refresh token did not rotate');
  return refreshed.accessToken;
}

async function exerciseRecovery() {
  const runtime = await createRuntimeHarness();
  let db;
  try {
    db = await createRecoveryHarness(runtime.databaseEnv);
    runtime.allowDatabases(db.names);
    const { source, upgrade, recovered } = db.names;
    const sql = (database, text, values = []) => db.query(database, 'postgres', text, values);
    const ledger = async (database) => (await sql(database,
      'SELECT filename,checksum FROM schema_migrations ORDER BY filename')).rows;
    const clinical = async (database, medication, dose) => (await sql(database, `
      SELECT d.status,d.confirmed_at,d.client_event_id,s.remaining_quantity::text AS balance,
        (SELECT count(*)::int FROM stock_transactions WHERE medication_id=$1) AS stock_rows,
        (SELECT count(*)::int FROM dose_events WHERE dose_occurrence_id=$2) AS dose_events
      FROM dose_occurrences d JOIN medication_stock s ON s.medication_id=d.medication_id
      WHERE d.id=$2 AND d.medication_id=$1`, [medication, dose])).rows;
    const stock = async (api, token, medication, balance) => {
      const result = await apiRequest(api, `/v1/medications/${medication}`, { token });
      assert.equal(result.stock.remainingQuantity, balance, 'stock HTTP read disagrees');
    };
    const abandoned = async (database, key, user, profile) => {
      await sql(database, `INSERT INTO stored_objects
        (object_key,owner_user_id,patient_profile_id,purpose,content_type,byte_size,created_at)
        VALUES ($1,$2,$3,'avatar','image/jpeg',4,now()-interval '48 hours')`, [key, user, profile]);
    };
    const gap = async (database, schedule) => {
      // A fixture gap forces materialization to do real work on every copy.
      await sql(database, 'DELETE FROM dose_occurrences WHERE schedule_id=$1 AND scheduled_at>now()+interval \'1 day\'', [schedule]);
      await sql(database, 'UPDATE medication_schedules SET materialized_through=NULL WHERE id=$1', [schedule]);
    };
    const tick = async (database, name, expectJobSuccess = true) => {
      // Prove an actual supported retention deletion separately from uploads.
      // The old worker's upload DELETE is a known FORCE-RLS no-op even before
      // 0039 revokes its table grant; restoring that baseline does not fix it.
      const expired = (await sql(database, `INSERT INTO job_runs
        (job_name,started_at,finished_at,succeeded) VALUES
        ('runtime-expired-fixture',now()-interval '15 days',now()-interval '15 days',true)
        RETURNING id::text AS id`)).rows[0].id;
      const uploadsBefore = (await sql(database, 'SELECT count(*)::int AS n FROM stored_objects')).rows[0].n;
      assert.ok(uploadsBefore > 0, 'upload cleanup has no fixture to inspect');
      const before = (await sql(database, 'SELECT COALESCE(max(id),0)::text AS id FROM job_runs')).rows[0].id;
      const worker = await runtime.start(name, database, 'worker');
      const rows = await until('complete worker tick including housekeeping', async () => {
        assert.equal(runtime.inspect(worker.id).State.Running, true, 'worker exited before its tick');
        const result = await sql(database, `SELECT job_name,succeeded,items_processed,metadata
          FROM job_runs WHERE id>$1::bigint ORDER BY id`, [before]);
        return result.rows.some(row => row.job_name === 'housekeeping') ? result.rows : null;
      });
      const expected = name === 'candidate' ? [...JOBS, 'push-receipts'] : JOBS;
      assert.deepEqual(rows.map(row => row.job_name).sort(), [...expected].sort(), 'worker did not record every job');
      const failed = rows.filter(row => !row.succeeded);
      if (expectJobSuccess) {
        assert.deepEqual(failed, [], 'worker tick reported an unexpected failure');
        assert.ok(rows.find(row => row.job_name === 'materialize').items_processed > 0, 'worker did no materialization');
        assert.ok(rows.find(row => row.job_name === 'housekeeping').items_processed > 0, 'worker did no cleanup');
      } else {
        const housekeeping = failed.find(row => row.job_name === 'housekeeping');
        assert.ok(housekeeping, 'recorded legacy cleanup unexpectedly became compatible');
        assert.ok(housekeeping.metadata.failedSteps.some(step => step.step === 'uploads'));
      }
      if (name === 'candidate') {
        assert.ok(rows.every(row => row.metadata.buildCommit === runtime.images.candidate.sha), 'worker identity differs from candidate');
      }
      assert.equal((await sql(database, 'SELECT count(*)::int AS n FROM job_runs WHERE id=$1', [expired])).rows[0].n, 0,
        'worker did not remove the expired operational fixture');
      const uploadsAfter = (await sql(database, 'SELECT count(*)::int AS n FROM stored_objects')).rows[0].n;
      assert.equal(uploadsAfter, name === 'candidate' ? 0 : uploadsBefore,
        'upload outcome differs from the selected runtime/ledger contract');
      runtime.stop(worker);
      return { jobs: rows.length, failedJobs: failed.map(row => row.job_name), expiredOperationalRowRemoved: true,
        uploadsBefore, uploadsAfter,
        uploadOutcome: name === 'candidate' ? 'removed' : expectJobSuccess ? 'legacy-rls-no-op' : 'legacy-permission-denied' };
    };
    const api = async (database, name) => {
      const instance = await runtime.start(name, database, 'api');
      await waitForApi(runtime, instance);
      return instance;
    };
    const taken = (instance, token, dose, clientEventId, status = 200) => apiRequest(instance,
      `/v1/doses/${dose}/taken`, { method: 'POST', token, body: { method: 'app', clientEventId }, status });
    const undo = (instance, token, dose) => apiRequest(instance,
      `/v1/doses/${dose}/undo`, { method: 'POST', token, body: {} });

    console.info('Runtime recovery: build populated baseline through the recorded API');
    await db.create(source);
    db.migrate(source, true);
    const postgresVersion = (await sql(source, "SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(postgresVersion, /^17\./);
    assert.equal((await ledger(source)).length, 34);
    let server = await api(source, 'oldApi');
    const registered = await apiRequest(server, '/v1/auth/register', { method: 'POST', body: {
      phone: PHONE, displayName: 'Synthetic runtime recovery', password: PASSWORD,
      locale: 'en', deviceId: 'runtime-recovery-registration',
    } });
    const profiles = await apiRequest(server, '/v1/profiles', { token: registered.accessToken });
    assert.equal(profiles.profiles.length, 1);
    const profile = profiles.profiles[0].id;
    const user = (await sql(source, 'SELECT id FROM users WHERE phone_e164=$1', [PHONE])).rows[0].id;
    let token = await session(server);
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const created = await apiRequest(server, '/v1/medications', { method: 'POST', token, body: {
      patientProfileId: profile, name: 'Synthetic recovery fixture', form: 'tablet', startDate: date,
      stock: { initialQuantity: 30, unit: 'tablet', trackingEnabled: true },
      schedule: { rule: { kind: 'fixed_times', times: [now.toISOString().slice(11, 16)] },
        doseQuantity: 1, doseUnit: 'tablet', timezone: 'Etc/UTC', startDate: date },
    } });
    const medication = created.medication.id;
    const schedule = created.scheduleId;
    const dose = (await sql(source, 'SELECT id FROM dose_occurrences WHERE schedule_id=$1 ORDER BY scheduled_at LIMIT 1', [schedule])).rows[0].id;
    await gap(source, schedule);
    await abandoned(source, 'runtime/baseline-abandoned', user, profile);
    const baselineWorker = await tick(source, 'oldWorker');
    await stock(server, token, medication, 30);
    assert.equal((await taken(server, token, dose, 'baseline-runtime-take')).stock.remainingQuantity, 29);
    assert.equal((await taken(server, token, dose, 'baseline-runtime-take')).idempotentReplay, true);
    await undo(server, token, dose);
    await stock(server, token, medication, 30);
    runtime.stop(server);
    assert.equal((await sql(source, `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND usename IN ('dawaee_app','dawaee_worker')`)).rows[0].n, 0,
    'runtime connections remained after draining');
    await abandoned(source, 'runtime/archive-abandoned', user, profile);
    const baseline = await db.snapshot(source);
    const backup = await db.backup();

    console.info('Runtime recovery: restore, upgrade and run the complete candidate pair');
    await db.create(upgrade);
    await db.restore(upgrade);
    assert.deepEqual(await db.snapshot(upgrade), baseline);
    db.migrate(upgrade);
    const expectedLedger = readdirSync(join(ROOT, 'db/migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()
      .map(filename => ({ filename, checksum: createHash('md5').update(readFileSync(join(ROOT, 'db/migrations', filename))).digest('hex') }));
    assert.deepEqual(await ledger(upgrade), expectedLedger);
    assert.match(db.migrate(upgrade), /no pending migrations/);
    server = await api(upgrade, 'candidate');
    token = await session(server);
    await stock(server, token, medication, 30);
    await gap(upgrade, schedule);
    const candidateWorker = await tick(upgrade, 'candidate');
    assert.equal((await sql(upgrade, 'SELECT count(*)::int AS n FROM stored_objects')).rows[0].n, 0);
    assert.equal((await taken(server, token, dose, 'candidate-runtime-take-1')).stock.remainingQuantity, 29);
    await undo(server, token, dose);
    assert.equal((await taken(server, token, dose, 'candidate-runtime-take-2')).stock.remainingQuantity, 29);
    assert.equal((await taken(server, token, dose, 'candidate-runtime-take-1')).idempotentReplay, true);
    await undo(server, token, dose);
    await stock(server, token, medication, 30);
    assert.deepEqual((await sql(upgrade, `SELECT count(*)::int AS rows,sum(delta)::int AS balance,
      count(dose_event_id)::int AS linked,count(DISTINCT dose_event_id)::int AS distinct_events
      FROM stock_transactions WHERE medication_id=$1`, [medication])).rows,
    [{ rows: 7, balance: 30, linked: 4, distinct_events: 4 }]);
    runtime.stop(server);

    console.info('Runtime recovery: record old-runtime incompatibilities on upgraded schema');
    server = await api(upgrade, 'oldApi');
    token = await session(server);
    const beforeFailure = await clinical(upgrade, medication, dose);
    await taken(server, token, dose, 'incompatible-runtime-take', 500);
    assert.deepEqual(await clinical(upgrade, medication, dose), beforeFailure, 'failed legacy action changed clinical state');
    await abandoned(upgrade, 'runtime/incompatible-abandoned', user, profile);
    const incompatibleWorker = await tick(upgrade, 'oldWorker', false);
    runtime.stop(server);

    // Keep 4cf2353 as the negative control. The actual serving PR #28 hotfix
    // is a different source and must be exercised, not inferred from that test.
    console.info('Runtime recovery: serving PR #28 hotfix on upgraded catalog');
    server = await api(upgrade, 'servingApi');
    token = await session(server);
    const hotfixTake = await apiRequest(server, '/v1/dose/action', { method: 'POST', token,
      body: { doseId: dose, action: 'taken', method: 'app', clientEventId: 'serving-hotfix-take' } });
    assert.equal(hotfixTake.stock.remainingQuantity, 29);
    const hotfixReplay = await apiRequest(server, '/v1/dose/action', { method: 'POST', token,
      body: { doseId: dose, action: 'taken', method: 'app', clientEventId: 'serving-hotfix-take' } });
    assert.equal(hotfixReplay.idempotentReplay, true);
    await apiRequest(server, '/v1/dose/action', { method: 'POST', token, body: { doseId: dose, action: 'undo' } });
    await stock(server, token, medication, 30);
    const hotfixLedger = (await sql(upgrade, `SELECT sum(delta)::int AS balance FROM stock_transactions WHERE medication_id=$1`, [medication])).rows[0];
    assert.equal(hotfixLedger.balance, 30);
    runtime.stop(server);

    console.info('Runtime recovery: restore original archive and run both recorded runtimes');
    await db.create(recovered);
    const restore = await db.restore(recovered);
    assert.deepEqual(await db.snapshot(recovered), baseline, 'recovery differs before any runtime starts');
    // A candidate migration hook must not be run on this recovered database.
    const refused = await runtime.start('candidate', recovered, 'api', { connectHttp: false });
    await until('candidate refuses restored old ledger', () => !runtime.inspect(refused.id).State.Running);
    assert.equal(runtime.inspect(refused.id).State.ExitCode, 1);
    assert.match(runtime.logs(refused), /schema is incompatible/);
    server = await api(recovered, 'oldApi');
    token = await session(server); // password credentials/session functions survived
    await stock(server, token, medication, 30);
    await gap(recovered, schedule);
    const recoveredWorker = await tick(recovered, 'oldWorker');
    assert.equal(recoveredWorker.uploadsAfter, 2, 'restoration must preserve the known old upload-cleanup limitation');
    assert.equal((await taken(server, token, dose, 'recovered-runtime-take')).stock.remainingQuantity, 29);
    const legacyRetakeLedger = (await sql(recovered, `SELECT count(*)::int AS rows,sum(delta)::int AS balance
      FROM stock_transactions WHERE medication_id=$1`, [medication])).rows[0];
    assert.deepEqual(legacyRetakeLedger, { rows: 3, balance: 30 },
      'recorded old API re-take ledger behavior changed');
    await undo(server, token, dose);
    await stock(server, token, medication, 30);
    runtime.stop(server);
    assert.equal((await ledger(recovered)).length, 34, 'restored ledger was upgraded by runtime startup');
    return { images: runtime.images, postgresVersion, baselineMigrations: 34, upgradedMigrations: expectedLedger.length,
      backup, restore, baselineWorker, candidateWorker, incompatibleWorker, recoveredWorker,
      legacyOnUpgradeHttpStatus: 500, servingHotfixOnUpgradeHttpStatus: 200, restoredCandidateExitCode: 1,
      legacyRetake: { liveBalance: 29, ledgerBalance: legacyRetakeLedger.balance, missingMovement: true },
      limits: { syntheticData: true, rebuiltImages: true, originalRenderImages: false,
        testConfiguration: true, productionBackup: false, realPush: false, installedDevices: false } };
  } finally {
    try { await runtime.stopAll(); }
    finally {
      try { if (db) await db.cleanup(); }
      finally { await runtime.cleanup(); }
    }
  }
}

exerciseRecovery().then(report => {
  // All owned databases, containers, networks and worktrees were cleaned up.
  console.info('RUNTIME RECOVERY REHEARSAL PASSED', JSON.stringify(report));
}).catch(error => {
  console.error('RUNTIME RECOVERY REHEARSAL FAILED', error);
  process.exitCode = 1;
});
