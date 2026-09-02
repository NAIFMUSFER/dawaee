import { describe, expect, it } from 'vitest';
import {
  assertCan, assertOwner, can, detectHighRiskChanges, effectivePermissions, isInvitationUsable, resolveRole,
  type AccessContext,
} from '../src/authorization.js';

const profile = { id: 'p1', ownerUserId: 'owner', linkedUserId: null, archivedAt: null };

const ctx = (o: Partial<AccessContext> = {}): AccessContext => ({ userId: 'owner', profile, ...o });

describe('role resolution', () => {
  it('recognises the profile owner', () => {
    expect(resolveRole(ctx())).toBe('owner');
  });
  it('recognises a linked patient user as owner of their own profile', () => {
    expect(resolveRole(ctx({ userId: 'self', profile: { ...profile, linkedUserId: 'self' } }))).toBe('owner');
  });
  it('recognises an active caregiver', () => {
    const role = resolveRole(ctx({
      userId: 'son',
      relationship: { status: 'active', permissions: ['view_adherence'], invitationExpiresAt: null },
    }));
    expect(role).toBe('caregiver');
  });
  it('gives a pending or revoked caregiver no role at all', () => {
    for (const status of ['pending', 'revoked', 'declined', 'expired'] as const) {
      expect(resolveRole(ctx({ userId: 'son', relationship: { status, permissions: ['view_adherence'], invitationExpiresAt: null } })))
        .toBe('none');
    }
  });
  it('gives an unrelated user no role', () => {
    expect(resolveRole(ctx({ userId: 'stranger' }))).toBe('none');
  });
});

describe('permissions', () => {
  it('grants the owner everything implicitly', () => {
    expect(effectivePermissions(ctx()).has('manage_caregivers')).toBe(true);
    expect(effectivePermissions(ctx()).size).toBeGreaterThan(10);
  });

  it('grants a caregiver exactly what was configured', () => {
    const c = ctx({ userId: 'son', relationship: { status: 'active', permissions: ['view_adherence'], invitationExpiresAt: null } });
    expect(can(c, 'view_adherence')).toBe(true);
    expect(can(c, 'edit_schedule')).toBe(false);
    expect(can(c, 'manage_caregivers')).toBe(false);
  });

  it('grants a stranger nothing', () => {
    expect(effectivePermissions(ctx({ userId: 'stranger' })).size).toBe(0);
  });
});

describe('assertions', () => {
  it('hides the existence of another patient’s profile behind a 404', () => {
    try {
      assertCan(ctx({ userId: 'stranger' }), 'view_medications');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { statusCode: number }).statusCode).toBe(404);
    }
  });

  it('returns 403 when the caller has access but lacks the specific permission', () => {
    const c = ctx({ userId: 'son', relationship: { status: 'active', permissions: ['view_adherence'], invitationExpiresAt: null } });
    try {
      assertCan(c, 'edit_schedule');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { statusCode: number }).statusCode).toBe(403);
    }
  });

  it('lets a permitted caregiver through', () => {
    const c = ctx({ userId: 'son', relationship: { status: 'active', permissions: ['view_adherence'], invitationExpiresAt: null } });
    expect(() => assertCan(c, 'view_adherence')).not.toThrow();
  });

  it('reserves caregiver management for the owner', () => {
    expect(() => assertOwner(ctx())).not.toThrow();
    const nurse = ctx({
      userId: 'nurse',
      relationship: { status: 'active', permissions: ['manage_caregivers'], invitationExpiresAt: null },
    });
    expect(() => assertOwner(nurse)).toThrow();
  });
});

describe('invitations', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  it('accepts a live pending invitation', () => {
    expect(isInvitationUsable({ status: 'pending', invitationExpiresAt: '2026-09-03T12:00:00.000Z' }, now))
      .toEqual({ ok: true });
  });
  it('rejects an expired invitation', () => {
    expect(isInvitationUsable({ status: 'pending', invitationExpiresAt: '2026-09-01T12:00:00.000Z' }, now))
      .toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects an invitation with no expiry set', () => {
    expect(isInvitationUsable({ status: 'pending', invitationExpiresAt: null }, now).ok).toBe(false);
  });
  it('rejects re-use of an already accepted invitation', () => {
    expect(isInvitationUsable({ status: 'active', invitationExpiresAt: '2026-09-03T12:00:00.000Z' }, now))
      .toEqual({ ok: false, reason: 'not_pending' });
  });
});

describe('high-risk change detection', () => {
  it('flags a dose quantity change (the brief’s 1 → 2 tablet example)', () => {
    expect(detectHighRiskChanges({ before: { doseQuantity: 1 }, after: { doseQuantity: 2 } }))
      .toEqual(['dose_quantity']);
  });
  it('flags a schedule change', () => {
    expect(detectHighRiskChanges({ before: { ruleJson: '{"a":1}' }, after: { ruleJson: '{"a":2}' } }))
      .toEqual(['schedule_timing']);
  });
  it('flags a medication identity change', () => {
    expect(detectHighRiskChanges({ before: { name: 'Panadol' }, after: { name: 'Metformin' } }))
      .toEqual(['medication_identity']);
  });
  it('flags several changes at once', () => {
    const changes = detectHighRiskChanges({
      before: { doseQuantity: 1, doseUnit: 'tablet', strengthValue: 500 },
      after: { doseQuantity: 2, doseUnit: 'capsule', strengthValue: 1000 },
    });
    expect(changes).toEqual(['dose_quantity', 'dose_unit', 'strength']);
  });
  it('ignores cosmetic edits', () => {
    expect(detectHighRiskChanges({ before: { name: 'Panadol ' }, after: { name: 'Panadol' } })).toEqual([]);
    expect(detectHighRiskChanges({ before: { doseQuantity: 1 }, after: {} })).toEqual([]);
  });
});
