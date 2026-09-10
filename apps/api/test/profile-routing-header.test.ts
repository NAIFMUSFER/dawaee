import { describe, expect, it } from 'vitest';
import { promoteProfileIdHeader, PROFILE_ID_HEADER } from '../src/middleware/profile-routing.js';

const PROFILE_A = '11111111-2222-4333-8444-555555555555';
const PROFILE_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function request(query: Record<string, unknown>, header?: string | string[]) {
  return {
    query,
    headers: header === undefined ? {} : { [PROFILE_ID_HEADER]: header },
  } as Parameters<typeof promoteProfileIdHeader>[0];
}

describe('profile routing header compatibility', () => {
  it('promotes the dedicated header into the existing route query contract', () => {
    const req = request({ from: '2026-09-01' }, PROFILE_A);
    promoteProfileIdHeader(req);
    expect((req.query as Record<string, unknown>).profileId).toBe(PROFILE_A);
    expect((req.query as Record<string, unknown>).from).toBe('2026-09-01');
  });

  it('keeps legacy query-only clients working during the rollout', () => {
    const req = request({ profileId: PROFILE_A });
    promoteProfileIdHeader(req);
    expect((req.query as Record<string, unknown>).profileId).toBe(PROFILE_A);
  });

  it('allows duplicate metadata only when both transports identify the same profile', () => {
    const req = request({ profileId: PROFILE_A }, PROFILE_A);
    promoteProfileIdHeader(req);
    expect((req.query as Record<string, unknown>).profileId).toBe(PROFILE_A);
  });

  it('rejects a header/query conflict instead of silently changing authorization target', () => {
    const req = request({ profileId: PROFILE_A }, PROFILE_B);
    expect(() => promoteProfileIdHeader(req)).toThrow('Conflicting profile routing metadata');
  });

  it('rejects empty or repeated routing headers', () => {
    expect(() => promoteProfileIdHeader(request({}, '   '))).toThrow('Invalid profile routing metadata');
    expect(() => promoteProfileIdHeader(request({}, [PROFILE_A, PROFILE_B]))).toThrow('Invalid profile routing metadata');
  });
});
