import { describe, expect, it } from 'vitest';
import { INITIAL_LOCK_STATE, lockReducer } from '../src/security/lock-state.js';

function unlocked() {
  return lockReducer(
    lockReducer(INITIAL_LOCK_STATE, { type: 'configure', enabled: true }),
    { type: 'verified' },
  );
}

describe('app lock fail-closed behavior when wall clock moves backwards', () => {
  it('re-locks instead of granting the background grace window when active time predates background time', () => {
    let state = lockReducer(unlocked(), { type: 'appStatus', status: 'background', now: 100_000 });
    state = lockReducer(state, { type: 'appStatus', status: 'active', now: 99_999 });
    expect(state.phase).toBe('locked');
  });
});
