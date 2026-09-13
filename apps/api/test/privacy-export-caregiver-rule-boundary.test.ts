import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';

/**
 * Completeness must not weaken the owner-only, single-profile export boundary.
 * Seed only the disposable harness database, through the ordinary app role and
 * parameterized queries. No provider call or production credential is used.
 */
type RuleRow = Record<string, unknown>;
type ExportPayload = { profileId: string; data: { caregiverNotificationRules: RuleRow[] } };
type Fixture = { relationshipId: string; pushId: string; disabledId: string };

let h: Harness;
let owner: TestUser;
let caregiver: TestUser;
let otherOwner: TestUser;
let siblingProfileId: string;
let emptyProfileId: string;
let primary: Fixture;
let sibling: Fixture;
let unrelated: Fixture;

const RULE_FIELDS = [
  'id', 'relationship_id', 'patient_profile_id', 'channel', 'mode',
  'consecutive_missed_threshold', 'summary_time', 'quiet_hours_start',
  'quiet_hours_end', 'enabled', 'updated_at',
].sort();

async function createOwnedProfile(displayName: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/profiles', headers: authHeaders(owner),
    payload: { displayName, timezone: 'Asia/Riyadh', isSelf: false },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ profile: { id: string } }>().profile.id;
}

async function seedRules(user: TestUser, profileId: string, label: string): Promise<Fixture> {
  return withUser(user.userId, async (tx) => {
    const { rows: relationships } = await tx.query<{ id: string }>(
      `INSERT INTO caregiver_relationships
         (patient_profile_id, caregiver_user_id, invited_name, role, status,
          permissions, escalation_priority, invited_by_user_id, accepted_at)
       VALUES ($1,$2,$3,'caregiver','active',ARRAY['view_reports'],1,$4,now())
       RETURNING id`,
      [profileId, caregiver.userId, label, user.userId],
    );
    const relationshipId = relationships[0]!.id;
    // A disabled historical remote channel is data, not a promise to send it.
    // It must remain exportable even though that provider is unavailable.
    const { rows } = await tx.query<{ id: string; channel: string }>(
      `INSERT INTO caregiver_notification_rules
         (relationship_id, patient_profile_id, channel, mode,
          consecutive_missed_threshold, summary_time, quiet_hours_start,
          quiet_hours_end, enabled)
       VALUES ($1,$2,'push','daily_summary',3,'18:45','22:00','06:30',true),
              ($1,$2,'whatsapp','missed_only',2,NULL,NULL,NULL,false)
       RETURNING id, channel::text AS channel`,
      [relationshipId, profileId],
    );
    return {
      relationshipId,
      pushId: rows.find((row) => row.channel === 'push')!.id,
      disabledId: rows.find((row) => row.channel === 'whatsapp')!.id,
    };
  });
}

function exportRequest(user: TestUser, profileId: string) {
  return h.app.inject({
    method: 'GET', url: '/v1/reports/export',
    headers: { ...authHeaders(user), [PROFILE_ID_HEADER]: profileId },
  });
}

async function exportedRules(user: TestUser, profileId: string): Promise<RuleRow[]> {
  const res = await exportRequest(user, profileId);
  expect(res.statusCode, res.body).toBe(200);
  const payload = res.json<ExportPayload>();
  expect(payload.profileId).toBe(profileId);
  expect(Array.isArray(payload.data.caregiverNotificationRules)).toBe(true);
  return payload.data.caregiverNotificationRules;
}

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = await signIn(h, '+966500096801');
  caregiver = await signIn(h, '+966500096802');
  otherOwner = await signIn(h, '+966500096803');
  siblingProfileId = await createOwnedProfile('SYNTHETIC-EXPORT-SIBLING');
  emptyProfileId = await createOwnedProfile('SYNTHETIC-EXPORT-EMPTY');
  primary = await seedRules(owner, owner.profileId, 'SYNTHETIC-PRIMARY-HELPER');
  sibling = await seedRules(owner, siblingProfileId, 'SYNTHETIC-SIBLING-HELPER');
  unrelated = await seedRules(otherOwner, otherOwner.profileId, 'SYNTHETIC-UNRELATED-HELPER');
}, 120_000);

