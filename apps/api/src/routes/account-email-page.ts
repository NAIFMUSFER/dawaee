import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Standalone same-origin form. No analytics, cookies, external assets, token in
// query parameters, or automatic action when an email security scanner opens it.
export const EMAIL_ACTION_SCRIPT = `
(function () {
  const parts = new URLSearchParams(location.hash.slice(1));
  let token = parts.get('token') || '';
  const purpose = parts.get('purpose');
  const en = parts.get('lang') === 'en';
  history.replaceState(null, '', location.pathname);
  const title = document.getElementById('title');
  const form = document.getElementById('form');
  const displayName = document.getElementById('display-name');
  const password = document.getElementById('password');
  const confirm = document.getElementById('confirm');
  const button = document.getElementById('submit');
  const message = document.getElementById('message');
  const labels = en ? {
    verify: 'Verify your email', reset: 'Reset your password', register: 'Create your TADAWEE account',
    name: 'Your name', password: 'New password (at least 10 characters)',
    confirm: 'Confirm new password', invalid: 'This link has expired or is invalid. Request a new link in TADAWEE.',
    mismatch: 'Passwords must match and contain at least 10 characters.',
    saved: 'Your password has been updated. Return to TADAWEE and sign in.',
    verified: 'Your email is verified. Return to TADAWEE.', registered: 'Your account is ready. Return to TADAWEE and sign in.',
    failure: 'Unable to complete. Try again or request a new link.',
    weak: 'Choose a stronger password of at least 10 characters.', limited: 'Too many attempts. Try again later.',
    expiry: 'Reset links expire after 15 minutes; verification links after 30 minutes.'
  } : {
    verify: 'تأكيد البريد الإلكتروني', reset: 'إعادة تعيين كلمة المرور', register: 'إنشاء حساب تداوي',
    name: 'الاسم', password: 'كلمة المرور الجديدة (10 أحرف على الأقل)',
    confirm: 'تأكيد كلمة المرور الجديدة', invalid: 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا من تداوي.',
    mismatch: 'يجب أن تتطابق كلمتا المرور وأن تحتوي على 10 أحرف على الأقل.',
    saved: 'تم تحديث كلمة المرور. ارجع إلى تداوي وسجّل الدخول.', verified: 'تم تأكيد بريدك الإلكتروني. ارجع إلى تداوي.',
    registered: 'تم إنشاء حسابك. ارجع إلى تداوي وسجّل الدخول.',
    failure: 'تعذّر إكمال العملية. حاول مجددًا أو اطلب رابطًا جديدًا.', weak: 'اختر كلمة مرور أقوى من 10 أحرف على الأقل.',
    limited: 'محاولات كثيرة. حاول لاحقًا.', expiry: 'رابط الاستعادة صالح لمدة 15 دقيقة، ورابط تأكيد البريد لمدة 30 دقيقة.'
  };
  document.documentElement.lang = en ? 'en' : 'ar';
  document.documentElement.dir = en ? 'ltr' : 'rtl';
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token) && (purpose === 'verify' || purpose === 'reset' || purpose === 'register');
  title.textContent = purpose === 'reset' ? labels.reset : purpose === 'register' ? labels.register : labels.verify;
  document.title = title.textContent + ' | TADAWEE';
  document.getElementById('expiry').textContent = labels.expiry;
  document.getElementById('name-label').textContent = labels.name;
  document.getElementById('password-label').textContent = labels.password;
  document.getElementById('confirm-label').textContent = labels.confirm;
  button.textContent = title.textContent;
  document.getElementById('name-field').hidden = purpose !== 'register';
  document.getElementById('passwords').hidden = purpose === 'verify';
  displayName.required = purpose === 'register';
  password.required = confirm.required = purpose !== 'verify';
  if (!valid) { form.hidden = true; message.textContent = labels.invalid; return; }
  let busy = false;
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || !token) return;
    if (purpose !== 'verify' && (password.value.length < 10 || password.value !== confirm.value)) {
      message.textContent = labels.mismatch; return;
    }
    if (purpose === 'register' && (displayName.value.trim().length < 1 || displayName.value.trim().length > 120)) {
      message.textContent = labels.failure; return;
    }
    busy = true; button.disabled = true; message.textContent = '';
    try {
      const response = await fetch('/v1/auth/email/complete', {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'Accept-Language': en ? 'en' : 'ar' },
        body: JSON.stringify(purpose === 'register'
          ? { token, purpose, displayName: displayName.value.trim(), newPassword: password.value }
          : purpose === 'reset' ? { token, purpose, newPassword: password.value } : { token, purpose })
      });
      const result = await response.json();
      if (!response.ok || result.updated !== true) {
        message.textContent = response.status === 403 ? labels.invalid : response.status === 429 ? labels.limited : response.status === 400 ? labels.weak : labels.failure;
        return;
      }
      token = ''; displayName.value = password.value = confirm.value = ''; form.hidden = true;
      message.textContent = purpose === 'reset' ? labels.saved : purpose === 'register' ? labels.registered : labels.verified;
    } catch { message.textContent = labels.failure; }
    finally { busy = false; button.disabled = false; }
  });
})();`;
export function registerAccountEmailPage(app: FastifyInstance): void {
  const hash = createHash('sha256').update(EMAIL_ACTION_SCRIPT).digest('base64');
  app.get('/account-email', async (_req, reply) => reply.type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    .header('X-Robots-Tag', 'noindex, nofollow')
    .header('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
    .send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تداوي | TADAWEE</title><style>body{font-family:Arial,sans-serif;background:#eff7f2;color:#193e2f;padding:24px}main{max-width:480px;margin:5vh auto;background:white;padding:28px;border-radius:20px}label{display:block;margin:16px 0 8px}input,button{box-sizing:border-box;width:100%;font-size:18px;padding:14px;border-radius:8px;border:1px solid #a8bfb2}button{background:#16734f;color:white;margin-top:20px;cursor:pointer}button:disabled{opacity:.6}p{line-height:1.8}#message{font-weight:bold}[hidden]{display:none!important}</style></head><body><main><h1>تداوي | TADAWEE</h1><h2 id="title">تأكيد البريد الإلكتروني</h2><p id="expiry"></p><p id="message" role="status" aria-live="polite"></p><form id="form"><div id="name-field" hidden><label id="name-label" for="display-name"></label><input id="display-name" type="text" autocomplete="name" minlength="1" maxlength="120"></div><div id="passwords" hidden><label id="password-label" for="password"></label><input id="password" type="password" autocomplete="new-password" minlength="10" maxlength="200"><label id="confirm-label" for="confirm"></label><input id="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="200"></div><button id="submit" type="submit">متابعة</button></form><noscript>فعّل JavaScript لإكمال التحقق. Enable JavaScript to continue.</noscript></main><script>${EMAIL_ACTION_SCRIPT}</script></body></html>`));
}
