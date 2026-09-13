import { describe, expect, it } from 'vitest';
import { buildObjectKey } from '../src/providers/storage.js';

describe('object-key privacy', () => {
  it('does not expose a stable patient-profile identifier or prefix in externally visible storage keys', () => {
    const profileId = 'patient-profile-stable-marker-for-test';
    const key = buildObjectKey('medication_image', profileId, 'image/jpeg');

    expect(key).not.toContain(profileId);
    expect(key).not.toContain(profileId.slice(0, 8));
  });
});
