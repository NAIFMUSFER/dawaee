import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';

vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withUser: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid),
  withUserReadOnly: (uid: string, fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db, 'dawaee_app', fn, uid, true),
}));
vi.mock('../src/middleware/context.js', () => ({
  authenticate: async (req: any) => { if (!req.headers['x-test-user']) throw AppError.unauthenticated(); },
  currentUser: (req: any) => ({ userId: req.headers['x-test-user'] }),
}));
import { AppError } from '@dawaee/shared';
import { registerCaregiverRoutes } from '../src/routes/caregivers.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';

let db: PGlite;
const app = Fastify();
let patient: string, recipient: string, stranger: string, profile: string;
const owner = (sql: string, values: unknown[] = []) => auditTransaction(db, 'dawaee_migrator', tx => tx.query(sql, values));
const send = (url: string, payload: object, uid: string | null = recipient) => app.inject({ method: 'POST', url, payload, headers: uid ? { 'x-test-user': uid } : {} });
beforeAll(async () => {
  db = await createAuditDatabase(); registerErrorHandler(app); registerCaregiverRoutes(app); await app.ready();
}, 60_000);
beforeEach(async () => {
  patient = randomUUID(); recipient = randomUUID(); stranger = randomUUID(); profile = randomUUID();
  for (const uid of [patient, recipient, stranger]) {
    await owner('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [uid, `${uid}@example.test`, 'Invitation fixture']);
    await owner('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)', [uid, `${uid}@example.test`]);
  }
  await owner("INSERT INTO patient_profiles(id,owner_user_id,display_name,is_self,timezone,home_timezone) VALUES($1,$2,'Patient fixture',true,'Asia/Riyadh','Asia/Riyadh')", [profile, patient]);
});
afterAll(async () => { await app.close(); await db?.close(); });
async function invite() {
  const response = await send('/v1/caregivers/invite', { patientProfileId: profile, invitedName: 'Recipient', invitedEmail: `${recipient}@example.test`, role: 'caregiver', permissions: ['view_schedule'], escalationPriority: 1 }, patient);
  expect(response.statusCode, response.body).toBe(200);
  return { id: response.json().relationshipId as string, token: response.json().invitationLink.split('/invite/')[1] as string };
}
describe('F19: every HTTP acceptance requires the reviewed permission set', () => {
  it.each(['/v1/caregivers/accept', '/v1/caregivers/incoming/accept'])('refuses legacy %s without consuming or disclosing the invitation', async url => {
    const invitation = await invite();
    const payload = url.endsWith('/incoming/accept') ? { relationshipId: invitation.id } : { token: invitation.token };
    expect((await send(url, payload, null)).statusCode).toBe(401);
    const intended = await send(url, payload);
    const wrong = await send(url, payload, stranger);
    expect(intended.statusCode).toBe(409);
    expect(intended.json().error.code).toBe('invitation_changed');
    expect({ status: wrong.statusCode, code: wrong.json().error.code, message: wrong.json().error.message }).toEqual({ status: intended.statusCode, code: intended.json().error.code, message: intended.json().error.message });
    const state = await owner('SELECT status,caregiver_user_id,invitation_token_hash FROM caregiver_relationships WHERE id=$1', [invitation.id]);
    expect(state.rows[0]).toMatchObject({ status: 'pending', caregiver_user_id: null });
    expect(state.rows[0].invitation_token_hash).toBeTruthy();
    expect((await send('/v1/caregivers/invitations/preview', { token: invitation.token })).statusCode).toBe(200);
  });
  it('rejects changed permissions, requires a fresh review and keeps accepted retries idempotent', async () => {
    const invitation = await invite();
    expect((await send('/v1/caregivers/invitations/preview', { token: invitation.token }, stranger)).statusCode).toBe(404);
    const preview = (await send('/v1/caregivers/invitations/preview', { token: invitation.token })).json();
    const consent = { relationshipId: preview.id, role: preview.role, permissions: preview.permissions };
    expect((await send('/v1/caregivers/invitations/accept', { relationshipId: preview.id })).statusCode).toBe(400);
    await owner("UPDATE caregiver_relationships SET permissions=ARRAY['view_schedule','view_medications'] WHERE id=$1", [invitation.id]);
    expect((await send('/v1/caregivers/invitations/accept', consent)).statusCode).toBe(409);
    const fresh = (await send('/v1/caregivers/invitations/preview', { relationshipId: invitation.id })).json();
    const reviewed = { relationshipId: fresh.id, role: fresh.role, permissions: fresh.permissions };
    const accepted = await send('/v1/caregivers/invitations/accept', reviewed);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await send('/v1/caregivers/invitations/accept', reviewed)).json()).toEqual(accepted.json());
    expect((await owner('SELECT status,caregiver_user_id FROM caregiver_relationships WHERE id=$1', [invitation.id])).rows[0]).toEqual({ status: 'active', caregiver_user_id: recipient });
    await owner("UPDATE caregiver_relationships SET status='revoked' WHERE id=$1", [invitation.id]);
    expect((await send('/v1/caregivers/invitations/accept', reviewed)).statusCode).toBe(404);
  });
  it.each(['wrong-user', 'unverified-email', 'expired', 'archived', 'self'])('refuses direct reviewed acceptance for %s', async failure => {
    const invitation = await invite();
    const shown = (await send('/v1/caregivers/invitations/preview', { token: invitation.token })).json();
    const consent = { relationshipId: shown.id, role: shown.role, permissions: shown.permissions };
    if (failure === 'unverified-email') await owner('DELETE FROM user_email_verifications WHERE user_id=$1', [recipient]);
    if (failure === 'expired') await owner("UPDATE caregiver_relationships SET invitation_expires_at=now()-interval '1 second' WHERE id=$1", [invitation.id]);
    if (failure === 'archived') await owner('UPDATE patient_profiles SET archived_at=now() WHERE id=$1', [profile]);
    if (failure === 'self') await owner('UPDATE patient_profiles SET owner_user_id=$1 WHERE id=$2', [recipient, profile]);
    expect((await send('/v1/caregivers/invitations/accept', consent, failure === 'wrong-user' ? stranger : recipient)).statusCode).toBe(failure === 'expired' ? 410 : 404);
    expect((await owner('SELECT status FROM caregiver_relationships WHERE id=$1', [invitation.id])).rows[0].status).toBe('pending');
  });
  it('refuses a missing invitation at both current boundaries', async () => {
    expect((await send('/v1/caregivers/invitations/preview', { token: 'x'.repeat(43) })).statusCode).toBe(404);
    expect((await send('/v1/caregivers/invitations/accept', { relationshipId: randomUUID(), role: 'caregiver', permissions: ['view_schedule'] })).statusCode).toBe(404);
  });
});
