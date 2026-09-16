import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

const RIYADH = 'Asia/Riyadh';
const BASE = (() => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = f.format(new Date()).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
})();
const day = (offset: number) => new Date(BASE + offset * 86_400_000).toISOString().slice(0, 10);

type DoseRef = { id: string; scheduledAt: string };

let h: Harness;
let owner: TestUser;
let stranger: TestUser;
let doses: DoseRef[] = [];
let medicationId: string;

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966500092701');
  stranger = await signIn(h, '+966500092702');
  const startDate = day(7);

  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(owner),
    payload: {
      patientProfileId: owner.profileId,
      name: 'Fixed path dose transport', form: 'tablet', startDate,
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '10:00', '12:00', '14:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate,
      },
    },
  });
  expect(med.statusCode, med.body).toBe(200);
  medicationId = med.json().medication.id;

  const list = await h.app.inject({
    method: 'GET',
    url: `/v1/doses?profileId=${owner.profileId}&from=${startDate}&to=${startDate}`,
    headers: authHeaders(owner),
  });
  expect(list.statusCode, list.body).toBe(200);
  doses = list.json<{ doses: DoseRef[] }>().doses.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  expect(doses).toHaveLength(4);
}, 120_000);

afterAll(async () => { await h.close(); });

function atDose(dose: DoseRef): void {
  h.setServerNow(new Date(dose.scheduledAt));
}

function action(payload: Record<string, unknown>, user = owner) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/dose/action',
    headers: authHeaders(user),
    payload,
  });
}

describe('fixed-path dose action transport', () => {
  it('requires authentication before accepting body routing metadata', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/dose/action',
      payload: { doseId: doses[0]!.id, action: 'taken', clientEventId: 'private-dose-no-auth-1' },
    });
    expect(res.statusCode, res.body).toBe(401);
  });

  it('does not let another account act on a dose supplied in the body', async () => {
    const dose = doses[0]!;
    atDose(dose);
    const res = await action({
      doseId: dose.id, action: 'taken', clientEventId: 'private-dose-stranger-1', method: 'app',
    }, stranger);
    expect([403, 404]).toContain(res.statusCode);
  });

  it('takes and undoes through one stable public path', async () => {
    const dose = doses[0]!;
    atDose(dose);
    const taken = await action({
      doseId: dose.id, action: 'taken', clientEventId: 'private-dose-taken-1', method: 'app',
      takenAt: dose.scheduledAt,
    });
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json<{ status: string }>().status).toBe('taken');

    const today = await h.app.inject({
      method: 'GET', url: '/v1/today',
      headers: { ...authHeaders(owner), 'x-dawaee-profile-id': owner.profileId },
    });
    expect(today.statusCode, today.body).toBe(200);
    const snapshot = today.json<{ next: DoseRef | null; today: Array<DoseRef & { status: string }> }>();
    expect(snapshot.today.find((item) => item.id === dose.id)?.status).toBe('taken');
    expect(snapshot.next?.id).not.toBe(dose.id);

    const replay = await action({
      doseId: dose.id, action: 'taken', clientEventId: 'private-dose-taken-1', method: 'app',
      takenAt: dose.scheduledAt,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);

    const undone = await action({ doseId: dose.id, action: 'undo' });
    expect(undone.statusCode, undone.body).toBe(200);
  });

  it('snoozes and skips without encoding either action or id in the URL', async () => {
    const snoozeDose = doses[1]!;
    atDose(snoozeDose);
    const snoozed = await action({
      doseId: snoozeDose.id, action: 'snooze', minutes: 15,
      clientEventId: 'private-dose-snooze-1',
    });
    expect(snoozed.statusCode, snoozed.body).toBe(200);

    const skippedDose = doses[2]!;
    atDose(skippedDose);
    const skipped = await action({
      doseId: skippedDose.id, action: 'skip', clientEventId: 'private-dose-skip-1',
    });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(skipped.json<{ status: string }>().status).toBe('skipped');
  });

  it('rejects malformed ids and unknown action names at the request edge', async () => {
    expect((await action({ doseId: 'not-a-uuid', action: 'taken', clientEventId: 'private-dose-bad-id-1' })).statusCode)
      .toBe(400);
    expect((await action({ doseId: doses[3]!.id, action: 'admin_override' })).statusCode).toBe(400);
  });

  it('confirms tracked stock and undoes when the legacy ledger index is absent', async () => {
    // Synthetic test database only: simulate the changed index contract that
    // caused production SQLSTATE 42P10. Never alter a live database here.
    execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'dawaee_test', '-c',
      'DROP INDEX public.stock_tx_dose_idx'], {
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5433', PGUSER: 'postgres' },
      stdio: 'pipe',
    });
    const dose = doses[3]!;
    atDose(dose);
    const stock = async () => {
      const res = await h.app.inject({
        method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(owner),
      });
      expect(res.statusCode, res.body).toBe(200);
      return Number(res.json().stock.remainingQuantity);
    };
    const before = await stock();
    const payload = {
      doseId: dose.id, action: 'taken', clientEventId: 'tracked-stock-compatible-1',
      method: 'app', takenAt: dose.scheduledAt,
    };
    const taken = await action(payload);
    expect(taken.statusCode, taken.body).toBe(200);
    expect(await stock()).toBe(before - 1);
    const replay = await action(payload);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);
    expect(await stock()).toBe(before - 1);
    const today = await h.app.inject({
      method: 'GET', url: '/v1/today',
      headers: { ...authHeaders(owner), 'x-dawaee-profile-id': owner.profileId },
    });
    expect(today.statusCode, today.body).toBe(200);
    expect(today.json().today.find((d: DoseRef) => d.id === dose.id).status).toBe('taken');
    expect(today.json().next?.id).not.toBe(dose.id);
    const undo = await action({ doseId: dose.id, action: 'undo' });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await stock()).toBe(before);
  });
});
