const fs = require('node:fs');
const path = require('node:path');
// A separate installation keeps audit sessions, offline queues and local
// notifications out of the production app's sandbox. Ordinary builds retain
// the static app.json identity and EAS project.
module.exports = ({ config }) => {
  if (process.env.DAWAEE_AUDIT_BUILD !== '1') {
    const localPlist = path.join(__dirname, 'GoogleService-Info.plist');
    const googleServicesFile = process.env.GOOGLE_SERVICES_PLIST || (fs.existsSync(localPlist) ? localPlist : undefined);
    // Keep Android/web builds independent of the separately registered iOS app.
    return {
      ...config,
      ios: { ...config.ios, googleServicesFile },
      // Runtime support must not depend on a build-machine file path being
      // present in Expo's manifest. Only this non-secret capability is needed.
      extra: { ...config.extra, iosPhoneVerificationEnabled: !!googleServicesFile },
    };
  }
  const deviceCI = process.env.DAWAEE_DEVICE_CI === '1';
  if (deviceCI && process.env.GITHUB_ACTIONS !== 'true') throw new Error('DEVICE_CI_ONLY');
  const origin = deviceCI ? 'http://127.0.0.1:8080' : 'https://dawaee-audit-preview.onrender.com';
  if (process.env.EXPO_PUBLIC_API_URL !== origin || process.env.EXPO_PUBLIC_DEMO !== '0') {
    throw new Error('AUDIT_MOBILE_TARGET_MISMATCH');
  }
  return {
    ...config,
    name: 'تداوي | TADAWEE تجريبي',
    scheme: 'dawaee-audit',
    android: { ...config.android, package: 'app.dawaee.audit', googleServicesFile: undefined },
    ios: { ...config.ios, bundleIdentifier: 'app.dawaee.audit', googleServicesFile: undefined,
      infoPlist: { ...config.ios?.infoPlist, CFBundleDisplayName: 'تداوي تجريبي' } },
    // Localized metadata overrides the ordinary display name on iOS. Keep the
    // isolated installation visibly distinct in both supported languages.
    locales: {
      ar: { ios: { ...require('./locales/ar.json').ios, CFBundleDisplayName: 'تداوي تجريبي' } },
      en: { ios: { ...require('./locales/en.json').ios, CFBundleDisplayName: 'TADAWEE Audit' } },
    },
    extra: { ...config.extra, apiBaseUrl: origin, iosPhoneVerificationEnabled: false },
    // The production Firebase client is registered to app.dawaee.mobile.
    // Do not reuse its configuration for an isolated audit installation.
    plugins: config.plugins.filter((plugin) => !['@react-native-firebase/app', '@react-native-firebase/auth'].includes(plugin))
      .map(plugin => deviceCI && Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
        ? [plugin[0], { ...plugin[1], android: { ...plugin[1].android, usesCleartextTraffic: true } }] : plugin),
  };
};
