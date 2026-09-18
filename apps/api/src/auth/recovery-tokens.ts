import { createHash, hkdfSync } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import type { RecoveryVerification } from '../providers/recovery-verify.js';

type Purpose = 'challenge' | 'proof';
const verificationSchema = z.object({
  phone: z.string().regex(/^\+9665\d{8}$/), verificationSid: z.string().regex(/^VE[0-9a-f]{32}$/i),
  serviceSid: z.string().regex(/^VA[0-9a-f]{32}$/i), startedAt: z.number().int().positive(),
});
function key(): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', loadConfig().JWT_SECRET, '', 'dawaee:twilio-password-recovery:v1', 32));
}
export async function sealRecoveryToken(verification: RecoveryVerification, purpose: Purpose): Promise<string> {
  return new EncryptJWT({ ...verification })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'JWT' })
    .setIssuer(loadConfig().JWT_ISSUER).setAudience(`dawaee:password-recovery:${purpose}`)
    .setIssuedAt().setExpirationTime(verification.startedAt + 300).encrypt(key());
}
export async function openRecoveryToken(token: string, purpose: Purpose): Promise<RecoveryVerification> {
  const { payload } = await jwtDecrypt(token, key(), {
    issuer: loadConfig().JWT_ISSUER, audience: `dawaee:password-recovery:${purpose}`,
    keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'],
    requiredClaims: ['iat', 'exp'], clockTolerance: 0,
  });
  const verification = verificationSchema.parse(payload);
  const now = Math.floor(Date.now() / 1000);
  if (verification.startedAt > now + 5 || verification.startedAt <= now - 300
    || payload.exp !== verification.startedAt + 300
    || verification.serviceSid !== loadConfig().TWILIO_VERIFY_SERVICE_SID) throw new Error('Invalid recovery token');
  return verification;
}
export function recoveryVerificationKey(verification: RecoveryVerification): string {
  // Stable across resends/resealed proofs. SQL consumes one provider challenge
  // for one password, with retries allowed only for the same password.
  return createHash('sha256').update(JSON.stringify([
    'twilio-password-recovery:v1', verification.serviceSid, verification.verificationSid, verification.phone,
  ])).digest('hex');
}
