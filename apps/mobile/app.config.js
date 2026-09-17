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
    if (!googleServicesFile) return config;
    return { ...config, ios: { ...config.ios, googleServicesFile } };
  }
  const origin = 'https://dawaee-audit-preview.onrender.com';
  if (process.env.EXPO_PUBLIC_API_URL !== origin || process.env.EXPO_PUBLIC_DEMO !== '0') {
    throw new Error('AUDIT_MOBILE_TARGET_MISMATCH');
  }
  return {
    ...config,
    name: 'تداوي | TADAWEE تجريبي',
    scheme: 'dawaee-audit',
    android: { ...config.android, package: 'app.dawaee.audit', googleServicesFile: undefined },
    ios: { ...config.ios, bundleIdentifier: 'app.dawaee.audit', googleServicesFile: undefined },
    extra: { ...config.extra, apiBaseUrl: origin },
    // The production Firebase client is registered to app.dawaee.mobile.
    // Do not reuse its configuration for an isolated audit installation.
    plugins: config.plugins.filter((plugin) => !['@react-native-firebase/app', '@react-native-firebase/auth'].includes(plugin)),
  };
};
