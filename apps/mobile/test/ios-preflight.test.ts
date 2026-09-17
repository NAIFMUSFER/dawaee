import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { validateFirebasePlist, preflight } = require('../scripts/ios-preflight.cjs');
const plist = require('../node_modules/@expo/plist').default;
const profiles = require('../eas.json').build;
const script = fileURLToPath(new URL('../scripts/ios-preflight.cjs', import.meta.url));
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
function hook(profile: string, patch: Record<string, string> = {}, args = ['--eas']) {
  const selected = profiles[profile];
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DAWAEE_AUDIT_BUILD: '0', EXPO_PUBLIC_DEMO: '0',
      GOOGLE_SERVICES_PLIST: '/does-not-exist.plist', EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: profile,
      ...profiles[selected.extends]?.env, ...selected.env, ...patch },
  });
}
describe('EAS iOS release preflight hook', () => {
  it.each(['development', 'preview', 'audit-preview'])('does not apply store requirements to %s', profile => {
    const result = hook(profile);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('preflight passed');
  });
  it('does not require iOS registration for an Android release', () => {
    const result = hook('production', { EAS_BUILD_PLATFORM: 'android' });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(['production', 'ios-testflight'])('requires a valid plist for the %s store profile', profile => {
    const missing = hook(profile);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('IOS_FIREBASE_CONFIG_REQUIRED');
    const configured = hook(profile, { GOOGLE_SERVICES_PLIST: file() });
    expect(configured.status, configured.stderr).toBe(0);
    expect(configured.stdout).toContain('preflight passed');
  });
  it('rejects an audit identity accidentally set on a store profile', () => {
    const result = hook('ios-testflight', { DAWAEE_AUDIT_BUILD: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('IOS_TESTFLIGHT_MUST_NOT_USE_AUDIT_IDENTITY');
  });
  it('still checks the production backend when explicitly run from a development environment', () => {
    const result = hook('development', {}, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('IOS_BACKEND_MISMATCH');
  });
});
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
  it('rejects an explicitly empty API URL', () => {
    vi.stubEnv('GOOGLE_SERVICES_PLIST', file());
    vi.stubEnv('DAWAEE_AUDIT_BUILD', '0');
    vi.stubEnv('EXPO_PUBLIC_API_URL', '');
    vi.stubEnv('EXPO_PUBLIC_DEMO', '0');
    expect(preflight).toThrow('IOS_BACKEND_MISMATCH');
  });
});
