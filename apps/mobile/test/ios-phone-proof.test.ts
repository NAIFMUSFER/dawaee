import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/security/phone-proof.native.ts', import.meta.url), 'utf8');
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
  it('enables phone recovery for a configured production iOS app', () => {
    expect(supported('ios', { ios: { bundleIdentifier: 'app.dawaee.mobile', googleServicesFile: '/build/GoogleService-Info.plist' } })).toBe(true);
  });
  it('does not enable phone recovery for an unconfigured iPhone app', () => {
    expect(supported('ios', { ios: { bundleIdentifier: 'app.dawaee.mobile' } })).toBe(false);
  });
  it('never reuses production phone verification in the audit identity', () => {
    expect(supported('ios', { ios: { bundleIdentifier: 'app.dawaee.audit', googleServicesFile: '/build/GoogleService-Info.plist' } })).toBe(false);
  });
  it('preserves configured Android support', () => {
    expect(supported('android', { android: { package: 'app.dawaee.mobile' } })).toBe(true);
  });
});
