const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const root = path.resolve(__dirname, '..');

function validateFirebasePlist(file, expectedBundle = 'app.dawaee.mobile') {
  if (!file || !fs.existsSync(file)) {
    throw new Error('IOS_FIREBASE_CONFIG_REQUIRED: register app.dawaee.mobile in Firebase project tadawee, then provide GoogleService-Info.plist locally or through the GOOGLE_SERVICES_PLIST EAS file variable.');
  }
  const config = plist.parse(fs.readFileSync(file, 'utf8'));
  if (config.BUNDLE_ID !== expectedBundle) throw new Error('IOS_FIREBASE_BUNDLE_MISMATCH');
  if (config.PROJECT_ID !== 'tadawee' || config.GCM_SENDER_ID !== '954358159770') throw new Error('IOS_FIREBASE_PROJECT_MISMATCH');
  if (!/^1:954358159770:ios:[a-zA-Z0-9]+$/.test(config.GOOGLE_APP_ID || '') || !config.API_KEY) {
    throw new Error('IOS_FIREBASE_CONFIG_INVALID');
  }
}

function preflight() {
  if (process.env.DAWAEE_AUDIT_BUILD === '1') throw new Error('IOS_TESTFLIGHT_MUST_NOT_USE_AUDIT_IDENTITY');
  const base = require('../app.json').expo;
  const config = require('../app.config.js')({ config: base });
  if (config.name !== 'تداوي | TADAWEE' || config.ios.bundleIdentifier !== 'app.dawaee.mobile') throw new Error('IOS_APP_IDENTITY_MISMATCH');
  const api = process.env.EXPO_PUBLIC_API_URL || config.extra.apiBaseUrl;
  if (api !== 'https://dawaee-api.onrender.com' || process.env.EXPO_PUBLIC_DEMO === '1') throw new Error('IOS_BACKEND_MISMATCH');
  validateFirebasePlist(config.ios.googleServicesFile ? path.resolve(root, config.ios.googleServicesFile) : undefined);
  console.log('iOS configuration preflight passed. Apple signing, APNs, SMS and device testing remain separate checks.');
}
module.exports = { validateFirebasePlist, preflight };
if (require.main === module) {
  if (!process.argv.includes('--eas') || (process.env.EAS_BUILD_PLATFORM === 'ios' && process.env.DAWAEE_AUDIT_BUILD !== '1')) preflight();
}