afterAll(async () => { if (h) await h.close(); });

describe('privacy export caregiver notification rule boundary', () => {
  it('includes the actual saved rule fields through the fixed-path profile header', async () => {
    const rows = await exportedRules(owner, owner.profileId);
    expect(rows).toHaveLength(2);
    const rule = rows.find((row) => row.id === primary.pushId);
    expect(rule).toEqual(expect.objectContaining({
      id: primary.pushId,
      relationship_id: primary.relationshipId,
      patient_profile_id: owner.profileId,
      channel: 'push', mode: 'daily_summary', consecutive_missed_threshold: 3,
      summary_time: '18:45', quiet_hours_start: '22:00', quiet_hours_end: '06:30',
      enabled: true, updated_at: expect.any(String),
    }));
    // An export of rules must not grow a relationship-token or credential join.
    expect(Object.keys(rule!).sort()).toEqual(RULE_FIELDS);
  });

  it('preserves disabled historical rules and explicit null scheduling fields', async () => {
    const rows = await exportedRules(owner, owner.profileId);
    expect(rows).toContainEqual(expect.objectContaining({
      id: primary.disabledId,
      relationship_id: primary.relationshipId,
      patient_profile_id: owner.profileId,
      channel: 'whatsapp', mode: 'missed_only', consecutive_missed_threshold: 2,
      summary_time: null, quiet_hours_start: null, quiet_hours_end: null,
      enabled: false,
    }));
  });

  it('does not mix two profiles owned by the same account', async () => {
    // RLS permits the owner to read BOTH profiles, so this also checks the
    // export query's explicit profile predicate rather than relying on RLS.
    const first = await exportedRules(owner, owner.profileId);
    const second = await exportedRules(owner, siblingProfileId);
    expect(first.map((row) => row.id).sort()).toEqual([primary.pushId, primary.disabledId].sort());
    expect(second.map((row) => row.id).sort()).toEqual([sibling.pushId, sibling.disabledId].sort());
    expect(first.every((row) => row.patient_profile_id === owner.profileId)).toBe(true);
    expect(second.every((row) => row.patient_profile_id === siblingProfileId)).toBe(true);
  });

  it('exports the other owner\'s nonempty controls without another account\'s rows', async () => {
    const rows = await exportedRules(otherOwner, otherOwner.profileId);
    expect(rows.map((row) => row.id).sort()).toEqual([unrelated.pushId, unrelated.disabledId].sort());
    expect(rows.every((row) => row.patient_profile_id === otherOwner.profileId)).toBe(true);
  });

  it('returns an empty collection instead of omitting the key for an empty profile', async () => {
    expect(await exportedRules(owner, emptyProfileId)).toEqual([]);
  });

  it('does not let view_reports permission grant a caregiver the full privacy export', async () => {
    const res = await exportRequest(caregiver, owner.profileId);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).not.toHaveProperty('data');
  });

  it('does not expose an unrelated profile to an authenticated account', async () => {
    const res = await exportRequest(otherOwner, owner.profileId);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).not.toHaveProperty('data');
  });

  it('requires authentication even when valid profile routing metadata is present', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/v1/reports/export',
      headers: { [PROFILE_ID_HEADER]: owner.profileId },
    });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json()).not.toHaveProperty('data');
  });

  it('keeps the legacy query and fixed-path transport consistent during rollout', async () => {
    const current = await exportedRules(owner, owner.profileId);
    const legacy = await h.app.inject({
      method: 'GET', url: `/v1/reports/export?profileId=${owner.profileId}`,
      headers: authHeaders(owner),
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    const rows = legacy.json<ExportPayload>().data.caregiverNotificationRules;
    const byId = (values: RuleRow[]) => [...values].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(byId(rows)).toEqual(byId(current));
  });
});
