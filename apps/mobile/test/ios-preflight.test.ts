import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { validateFirebasePlist, preflight } = require('../scripts/ios-preflight.cjs');
const plist = require('../node_modules/@expo/plist').default;
const temporary: string[] = [];
const config = {
  BUNDLE_ID: 'app.dawaee.mobile', PROJECT_ID: 'tadawee', GCM_SENDER_ID: '954358159770',
  GOOGLE_APP_ID: '1:954358159770:ios:0000000000000000000000', API_KEY: 'synthetic-test-only',
};
function file(patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tadawee-ios-test-')); temporary.push(dir);
  const name = join(dir, 'GoogleService-Info.plist');
  writeFileSync(name, plist.build({ ...config, ...patch })); return name;
}
afterEach(() => { vi.unstubAllEnvs(); temporary.splice(0).forEach(p => rmSync(p, { recursive: true })); });
describe('iOS Firebase preflight', () => {
  it('rejects a missing iOS registration before building', () => {
    expect(() => validateFirebasePlist('/does-not-exist.plist')).toThrow('IOS_FIREBASE_CONFIG_REQUIRED');
  });
  it('rejects a Firebase registration from another app', () => {
    expect(() => validateFirebasePlist(file({ BUNDLE_ID: 'app.other.mobile' }))).toThrow('IOS_FIREBASE_BUNDLE_MISMATCH');
  });
  it('rejects another Firebase project even if its bundle ID matches', () => {
    expect(() => validateFirebasePlist(file({ PROJECT_ID: 'other' }))).toThrow('IOS_FIREBASE_PROJECT_MISMATCH');
  });
  it('rejects an Android registration masquerading as an iOS file', () => {
    expect(() => validateFirebasePlist(file({ GOOGLE_APP_ID: '1:954358159770:android:00000000' }))).toThrow('IOS_FIREBASE_CONFIG_INVALID');
  });
  it('accepts the expected registration through the EAS file path', () => {
    vi.stubEnv('GOOGLE_SERVICES_PLIST', file());
    vi.stubEnv('DAWAEE_AUDIT_BUILD', '0');
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://dawaee-api.onrender.com');
    vi.stubEnv('EXPO_PUBLIC_DEMO', '0');
    expect(preflight).not.toThrow();
  });
  it('rejects the audit identity for TestFlight', () => {
    vi.stubEnv('DAWAEE_AUDIT_BUILD', '1');
    expect(preflight).toThrow('IOS_TESTFLIGHT_MUST_NOT_USE_AUDIT_IDENTITY');
  });
});
