import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const post = (url: string, payload: object) => h.app.inject({ method: 'POST', url, headers: authHeaders(user), payload });
const get = (url: string) => h.app.inject({ method: 'GET', url, headers: authHeaders(user) });
const action = (doseId: string, type: string, key: string) => post('/v1/dose/action', { doseId, action: type, clientEventId: `${key}-${doseId}`, method: 'app', minutes: 15 });
const medBody = (name: string, tracked = true) => ({
  patientProfileId: user.profileId, name, form: 'tablet', startDate: date,
  schedule: { rule: { kind: 'fixed_times', times: ['08:00', '10:00', '12:00', '14:00'] }, doseQuantity: 6, doseUnit: 'tablet', startDate: date },
  ...(tracked ? { stock: { trackingEnabled: true, initialQuantity: 60, unit: 'tablet' } } : {}),
});
beforeAll(async () => { resetDatabase(); h = await startHarness(); user = await signIn(h, '+966500098601'); });
afterAll(async () => { await h?.close(); });

describe('final audit: real PostgreSQL medication/dose transactions', () => {
  it('replays simultaneous medication create and lost-response retry exactly once', async () => {
    const body = { ...medBody('Audit create identity'), clientRequestId: 'audit-create-retry-1', acknowledgeDuplicate: true };
    const requests = await Promise.all([post('/v1/medications', body), post('/v1/medications', body)]);
    for (const r of requests) expect(r.statusCode, r.body).toBe(200);
    expect(requests[0]!.json().medication.id).toBe(requests[1]!.json().medication.id);
    const retry = await post('/v1/medications', body);
    expect(retry.json().medication.id).toBe(requests[0]!.json().medication.id);
    expect(retry.json().idempotentReplay).toBe(true);
    const conflict = await post('/v1/medications', { ...body, name: 'Changed input must not overwrite' });
    expect(conflict.statusCode, conflict.body).toBe(409);
    const list = await get(`/v1/medications?profileId=${user.profileId}`);
    expect(list.json().medications.filter((m: { name: string }) => m.name === body.name)).toHaveLength(1);
    // SQL CHECK must reject one-null identities; NULL must not pass by UNKNOWN.
    await expect(withUser(user.userId, (tx) => tx.query(
      'UPDATE medications SET create_request_hash = NULL WHERE id = $1', [retry.json().medication.id],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('round-trips twelve explicit daily times and rejects duplicate or excess entries', async () => {
    const body = medBody('Audit twelve appointments', false);
    body.schedule.rule.times = Array.from({ length: 12 }, (_, i) => `${String(i * 2).padStart(2, '0')}:17`);
    const created = await post('/v1/medications', body);
    expect(created.statusCode, created.body).toBe(200);
    const medication = (await get(`/v1/medications/${created.json().medication.id}`)).json();
    expect(medication.schedules[0].rule.times).toEqual(body.schedule.rule.times);
    expect(medication.schedules[0].doseQuantity).toBe(6);
    for (const times of [[...body.schedule.rule.times, '23:59'], ['08:00', '08:00']]) {
      const invalid = await post('/v1/medications', { ...body, name: 'Audit invalid appointments', schedule: { ...body.schedule, rule: { ...body.schedule.rule, times } } });
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
  });


  it('does not reverse a historic take when the current take consumed no tracked stock', async () => {
    const created = await post('/v1/medications', medBody('Audit tracking toggle'));
    expect(created.statusCode, created.body).toBe(200);
    const medicationId = created.json().medication.id;
    const doses = (await get(`/v1/doses?profileId=${user.profileId}&from=${date}&to=${date}`)).json().doses;
    const dose = doses.find((d: { medicationId: string }) => d.medicationId === medicationId);
    h.setNow(new Date(dose.scheduledAt));
    expect((await action(dose.id, 'taken', 'toggle-take-1')).statusCode).toBe(200);
    expect((await action(dose.id, 'undo', 'toggle-undo-1')).statusCode).toBe(200);
    // Prepare an existing disabled-tracking configuration in this isolated DB.
    // There is no PATCH /stock route; this is fixture setup, not UI evidence.
    await withUser(user.userId, (tx) => tx.query(
      'UPDATE medication_stock SET tracking_enabled = false WHERE medication_id = $1', [medicationId],
    ));
    expect((await action(dose.id, 'taken', 'toggle-take-2')).statusCode).toBe(200);
    expect((await action(dose.id, 'undo', 'toggle-undo-2')).statusCode).toBe(200);
    const stock = (await get(`/v1/medications/${medicationId}/stock`)).json();
    expect(stock.stock.remainingQuantity).toBe(60);
    expect(stock.transactions.filter((t: { reason: string }) => t.reason === 'dose_undone')).toHaveLength(1);
  });

  for (const tracked of [true, false]) it(`persists confirmation/readback/undo/retake and concurrent replay (stock=${tracked})`, async () => {
    const created = await post('/v1/medications', medBody(`Audit doses stock ${tracked}`, tracked));
    expect(created.statusCode, created.body).toBe(200);
    const medicationId = created.json().medication.id;
    const doses = (await get(`/v1/doses?profileId=${user.profileId}&from=${date}&to=${date}`)).json().doses
      .filter((d: { medicationId: string }) => d.medicationId === medicationId)
      .sort((a: { scheduledAt: string }, b: { scheduledAt: string }) => a.scheduledAt.localeCompare(b.scheduledAt));
    expect(doses).toHaveLength(4);
    const dose = doses[0];
    h.setNow(new Date(dose.scheduledAt));
    const takes = await Promise.all([action(dose.id, 'taken', 'audit-take-first-1'), action(dose.id, 'taken', 'audit-take-first-1')]);
    for (const r of takes) expect(r.statusCode, r.body).toBe(200);
    expect(takes.filter((r) => r.json().idempotentReplay)).toHaveLength(1);
    const readback = (await get(`/v1/doses?profileId=${user.profileId}&from=${date}&to=${date}`)).json().doses.find((d: { id: string }) => d.id === dose.id);
    expect(readback.status).toBe('taken');
    if (tracked) expect((await get(`/v1/medications/${medicationId}/stock`)).json().stock.remainingQuantity).toBe(54);
    expect((await action(dose.id, 'undo', 'audit-undo-first-1')).statusCode).toBe(200);
    expect((await action(dose.id, 'taken', 'audit-take-second-1')).statusCode).toBe(200);
    const replayUndo = await action(dose.id, 'undo', 'audit-undo-first-1');
    expect(replayUndo.statusCode, replayUndo.body).toBe(200);
    expect(replayUndo.json().status).toBe('taken');
    expect(replayUndo.json().idempotentReplay).toBe(true);
    expect((await action(dose.id, 'taken', 'audit-take-first-1')).json().idempotentReplay).toBe(true);
    if (tracked) {
      const stock = (await get(`/v1/medications/${medicationId}/stock`)).json();
      expect(stock.stock.remainingQuantity).toBe(54);
      expect(stock.transactions.filter((t: { reason: string }) => t.reason === 'dose_taken')).toHaveLength(2);
      expect(stock.transactions.filter((t: { reason: string }) => t.reason === 'dose_undone')).toHaveLength(1);
    }
    h.setNow(new Date(doses[1].scheduledAt));
    const snoozes = await Promise.all([action(doses[1].id, 'snooze', 'audit-snooze-retry-1'), action(doses[1].id, 'snooze', 'audit-snooze-retry-1')]);
    for (const r of snoozes) expect(r.statusCode, r.body).toBe(200);
    expect(snoozes.map((r) => r.json().snoozeCount)).toEqual([1, 1]);
    h.setNow(new Date(doses[2].scheduledAt));
    const skips = await Promise.all([action(doses[2].id, 'skip', 'audit-skip-retry-1'), action(doses[2].id, 'skip', 'audit-skip-retry-1')]);
    for (const r of skips) expect(r.statusCode, r.body).toBe(200);
  });
});
