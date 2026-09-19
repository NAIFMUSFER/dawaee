import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/security/phone-proof.native.ts', import.meta.url), 'utf8');
const configure = require('../app.config.js');
const base = require('../app.json').expo;
const { getConfig } = require('../node_modules/expo/config');
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function supported(platform: string, config: object) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, unknown> = {};
  const mockRequire = (name: string) => {
    if (name === 'react-native') return { Platform: { OS: platform } };
    if (name === 'expo-constants') return { default: { expoConfig: config } };
    if (name.startsWith('@react-native-firebase/')) return {};
    return require(name);
  };
  new Function('require', 'exports', code)(mockRequire, exports);
  return exports.phoneVerificationSupported;
}
describe('installed iOS phone verification availability', () => {
  it('preserves the capability in Expo public config without requiring the plist path at runtime', () => {
    vi.stubEnv('DAWAEE_AUDIT_BUILD', '0');
    vi.stubEnv('GOOGLE_SERVICES_PLIST', '/build/GoogleService-Info.plist');
    const { exp } = getConfig(fileURLToPath(new URL('..', import.meta.url)), { isPublicConfig: true });
    expect(exp.extra.iosPhoneVerificationEnabled).toBe(true);
    expect(exp.extra.eas.projectId).toBe(base.extra.eas.projectId);
    // Model a manifest with no build-machine path; do not mock that path as
    // available to Constants.expoConfig inside the installed application.
    delete exp.ios.googleServicesFile;
    expect(supported('ios', exp)).toBe(true);
  });
  it('disables the capability when no iOS plist is configured', () => {
    vi.stubEnv('DAWAEE_AUDIT_BUILD', '0');
    vi.stubEnv('GOOGLE_SERVICES_PLIST', undefined);
    vi.spyOn(require('node:fs'), 'existsSync').mockReturnValue(false);
    const config = configure({ config: { ...base, extra: { ...base.extra, iosPhoneVerificationEnabled: true } } });
    expect(config.extra.iosPhoneVerificationEnabled).toBe(false);
    expect(supported('ios', config)).toBe(false);
  });
  it('does not enable phone recovery for an unconfigured iPhone app', () => {
    expect(supported('ios', { ios: { bundleIdentifier: 'app.dawaee.mobile' } })).toBe(false);
  });
  it('never reuses production phone verification in the audit identity', () => {
    expect(supported('ios', { ios: { bundleIdentifier: 'app.dawaee.audit' }, extra: { iosPhoneVerificationEnabled: true } })).toBe(false);
  });
  it.each([false, undefined, 'true'])('requires an explicit boolean capability, received %s', flag => {
    expect(supported('ios', { ios: { bundleIdentifier: 'app.dawaee.mobile' }, extra: { iosPhoneVerificationEnabled: flag } })).toBe(false);
  });
  it('preserves configured Android support', () => {
    expect(supported('android', { android: { package: 'app.dawaee.mobile' } })).toBe(true);
  });
});
