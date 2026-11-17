import { describe, expect, it } from 'vitest';
import {
  createProfileSchema, createMedicationSchema,
  updateProfileSchema, updateMedicationSchema, uuid,
} from '../src/contracts.js';

describe('Zod 4 API compatibility', () => {
  it('does not reset omitted profile fields during PATCH', () => {
    expect(updateProfileSchema.parse({ displayName: 'Naif' })).toEqual({ displayName: 'Naif' });
    expect(updateProfileSchema.parse({})).toEqual({});
  });

  it('does not reset omitted medication fields during PATCH', () => {
    expect(updateMedicationSchema.parse({ notes: 'Updated note' })).toEqual({ notes: 'Updated note' });
    expect(updateMedicationSchema.parse({})).toEqual({});
  });

  it('retains defaults when creating records', () => {
    expect(createProfileSchema.parse({ displayName: 'Naif' })).toMatchObject({
      timezone: 'Asia/Riyadh', isSelf: false, travelPolicy: 'ask',
    });
    expect(createMedicationSchema.shape.foodInstruction.parse(undefined)).toBe('no_preference');
    expect(createMedicationSchema.shape.identitySource.parse(undefined)).toBe('user');
  });

  it('preserves explicit PATCH values', () => {
    expect(updateProfileSchema.parse({ timezone: 'Europe/London', isSelf: true }))
      .toEqual({ timezone: 'Europe/London', isSelf: true });
    expect(updateMedicationSchema.parse({ foodInstruction: 'no_preference', identitySource: 'user' }))
      .toEqual({ foodInstruction: 'no_preference', identitySource: 'user' });
  });

  it('accepts existing UUID-shaped identifiers while rejecting malformed IDs', () => {
    expect(uuid.safeParse('11111111-1111-1111-1111-111111111111').success).toBe(true);
    expect(uuid.safeParse('not-a-uuid').success).toBe(false);
    expect(uuid.safeParse('11111111-1111-1111-1111-111111111111-extra').success).toBe(false);
  });
});
