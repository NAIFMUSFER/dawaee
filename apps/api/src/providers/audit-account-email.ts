import type { Config } from '../config.js';
import { accountEmailReady } from './account-email.js';

/** One explicit exception to test servers' no-mail timer rule. It authorizes
 * real mailbox verification, never a verification bypass or a fixture token.
 * Bootstrap separately validates the database owner before creating this
 * restricted API connection. No secret values are returned or logged here. */
export function auditAccountEmailDeliveryAllowed(cfg: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = 'https://dawaee-audit-preview.onrender.com';
  if (cfg.NODE_ENV !== 'test' || env.AUDIT_ACCOUNT_EMAIL_DELIVERY !== '1'
      || env.RENDER_SERVICE_ID !== 'srv-daipkbuk1f9s73952trg'
      || env.RENDER_EXTERNAL_URL !== origin
      || cfg.ACCOUNT_EMAIL_BASE_URL !== origin
      || cfg.ACCOUNT_EMAIL_FROM !== 'accounts@mail.tadawee.net'
      || !accountEmailReady(cfg)) return false;
  try {
    const db = new URL(cfg.DATABASE_URL);
    return ['postgres:', 'postgresql:'].includes(db.protocol)
      && db.hostname === 'dpg-daipq80jo6nc73fsmhhg-a'
      && (!db.port || db.port === '5432') && db.pathname === '/dawaee_audit_db'
      && db.username === 'dawaee_app' && !!db.password && !db.search && !db.hash;
  } catch { return false; }
}
