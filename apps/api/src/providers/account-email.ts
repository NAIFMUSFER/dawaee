import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { z } from 'zod';
import { loadConfig, type Config } from '../config.js';
import { withTransaction } from '../lib/db.js';

export type EmailPurpose = 'verify' | 'reset' | 'register';
type DeliveryFailure = 'configuration' | 'rate_limited' | 'provider_unavailable' | 'provider_rejected'
  | 'invalid_response' | 'timeout' | 'network' | 'invalid_payload' | 'unknown';
export class AccountEmailDeliveryError extends Error {
  constructor(readonly code: DeliveryFailure) { super('Account email unavailable'); }
}
export type EmailDeliveryDiagnostic = { queue: 'account' | 'registration'; code: DeliveryFailure };
const payloadSchema = z.object({ email: z.string().email(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  purpose: z.enum(['verify', 'reset', 'register']), locale: z.enum(['ar', 'en']) });
type Mail = z.infer<typeof payloadSchema>;
const key = () => new Uint8Array(hkdfSync('sha256', loadConfig().JWT_SECRET, '', 'tadawee:account-email:v1', 32));
export const emailTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function sealEmailJob(mail: Mail): Promise<string> {
  return new EncryptJWT(mail).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer('tadawee').setAudience('account-email-job').setIssuedAt().setExpirationTime('30m').encrypt(key());
}
export async function openEmailJob(value: string): Promise<Mail> {
  const { payload } = await jwtDecrypt(value, key(), { issuer: 'tadawee', audience: 'account-email-job',
    keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'], requiredClaims: ['exp', 'iat'] });
  return payloadSchema.parse(payload);
}
export function accountEmailReady(cfg: Config = loadConfig()): boolean {
  if (cfg.ACCOUNT_EMAIL_PROVIDER !== 'resend' || !cfg.ACCOUNT_EMAIL_SENDER_VERIFIED
    || !cfg.RESEND_API_KEY?.trim() || !z.string().email().safeParse(cfg.ACCOUNT_EMAIL_FROM).success) return false;
  try {
    const url = new URL(cfg.ACCOUNT_EMAIL_BASE_URL ?? '');
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function accountEmailContent(mail: Mail, cfg: Config) {
  const url = new URL('/account-email', cfg.ACCOUNT_EMAIL_BASE_URL);
  // Fragment is never sent to the server or written to request logs.
  url.hash = new URLSearchParams({ token: mail.token, purpose: mail.purpose, lang: mail.locale }).toString();
  const ar = mail.locale === 'ar';
  const action = mail.purpose === 'reset' ? (ar ? 'إعادة تعيين كلمة المرور' : 'Reset your password')
    : mail.purpose === 'register' ? (ar ? 'إكمال إنشاء الحساب' : 'Complete account creation')
      : (ar ? 'تأكيد البريد الإلكتروني' : 'Verify your email');
  const minutes = mail.purpose === 'reset' ? 15 : 30;
  const expiry = ar ? `تنتهي صلاحية الرابط خلال ${minutes} دقيقة. إذا لم تطلب هذه الرسالة، تجاهلها.` : `This link expires in ${minutes} minutes. If you did not request this email, ignore it.`;
  return { subject: `TADAWEE | ${action}`, text: `${action}\n${url.href}\n\n${expiry}`,
    html: `<!doctype html><html lang="${mail.locale}" dir="${ar ? 'rtl' : 'ltr'}"><head><title>${action}</title></head><body style="font-family:Arial,sans-serif;background:#f2f8f5;padding:24px;color:#163d30"><main style="max-width:560px;margin:auto;background:white;padding:28px;border-radius:16px"><h1>تداوي | TADAWEE</h1><h2>${action}</h2><p style="font-size:16px;line-height:1.8">${expiry}</p><p><a href="${escapeHtml(url.href)}" style="display:inline-block;background:#16734f;color:white;padding:16px 24px;border-radius:8px;font-size:18px">${action}</a></p></main></body></html>` };
}
export async function sendAccountEmail(mail: Mail, idempotencyKey: string, request: typeof fetch = fetch): Promise<void> {
  const cfg = loadConfig();
  if (!accountEmailReady(cfg)) throw new AccountEmailDeliveryError('configuration');
  try {
    const response = await request('https://api.resend.com/emails', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`,
        'Content-Type': 'application/json', 'Idempotency-Key': `account-email/${idempotencyKey}` },
      body: JSON.stringify({ from: `TADAWEE <${cfg.ACCOUNT_EMAIL_FROM}>`, to: [mail.email], ...accountEmailContent(mail, cfg) }),
    });
    if (!response.ok) throw new AccountEmailDeliveryError(response.status === 429 ? 'rate_limited'
      : response.status >= 500 ? 'provider_unavailable' : 'provider_rejected');
    let result: { id?: unknown } | null;
    try { result = await response.json() as { id?: unknown } | null; }
    catch { throw new AccountEmailDeliveryError('invalid_response'); }
    if (typeof result?.id !== 'string' || !result.id) throw new AccountEmailDeliveryError('invalid_response');
  } catch (error) {
    if (error instanceof AccountEmailDeliveryError) throw error;
    throw new AccountEmailDeliveryError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  }
}
// Runs inside the API with durable leases; no provider latency in anonymous
// request responses. Stored payloads are encrypted and purged on send/expiry.
export async function drainAccountEmails(send = sendAccountEmail,
  diagnose: (event: EmailDeliveryDiagnostic) => void = () => {}): Promise<number> {
  let sent = 0;
  for (const queue of [
    { name: 'account', claim: 'app.claim_account_emails', finish: 'app.finish_account_email' },
    { name: 'registration', claim: 'app.claim_registration_emails', finish: 'app.finish_registration_email' },
  ] as const) {
    const lease = randomUUID();
    const { rows } = await withTransaction(tx => tx.query<{ token_hash: string; payload: string }>(`SELECT * FROM ${queue.claim}($1)`, [lease]));
    for (const row of rows) {
      let accepted = false;
      let stage: 'payload' | 'send' = 'payload';
      try {
        const mail = await openEmailJob(row.payload); stage = 'send';
        await send(mail, row.token_hash); accepted = true; sent++;
      } catch (error) {
        // Never give the observer the error, recipient, token, job key or provider body.
        // Diagnostics must not interrupt the durable retry/lease completion path.
        try { diagnose({ queue: queue.name, code: stage === 'payload' ? 'invalid_payload'
          : error instanceof AccountEmailDeliveryError ? error.code : 'unknown' }); } catch { /* observer only */ }
      }
      await withTransaction(tx => tx.query(`SELECT ${queue.finish}($1,$2,$3)`, [row.token_hash, lease, accepted]));
    }
  }
  return sent;
}
