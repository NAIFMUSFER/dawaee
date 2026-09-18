import type { Config } from '../config.js';

export interface RecoveryVerification {
  phone: string;
  verificationSid: string;
  serviceSid: string;
  startedAt: number;
}
export class RecoveryVerifyError extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid' | 'rate_limited') {
    super('Phone recovery verification failed');
  }
}
export interface RecoveryVerifyProvider {
  readonly ready: boolean;
  start(phone: string, locale: 'ar' | 'en'): Promise<RecoveryVerification>;
  check(verification: RecoveryVerification, code: string): Promise<boolean>;
}
export const disabledRecoveryVerify: RecoveryVerifyProvider = {
  ready: false,
  start: async () => { throw new RecoveryVerifyError('unavailable'); },
  check: async () => { throw new RecoveryVerifyError('unavailable'); },
};

/** Requests originate on the API, never from a mobile bundle containing a key. */
export function buildRecoveryVerify(cfg: Config, request: typeof fetch = fetch): RecoveryVerifyProvider {
  if (cfg.PASSWORD_RECOVERY_PROVIDER !== 'twilio'
    || !/^AC[0-9a-f]{32}$/i.test(cfg.TWILIO_ACCOUNT_SID ?? '')
    || !/^SK[0-9a-f]{32}$/i.test(cfg.TWILIO_API_KEY_SID ?? '')
    || !cfg.TWILIO_API_KEY_SECRET?.trim()
    || !/^VA[0-9a-f]{32}$/i.test(cfg.TWILIO_VERIFY_SERVICE_SID ?? '')) return disabledRecoveryVerify;
  const serviceSid = cfg.TWILIO_VERIFY_SERVICE_SID!;
  const post = async (path: 'Verifications' | 'VerificationCheck', body: Record<string, string>) => {
    try {
      const response = await request(`https://verify.twilio.com/v2/Services/${serviceSid}/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${cfg.TWILIO_API_KEY_SID}:${cfg.TWILIO_API_KEY_SECRET}`).toString('base64')}`,
        },
        body: new URLSearchParams(body),
      });
      if (response.status === 429) throw new RecoveryVerifyError('rate_limited');
      if (response.status === 404 && path === 'VerificationCheck') throw new RecoveryVerifyError('invalid');
      if (!response.ok) throw new RecoveryVerifyError('unavailable');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new RecoveryVerifyError('unavailable');
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RecoveryVerifyError) throw error;
      // No retries after ambiguous acceptance and no raw provider errors/logs.
      throw new RecoveryVerifyError('unavailable');
    }
  };
  const isBound = (result: Record<string, unknown>, phone: string) =>
    result.to === phone && result.service_sid === serviceSid && result.account_sid === cfg.TWILIO_ACCOUNT_SID
    && (result.channel === 'sms' || result.channel === 'rcs');
  return {
    ready: true,
    async start(phone, locale) {
      if (!/^\+9665\d{8}$/.test(phone)) throw new RecoveryVerifyError('invalid');
      const result = await post('Verifications', { To: phone, Channel: 'sms', Locale: locale });
      const startedAt = typeof result.date_created === 'string' ? Math.floor(Date.parse(result.date_created) / 1000) : NaN;
      const now = Math.floor(Date.now() / 1000);
      if (!isBound(result, phone) || result.status !== 'pending'
        || typeof result.sid !== 'string' || !/^VE[0-9a-f]{32}$/i.test(result.sid)
        || !Number.isFinite(startedAt) || startedAt > now + 5 || startedAt <= now - 300) {
        throw new RecoveryVerifyError('unavailable');
      }
      // Provider creation time is retained across resends: a retry cannot make
      // an old verification younger than a subsequent password change.
      return { phone, verificationSid: result.sid, serviceSid, startedAt };
    },
    async check(verification, code) {
      if (verification.serviceSid !== serviceSid || !/^VE[0-9a-f]{32}$/i.test(verification.verificationSid)
        || !/^\+9665\d{8}$/.test(verification.phone) || !/^\d{6}$/.test(code)) return false;
      const result = await post('VerificationCheck', { VerificationSid: verification.verificationSid, Code: code });
      return isBound(result, verification.phone) && result.sid === verification.verificationSid && result.status === 'approved';
    },
  };
}
