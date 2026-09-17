import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const configure = require('../app.config.js');
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
const profiles = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')).build;
const androidNativeWorkflow = readFileSync(
  new URL('../../../.github/workflows/android-native.yml', import.meta.url),
  'utf8',
);

describe('isolated installed audit build', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the normal application identity unchanged', () => {
    vi.stubEnv('DAWAEE_AUDIT_BUILD', undefined);
    expect(configure({ config })).toBe(config);
    expect(config.android.package).toBe('app.dawaee.mobile');
    expect(config.ios.bundleIdentifier).toBe('app.dawaee.mobile');
  });

  it('builds an internal APK and physical iOS app in a separate installation sandbox', () => {
    const profile = profiles['audit-preview'];
    for (const [key, value] of Object.entries(profile.env)) vi.stubEnv(key, String(value));
    expect(profile.distribution).toBe('internal');
    expect(profile.android.buildType).toBe('apk');
    expect(profile.ios.simulator).toBe(false);
    const audit = configure({ config });
    expect(audit.android.package).toBe('app.dawaee.audit');
    expect(audit.ios.bundleIdentifier).toBe('app.dawaee.audit');
    expect(audit.scheme).toBe('dawaee-audit');
    expect(audit.extra.apiBaseUrl).toBe(profile.env.EXPO_PUBLIC_API_URL);
    expect(audit.android.allowBackup).toBe(false);
    expect(audit.extra.eas.projectId).toBe(config.extra.eas.projectId);
    expect(audit.plugins).toEqual(config.plugins.filter((plugin: unknown) =>
      !['@react-native-firebase/app', '@react-native-firebase/auth'].includes(String(plugin))));
    expect(audit.android.googleServicesFile).toBeUndefined();
    expect(config.android.googleServicesFile).toBe('./google-services.json');
    expect(config.android.package).toBe('app.dawaee.mobile');
  });

  it.each([
    { EXPO_PUBLIC_API_URL: 'https://dawaee-api.onrender.com' },
    { EXPO_PUBLIC_API_URL: '' }, { EXPO_PUBLIC_DEMO: '1' },
  ])('refuses an audit identity with the wrong backend or demo data: %j', patch => {
    for (const [key, value] of Object.entries({ ...profiles['audit-preview'].env, ...patch })) vi.stubEnv(key, String(value));
    expect(() => configure({ config })).toThrow('AUDIT_MOBILE_TARGET_MISMATCH');
  });

  it('keeps Google Play signing on remote EAS credentials and CI native output as evidence only', () => {
    const production = profiles.production;
    expect(production.credentialsSource).toBe('remote');
    expect(production.autoIncrement).toBe(true);
    expect(production.android.buildType).toBe('app-bundle');

    // GitHub Actions proves that the generated Android project compiles, but it
    // does not own the Play upload key. A locally/generated-signed AAB must not
    // be downloadable from this workflow and mistaken for a store artefact.
    expect(androidNativeWorkflow).toContain(':app:bundleRelease');
    expect(androidNativeWorkflow).toContain('cp android/release-sha256.txt "$EVIDENCE/release-sha256.txt"');
    const uploadBlock = androidNativeWorkflow.split('- name: Upload CI native evidence')[1] ?? '';
    expect(uploadBlock).toContain('not-for-store');
    expect(uploadBlock).toContain('path: apps/mobile/android/ci-native-evidence/');
    expect(uploadBlock).not.toContain('app-release.aab');
  });
});
