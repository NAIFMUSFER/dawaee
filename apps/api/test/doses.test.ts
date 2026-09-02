import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let user: TestUser;
let medicationId: string;

async function doseIds(from: string, to: string): Promise<Array<{ id: string; status: string; scheduledAt: string }>> {
  const res = await h.app.inject({
    method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=${from}&to=${to}`, headers: authHeaders(user),
  });
  return res.json().doses;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  user = await signIn(h, '0544000001');
  const med = await h.app.inject({
    method: 'POST', url: '/v1/medications', headers: authHeaders(user),
    payload: {
      patientProfileId: user.profileId, name: 'Panadol', form: 'tablet',
      strengthValue: 500, strengthUnit: 'mg', startDate: '2026-09-01',
      schedule: {
        rule: { kind: 'fixed_times', times: ['08:00', '14:00', '22:00'] },
        doseQuantity: 1, doseUnit: 'tablet', startDate: '2026-09-01',
      },
      stock: { trackingEnabled: true, initialQuantity: 30, unit: 'tablet' },
    },
  });
  medicationId = med.json().medication.id;
});
afterAll(async () => {
  await h.close();
});

describe('dose actions', () => {
  it('confirms, snoozes and skips distinct doses', async () => {
    const doses = await doseIds('2026-09-10', '2026-09-12');
    const [a, b, c] = doses;

    const taken = await h.app.inject({
      method: 'POST', url: `/v1/doses/${a!.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-taken-a1', method: 'app' },
    });
    expect(taken.statusCode).toBe(200);

    const snoozed = await h.app.inject({
      method: 'POST', url: `/v1/doses/${b!.id}/snooze`, headers: authHeaders(user),
      payload: { minutes: 15, clientEventId: 'evt-snooze-b1' },
    });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json().snoozeCount).toBe(1);

    const skipped = await h.app.inject({
      method: 'POST', url: `/v1/doses/${c!.id}/skip`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-skip-c1', reason: 'Away from home' },
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().status).toBe('skipped');
  });

  it('refuses to record the same dose twice', async () => {
    const doses = await doseIds('2026-09-13', '2026-09-13');
    const dose = doses[0]!;
    await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-dup-1', method: 'app' },
    });
    const second = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-dup-2', method: 'app' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('dose_already_resolved');
  });

  it('rejects a low-confidence voice confirmation and accepts a confident one', async () => {
    const doses = await doseIds('2026-09-14', '2026-09-14');
    const low = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doses[0]!.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-voice-low', method: 'voice', voiceConfidence: 0.4 },
    });
    expect(low.statusCode).toBe(422);
    expect(low.json().error.code).toBe('voice_confidence_too_low');

    const high = await h.app.inject({
      method: 'POST', url: `/v1/doses/${doses[0]!.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-voice-high', method: 'voice', voiceConfidence: 0.95 },
    });
    expect(high.statusCode).toBe(200);
  });

  it('undoes a confirmation inside the window and restores stock', async () => {
    const doses = await doseIds('2026-09-15', '2026-09-15');
    const dose = doses[0]!;

    const before = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    const beforeQty = before.json().stock.remainingQuantity;

    await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/taken`, headers: authHeaders(user),
      payload: { clientEventId: 'evt-undo-1', method: 'app' },
    });
    const undo = await h.app.inject({
      method: 'POST', url: `/v1/doses/${dose.id}/undo`, headers: authHeaders(user),
    });
    expect(undo.statusCode).toBe(200);

    const after = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    expect(after.json().stock.remainingQuantity).toBe(beforeQty);
  });

  it('caps repeated snoozing', async () => {
    const doses = await doseIds('2026-09-11', '2026-09-11');
    const dose = doses[1]!;
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const res = await h.app.inject({
        method: 'POST', url: `/v1/doses/${dose.id}/snooze`, headers: authHeaders(user),
        payload: { minutes: 5, clientEventId: `evt-snooze-cap-${i}` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(422);
  });
});

describe('offline replay', () => {
  it('applies a batch of queued actions and reports each result', async () => {
    const doses = await doseIds('2026-09-08', '2026-09-09');
    const payload = {
      deviceId: 'offline-device-1',
      actions: [
        { type: 'taken', doseOccurrenceId: doses[0]!.id, at: '2026-09-08T05:03:00.000Z', clientEventId: 'off-batch-1' },
        { type: 'skipped', doseOccurrenceId: doses[1]!.id, at: '2026-09-08T11:00:00.000Z', clientEventId: 'off-batch-2', reason: 'nausea' },
        { type: 'snoozed', doseOccurrenceId: doses[2]!.id, at: '2026-09-08T19:00:00.000Z', clientEventId: 'off-batch-3', minutes: 20 },
      ],
    };

    const res = await h.app.inject({
      method: 'POST', url: '/v1/doses/sync', headers: authHeaders(user), payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(3);
    expect(res.json().failed).toBe(0);
  });

  it('is idempotent when the device retries the whole batch', async () => {
    const doses = await doseIds('2026-09-08', '2026-09-09');
    const payload = {
      deviceId: 'offline-device-1',
      actions: [
        { type: 'taken', doseOccurrenceId: doses[0]!.id, at: '2026-09-08T05:03:00.000Z', clientEventId: 'off-batch-1' },
        { type: 'skipped', doseOccurrenceId: doses[1]!.id, at: '2026-09-08T11:00:00.000Z', clientEventId: 'off-batch-2', reason: 'nausea' },
      ],
    };
    const res = await h.app.inject({
      method: 'POST', url: '/v1/doses/sync', headers: authHeaders(user), payload,
    });
    expect(res.statusCode).toBe(200);
    // Everything is recognised as a replay; nothing is applied a second time.
    expect(res.json().replayed).toBe(2);
    expect(res.json().applied).toBe(0);
  });

  it('does not double-decrement stock on a replayed confirmation', async () => {
    const before = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    const qtyBefore = before.json().stock.remainingQuantity;

    const doses = await doseIds('2026-09-08', '2026-09-08');
    await h.app.inject({
      method: 'POST', url: '/v1/doses/sync', headers: authHeaders(user),
      payload: {
        deviceId: 'offline-device-1',
        actions: [{ type: 'taken', doseOccurrenceId: doses[0]!.id, at: '2026-09-08T05:03:00.000Z', clientEventId: 'off-batch-1' }],
      },
    });

    const after = await h.app.inject({
      method: 'GET', url: `/v1/medications/${medicationId}/stock`, headers: authHeaders(user),
    });
    expect(after.json().stock.remainingQuantity).toBe(qtyBefore);
  });

  it('fails one bad action without losing the good ones', async () => {
    const doses = await doseIds('2026-09-16', '2026-09-16');
    const res = await h.app.inject({
      method: 'POST', url: '/v1/doses/sync', headers: authHeaders(user),
      payload: {
        deviceId: 'offline-device-2',
        actions: [
          { type: 'taken', doseOccurrenceId: doses[0]!.id, at: '2026-09-16T05:00:00.000Z', clientEventId: 'mix-ok-1' },
          { type: 'taken', doseOccurrenceId: '00000000-0000-4000-8000-000000000000', at: '2026-09-16T05:00:00.000Z', clientEventId: 'mix-bad-1' },
          { type: 'taken', doseOccurrenceId: doses[1]!.id, at: '2026-09-16T11:00:00.000Z', clientEventId: 'mix-ok-2' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(2);
    expect(res.json().failed).toBe(1);
    expect(res.json().results[1].error).toBe('not_found');
  });
});

describe('missed doses and safety', () => {
  it('derives missed status from the clock even when the row is stale', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2026-09-02`,
      headers: authHeaders(user),
    });
    // These are in the past relative to the test clock.
    const statuses = res.json().doses.map((d: { status: string }) => d.status);
    expect(statuses.every((s: string) => s !== 'upcoming')).toBe(true);
  });

  it('offers no corrective dosing advice anywhere in a dose payload', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/doses?profileId=${user.profileId}&from=2026-09-01&to=2026-09-30`,
      headers: authHeaders(user),
    });
    const body = res.body.toLowerCase();
    for (const forbidden = ['double the', 'take two', 'skip the next', 'increase the dose'] as string[]; ;) {
      for (const phrase of forbidden) expect(body).not.toContain(phrase);
      break;
    }
  });
});

describe('adherence', () => {
  it('summarises with the non-diagnostic disclaimer attached', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/adherence?profileId=${user.profileId}&from=2026-09-01&to=2026-09-30`,
      headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.scheduled).toBeGreaterThan(0);
    expect(body.disclaimerKey).toBe('adherence.disclaimer');
    expect(Array.isArray(body.daily)).toBe(true);
  });

  it('refuses an unbounded date range', async () => {
    const res = await h.app.inject({
      method: 'GET', url: `/v1/adherence?profileId=${user.profileId}&from=2000-01-01&to=2030-01-01`,
      headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(400);
  });
});
