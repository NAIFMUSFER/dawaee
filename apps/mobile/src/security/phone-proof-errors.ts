import type { MessageKey } from '@dawaee/shared';

/** Never display provider payloads, phone numbers, or tokens in an error. */
export function phoneProofErrorKey(error: unknown): MessageKey {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  switch (code) {
    case 'auth/invalid-phone-number': return 'recovery.phoneInvalid';
    case 'auth/network-request-failed': return 'notifications.offlineBanner';
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded': return 'phoneVerification.rateLimited';
    case 'auth/invalid-verification-code': return 'phoneVerification.codeError';
    case 'auth/session-expired': return 'phoneVerification.expired';
    case 'auth/captcha-check-failed':
    case 'auth/web-context-cancelled': return 'phoneVerification.challengeFailed';
    case 'auth/app-not-authorized':
    case 'auth/invalid-app-credential':
    case 'auth/missing-app-credential':
    case 'auth/missing-client-identifier':
    case 'auth/operation-not-allowed':
    case 'auth/billing-not-enabled': return 'phoneVerification.serviceUnavailable';
    default: return 'phoneVerification.failed';
  }
}
