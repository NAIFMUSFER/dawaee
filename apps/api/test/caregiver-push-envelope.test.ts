import { describe, expect, it } from 'vitest';
import type { PushMessage } from '@dawaee/api/providers';
import { claimDeliveries, dispatchJob } from '../../worker/src/jobs/dispatcher.js';

type Delivery = Awaited<ReturnType<typeof claimDeliveries>>[number];
const PATIENT = 'PRIVATE_PATIENT_SENTINEL';
const MEDICATION = 'PRIVATE_MEDICATION_SENTINEL';
const DOSE = '00000000-0000-4000-8000-000000000041';
const DELIVERY = '00000000-0000-4000-8000-000000000042';
const LEASE = '00000000-0000-4000-8000-000000000043';

function harness(options: {
  row?: Partial<Delivery>;
  authorized?: boolean;
  showMedication?: boolean;
  devices?: number;
  resolvesDuringDeviceLookup?: boolean;
  stillPending?: boolean;
} = {}) {
  const row: Delivery = {
    id: DELIVERY, patient_profile_id: 'profile', recipient_user_id: 'caregiver',
    recipient_phone_e164: null, relationship_id: 'relationship',
    kind: 'escalation', channel: 'push', locale: 'ar',
    title: `Follow up ${PATIENT}`, body: `${PATIENT}: ${MEDICATION} at 08:00`,
    payload: {
      patientName: PATIENT, medicationName: MEDICATION, doseId: DOSE,
      scheduledLocalTime: '08:00', actions: ['taken'],
    },
    attempts: 1, max_attempts: 3, lease_token: LEASE,
    ...options.row,
  };
  const messages: PushMessage[] = [];
  const finalizations: string[] = [];
  let stillPending = options.stillPending ?? true;
  const query = async (sql: string, params: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('RETURNING d.id')) return { rows: [row], rowCount: 1 };
    if (sql.includes('SELECT permissions')) {
      return { rows: options.authorized === false ? [] : [{
        permissions: ['receive_notifications', 'view_medications', 'view_adherence', 'view_schedule'],
      }], rowCount: 1 };
    }
    if (sql.includes('app.list_live_push_endpoints')) {
      if (options.resolvesDuringDeviceLookup) stillPending = false;
      return { rows: Array.from({ length: options.devices ?? 1 }, (_, i) => ({
        push_token_id: `endpoint-${i}`, token: `ExponentPushToken[test-${i}]`,
      })), rowCount: 1 };
    }
    if (sql.includes('AS show_medication')) {
      return { rows: [{ show_medication: options.showMedication ?? true }], rowCount: 1 };
    }
    if (sql.includes('AS can_view_medication')) {
      return { rows: [{ can_view_medication: true }], rowCount: 1 };
    }
    if (sql.includes('AS still_pending')) {
      expect(params).toEqual([DELIVERY, LEASE, new Date('2026-09-14T05:30:00Z')]);
      expect(sql).toContain('JOIN dose_occurrences');
      expect(sql).toContain("nd.status = 'sending'");
      expect(sql).toContain('nd.lease_token = $2');
      expect(sql).toContain("'taken','taken_late','skipped','cancelled'");
      expect(sql).toContain('d.snoozed_until IS NULL OR d.snoozed_until <= $3::timestamptz');
      return { rows: [{ still_pending: stillPending }], rowCount: 1 };
    }
    if (sql.includes('UPDATE notification_deliveries')) {
      finalizations.push(sql);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in caregiver push regression: ${sql}`);
  };
  const client = { query, release() {} };
  const ctx = {
    now: () => new Date('2026-09-14T05:30:00Z'),
    pool: { connect: async () => client },
    log: { info() {}, warn() {} },
    providers: { push: {
      name: 'test-expo',
      send: async (batch: PushMessage[]) => {
        messages.push(...batch);
        return batch.map((_, i) => ({ ok: true, providerMessageId: `ticket-${i}` }));
      },
    } },
  };
  return {
    row, messages, finalizations,
    run: () => dispatchJob(
      ctx as unknown as Parameters<typeof dispatchJob>[0],
      client as unknown as Parameters<typeof dispatchJob>[1],
    ),
  };
}

function expectPrivateEnvelope(message: PushMessage, locale: 'ar' | 'en', kind = 'escalation') {
  expect(message.title).toBe(locale === 'en' ? 'Dawaee — Follow-up alert' : 'دوائي — تنبيه متابعة');
  expect(message.body).toBe(locale === 'en'
    ? 'You have a follow-up alert. Open Dawaee to view the details.'
    : 'لديك تنبيه يحتاج إلى متابعتك. افتح دوائي لعرض التفاصيل.');
  expect(message.data).toEqual({ deliveryId: DELIVERY, kind });
  expect(message.categoryId).toBeUndefined();
  const serialized = JSON.stringify(message);
  for (const sensitive of [PATIENT, MEDICATION, DOSE, '08:00', 'taken']) {
    expect(serialized).not.toContain(sensitive);
  }
}

describe('caregiver provider-bound push envelope', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`sends generic ${locale} content even when medication disclosure is enabled`, async () => {
      const h = harness({ row: { locale }, devices: 2 });
      expect(await h.run()).toEqual({ itemsProcessed: 1 });
      expect(h.messages).toHaveLength(2);
      for (const message of h.messages) expectPrivateEnvelope(message, locale);
      // Keep the authenticated in-app record intact; redact the provider envelope only.
      expect(h.row.body).toContain(PATIENT);
      expect(h.row.payload.medicationName).toBe(MEDICATION);
    });
  }

  it('does not leak the patient name when medication disclosure is disabled', async () => {
    const h = harness({ showMedication: false });
    await h.run();
    expectPrivateEnvelope(h.messages[0]!, 'ar');
  });

  it('ignores grouped clinical payloads on a caregiver delivery', async () => {
    const h = harness({ row: { payload: {
      grouped: true, doseIds: [DOSE], patientName: PATIENT,
      medications: [{ name: MEDICATION }], actions: ['taken'],
    } } });
    await h.run();
    expectPrivateEnvelope(h.messages[0]!, 'ar');
  });

  for (const kind of ['daily_summary', 'weekly_summary']) {
    it(`also protects relationship-bound ${kind} notifications`, async () => {
      const h = harness({ row: { kind } });
      await h.run();
      expectPrivateEnvelope(h.messages[0]!, 'ar', kind);
    });
  }

  it('falls back to Arabic for an unrecognized locale', async () => {
    const h = harness({ row: { locale: 'unknown' } });
    await h.run();
    expectPrivateEnvelope(h.messages[0]!, 'ar');
  });

  it('preserves the patient single-dose action contract', async () => {
    const h = harness({ row: { relationship_id: null, kind: 'dose_reminder' } });
    await h.run();
    expect(h.messages[0]!.body).toBe(h.row.body);
    expect(h.messages[0]!.data?.doseId).toBe(DOSE);
    expect(h.messages[0]!.categoryId).toBe('MEDICATION_REMINDER');
  });

  it('preserves grouped patient reminders without single-dose actions', async () => {
    const h = harness({ row: {
      relationship_id: null, kind: 'dose_reminder', payload: { grouped: true, doseIds: [DOSE], actions: [] },
    } });
    await h.run();
    expect(h.messages[0]!.data?.kind).toBe('dose_group_reminder');
    expect(h.messages[0]!.data?.doseIds).toBe(JSON.stringify([DOSE]));
    expect(h.messages[0]!.categoryId).toBeUndefined();
  });

  it('does not send after caregiver access is revoked', async () => {
    const h = harness({ authorized: false });
    expect(await h.run()).toEqual({ itemsProcessed: 0 });
    expect(h.messages).toHaveLength(0);
    expect(h.finalizations[0]).toContain("status = 'skipped'");
  });

  it('does not call the provider without a live registered device', async () => {
    const h = harness({ devices: 0 });
    expect(await h.run()).toEqual({ itemsProcessed: 0 });
    expect(h.messages).toHaveLength(0);
  });

  it('skips an escalation when the dose is confirmed during device lookup', async () => {
    const h = harness({ resolvesDuringDeviceLookup: true });
    expect(await h.run()).toEqual({ itemsProcessed: 0 });
    expect(h.messages).toHaveLength(0);
    expect(h.finalizations[0]).toContain("status = 'skipped'");
  });

  it('fails closed for an escalation with no pending dose/current lease', async () => {
    const h = harness({ stillPending: false });
    expect(await h.run()).toEqual({ itemsProcessed: 0 });
    expect(h.messages).toHaveLength(0);
    expect(h.finalizations[0]).toContain("status = 'skipped'");
  });
});
