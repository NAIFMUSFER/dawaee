// A separate installation keeps audit sessions, offline queues and local
// notifications out of the production app's sandbox. Ordinary builds retain
// the static app.json identity and EAS project.
module.exports = ({ config }) => {
  if (process.env.DAWAEE_AUDIT_BUILD !== '1') return config;
  const origin = 'https://dawaee-audit-preview.onrender.com';
  if (process.env.EXPO_PUBLIC_API_URL !== origin || process.env.EXPO_PUBLIC_DEMO !== '0') {
    throw new Error('AUDIT_MOBILE_TARGET_MISMATCH');
  }
  return {
    ...config,
    name: 'دوائي تجريبي',
    scheme: 'dawaee-audit',
    android: { ...config.android, package: 'app.dawaee.audit', googleServicesFile: undefined },
    ios: { ...config.ios, bundleIdentifier: 'app.dawaee.audit' },
    extra: { ...config.extra, apiBaseUrl: origin },
    // The production Firebase client is registered to app.dawaee.mobile.
    // Do not reuse its configuration for an isolated audit installation.
    plugins: config.plugins.filter((plugin) => !['@react-native-firebase/app', '@react-native-firebase/auth'].includes(plugin)),
  };
};
