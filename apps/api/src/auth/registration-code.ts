import { createHmac } from 'node:crypto';
import { loadConfig } from '../config.js';

// The challenge is public; the six-digit code is delivered only to the mailbox.
// Domain-separated keyed derivation prevents offline guessing from DB hashes.
export function registrationToken(email: string, challenge: string, code: string): string {
  return createHmac('sha256', loadConfig().JWT_SECRET)
    .update(JSON.stringify(['tadawee:registration-code:v1', email, challenge, code]))
    .digest('base64url');
}
