import { describe, expect, it } from 'vitest';
import { AppError } from '@dawaee/shared';
import { requireRoutedUuid } from '../src/lib/params.js';

const PROFILE = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = '123e4567-e89b-42d3-a456-426614174001';

describe('private routing handler fallback', () => {
  it('recovers a profile UUID from private request metadata when the URL query is empty', () => {
    expect(requireRoutedUuid(undefined, { 'x-dawaee-profile-id': PROFILE }, 'x-dawaee-profile-id', 'profileId'))
      .toBe(PROFILE);
  });

  it('keeps the legacy query contract during rollout', () => {
    expect(requireRoutedUuid(PROFILE, {}, 'x-dawaee-profile-id', 'profileId')).toBe(PROFILE);
  });

  it('fails closed when query and private routing metadata disagree', () => {
    expect(() => requireRoutedUuid(PROFILE, { 'x-dawaee-profile-id': OTHER }, 'x-dawaee-profile-id', 'profileId'))
      .toThrow(AppError);
  });
});
