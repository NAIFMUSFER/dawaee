import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

type CardRow = Record<string, unknown>;
let h: Harness;
let owner: TestUser;
let outsider: TestUser;
let siblingProfileId: string;
let emptyProfileId: string;
let primaryCard: CardRow;
let siblingCard: CardRow;
const syntheticHash = (name: string) => createHash('sha256').update(`synthetic-export-card-${name}`).digest('hex');

/** This suite runs only in the existing resettable test database. The API's
 * authenticated card response is a positive control for the data that the
 * selected profile's complete privacy export must preserve. QR credentials
 * must remain excluded even when the rest of the card is exported. */
beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966500097790');
  outsider = await signIn(h, '+966500097791');

  async function createProfile(displayName: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST', url: '/v1/profiles', headers: authHeaders(owner),
      payload: { displayName, timezone: 'Asia/Riyadh', isSelf: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ profile: { id: string } }>().profile.id;
  }
  siblingProfileId = await createProfile('SYNTHETIC-EMERGENCY-EXPORT-SIBLING');
  emptyProfileId = await createProfile('SYNTHETIC-EMERGENCY-EXPORT-EMPTY');

  async function seedCard(profileId: string, primary: boolean): Promise<CardRow> {
    return withUser(owner.userId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO emergency_cards
           (patient_profile_id, conditions_note, include_conditions, qr_enabled,
            qr_token_hash, qr_rotated_at, qr_view_count, qr_last_viewed_at)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7)
         ON CONFLICT (patient_profile_id) DO UPDATE
           SET conditions_note = EXCLUDED.conditions_note,
               include_conditions = EXCLUDED.include_conditions,
               qr_enabled = EXCLUDED.qr_enabled,
               qr_token_hash = EXCLUDED.qr_token_hash,
               qr_rotated_at = EXCLUDED.qr_rotated_at,
               qr_view_count = EXCLUDED.qr_view_count,
               qr_last_viewed_at = EXCLUDED.qr_last_viewed_at
         RETURNING id, blood_type, allergies, conditions_note, emergency_contacts,
                   include_medications, include_allergies, include_contacts, include_conditions,
                   qr_enabled, qr_rotated_at, qr_view_count, qr_last_viewed_at, updated_at`,
        [
          profileId, primary ? 'SYNTHETIC-PRIMARY-NOTE' : 'SYNTHETIC-SIBLING-NOTE', primary,
          syntheticHash(primary ? 'primary' : 'sibling'),
          primary ? '2026-09-09T01:02:03.000Z' : null,
          primary ? 3 : 0,
          primary ? '2026-09-10T03:04:05.000Z' : null,
        ],
      );
      expect(rows).toHaveLength(1);
      // Match the real HTTP JSON boundary, including PostgreSQL timestamps.
      return JSON.parse(JSON.stringify(rows[0])) as CardRow;
    });
  }
  primaryCard = await seedCard(owner.profileId, true);
  siblingCard = await seedCard(siblingProfileId, false);
}, 120_000);

afterAll(async () => { if (h) await h.close(); });

async function exportCards(profileId: string): Promise<CardRow[]> {
  const res = await h.app.inject({
    method: 'GET', url: '/v1/reports/export',
    headers: { ...authHeaders(owner), [PROFILE_ID_HEADER]: profileId },
  });
  expect(res.statusCode, res.body).toBe(200);
  const payload = res.json<{ profileId: string; data: { emergencyCard: CardRow[] } }>();
  expect(payload.profileId).toBe(profileId);
  expect(Array.isArray(payload.data.emergencyCard)).toBe(true);
  return payload.data.emergencyCard;
}

describe('privacy export emergency card completeness and isolation', () => {
  it('positive control: the authenticated card API already exposes the missing profile data', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/emergency/card',
      headers: { ...authHeaders(owner), [PROFILE_ID_HEADER]: owner.profileId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ card: CardRow }>().card).toMatchObject({
      id: primaryCard.id,
      includeConditions: primaryCard.include_conditions,
      qrRotatedAt: primaryCard.qr_rotated_at,
      qrViewCount: primaryCard.qr_view_count,
      qrLastViewedAt: primaryCard.qr_last_viewed_at,
      updatedAt: primaryCard.updated_at,
    });
  });

  it.each([
    'include_conditions', 'qr_rotated_at', 'qr_view_count', 'qr_last_viewed_at', 'updated_at',
  ])('exports %s from the selected profile card', async (field) => {
    const cards = await exportCards(owner.profileId);
    expect(cards).toHaveLength(1);
    expect(primaryCard[field]).toBeDefined();
    expect(cards[0]).toHaveProperty(field, primaryCard[field]);
  });

  it('preserves explicit false, zero and null lifecycle values', async () => {
    const cards = await exportCards(siblingProfileId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: siblingCard.id,
      include_conditions: false,
      qr_rotated_at: null,
      qr_view_count: 0,
      qr_last_viewed_at: null,
      updated_at: siblingCard.updated_at,
    });
  });

  it('keeps sibling cards separate even when both profiles have the same owner', async () => {
    const primary = await exportCards(owner.profileId);
    const sibling = await exportCards(siblingProfileId);
    expect(primary.map((row) => row.id)).toEqual([primaryCard.id]);
    expect(sibling.map((row) => row.id)).toEqual([siblingCard.id]);
    expect(primary[0]).toMatchObject({ conditions_note: 'SYNTHETIC-PRIMARY-NOTE' });
    expect(sibling[0]).toMatchObject({ conditions_note: 'SYNTHETIC-SIBLING-NOTE' });
  });

  it('does not manufacture an emergency card for a profile without one', async () => {
    expect(await exportCards(emptyProfileId)).toEqual([]);
  });

  it('does not export QR credential hashes alongside the non-secret lifecycle data', async () => {
    for (const profileId of [owner.profileId, siblingProfileId]) {
      const cards = await exportCards(profileId);
      expect(cards).toHaveLength(1);
      expect(cards[0]).not.toHaveProperty('qr_token_hash');
      expect(JSON.stringify(cards)).not.toContain(syntheticHash('primary'));
      expect(JSON.stringify(cards)).not.toContain(syntheticHash('sibling'));
    }
  });

  it('does not return an export to an unrelated authenticated account', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/reports/export',
      headers: { ...authHeaders(outsider), [PROFILE_ID_HEADER]: owner.profileId },
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(res.json()).not.toHaveProperty('data');
    expect(res.body).not.toContain('SYNTHETIC-PRIMARY-NOTE');
  });
});
