import { describe, expect, it } from 'vitest';
import {
  areaNeedsVerification,
  INITIAL_LOCK_STATE,
  lockReducer,
  RELOCK_GRACE_MS,
} from '../src/security/lock-state.js';

const locked = () => lockReducer(
  INITIAL_LOCK_STATE,
  { type: 'configure', enabled: true },
);

const unlocked = () => lockReducer(
  locked(),
  { type: 'verified' },
);

describe('app-lock background verification races', () => {
  it('does not grant the background grace window to a screen that was already locked', () => {
    let state = locked();
    state = lockReducer(state, { type: 'appStatus', status: 'background', now: 1_000 });
    expect(state.phase).toBe('covered');

    state = lockReducer(state, {
      type: 'appStatus',
      status: 'active',
      now: 1_000 + RELOCK_GRACE_MS - 1,
    });

    expect(state.phase).toBe('locked');
  });

  it('ignores a whole-app verification result that completes after a real background event', () => {
    let state = locked();
    state = lockReducer(state, { type: 'appStatus', status: 'background', now: 2_000 });
    state = lockReducer(state, { type: 'verified' });

    expect(state.phase).not.toBe('unlocked');
    expect(state.pendingRelock).toBe(true);
  });

  it('does not restore an area verification that completes after background cleared it', () => {
    let state = unlocked();
    state = lockReducer(state, { type: 'appStatus', status: 'background', now: 3_000 });
    state = lockReducer(state, { type: 'areaVerified', area: 'reports' });

    expect(state.verifiedAreas).not.toContain('reports');
    expect(areaNeedsVerification(state, ['reports'], 'reports')).toBe(true);
  });

  it('preserves the intended short grace when an already-unlocked app goes inactive then backgrounds', () => {
    let state = unlocked();
    state = lockReducer(state, { type: 'appStatus', status: 'inactive', now: 4_000 });
    state = lockReducer(state, { type: 'appStatus', status: 'background', now: 4_100 });
    state = lockReducer(state, {
      type: 'appStatus',
      status: 'active',
      now: 4_100 + RELOCK_GRACE_MS - 1,
    });

    expect(state.phase).toBe('unlocked');
  });

  it('does not let a late password-verification event open a lock after the app backgrounded', () => {
    let state = locked();
    state = lockReducer(state, { type: 'appStatus', status: 'background', now: 5_000 });
    state = lockReducer(state, { type: 'credentialVerified' });

    expect(state.phase).not.toBe('unlocked');
  });
});
