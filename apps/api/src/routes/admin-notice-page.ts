import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Admin credentials stay in memory; no cookies, localStorage, analytics or CDN.
const script = String.raw`
'use strict';
let token = '', preview = null, noticeId = null;
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
async function request(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    if (response.status === 401) { token = ''; $('editor').hidden = true; $('login').hidden = false; }
    throw new Error(response.status === 403 ? 'الحساب لا يملك صلاحية الإدارة.' :
      response.status === 401 ? 'انتهت الجلسة. سجل الدخول مجددا.' : 'تعذر إكمال الطلب. رمز الحالة: ' + response.status);
  }
  return response.json();
}
function invalidate() { preview = null; noticeId = null; $('send').disabled = true; $('preview').textContent = ''; }
async function history() {
  const result = await request('/v1/admin/service-notices');
  $('history').replaceChildren();
  result.notices.forEach(n => {
    const item = document.createElement('li');
    item.textContent = n.title + ' — ' + (n.queued_at ? 'أضيف إلى قائمة الإرسال لـ ' + n.queued_count + ' حساب' : 'مسودة') +
      ' — ' + new Date(n.created_at).toLocaleString('ar-SA');
    $('history').append(item);
  });
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); $('loginButton').disabled = true;
  try {
    const result = await request('/v1/auth/login', { identifier: $('identifier').value.trim(),
      password: $('password').value, deviceId: 'notice-console-' + crypto.randomUUID(), deviceName: 'TADAWEE notice console' });
    $('password').value = ''; token = result.accessToken;
    await history(); $('login').hidden = true; $('editor').hidden = false; status('تم تسجيل الدخول. ابدأ بتجربة الإشعار على حسابك.');
  } catch (error) { status(error.message); token = ''; }
  finally { $('password').value = ''; $('loginButton').disabled = false; }
});
$('draft').addEventListener('input', invalidate);
$('draft').addEventListener('submit', async event => {
  event.preventDefault(); $('previewButton').disabled = true; $('send').disabled = true;
  try {
    noticeId = noticeId || crypto.randomUUID();
    const result = await request('/v1/admin/service-notices/preview', { id: noticeId,
      title: $('title').value, body: $('body').value, locale: $('locale').value, audience: $('audience').value });
    preview = result.notice;
    $('preview').textContent = preview.title + '\n\n' + preview.body + '\n\nعدد الحسابات المؤهلة: ' + preview.eligible_count;
    $('send').disabled = preview.eligible_count === 0 || !!preview.queued_at;
    status(preview.eligible_count ? 'راجع النص والجمهور ثم اضغط إرسال. المعاينة صالحة لمدة 30 دقيقة.' :
      'لا توجد أجهزة مؤهلة. افتح تطبيق تداوي بالحساب نفسه وفعّل الإشعارات وأعد تسجيل الجهاز، ثم أنشئ معاينة جديدة.');
  } catch (error) { status(error.message); }
  finally { $('previewButton').disabled = false; }
});
$('send').addEventListener('click', async () => {
  if (!preview || !confirm('إرسال هذا الإشعار إلى ' + preview.eligible_count + ' حساب؟')) return;
  $('send').disabled = true;
  try {
    const result = await request('/v1/admin/service-notices/' + preview.id + '/send', { confirm: true });
    preview = result.notice;
    status('أضيف إلى قائمة الإرسال لـ ' + preview.queued_count + ' حساب. هذا لا يؤكد وصوله أو قراءته على الجوال.');
    await history();
  } catch (error) { status(error.message + ' يمكنك إعادة المحاولة لنفس المعاينة؛ لن تنشأ حملة مكررة.'); $('send').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await request('/v1/auth/logout', {}); } catch { /* session expires server-side too */ }
  token = ''; invalidate(); $('editor').hidden = true; $('login').hidden = false; status('تم الخروج من لوحة الإدارة.');
});
`;
export const serviceNoticePage = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>تداوي | إدارة الإشعارات</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#eef6f3;color:#163d30;margin:0;padding:24px}main{max-width:680px;margin:auto}section,form,aside{background:white;padding:24px;border-radius:18px;margin:16px 0}h1{font-size:28px}label{display:block;margin:16px 0 6px}input,textarea,select,button{font:inherit;width:100%;padding:13px;border-radius:9px;border:1px solid #a5c9bc}button{background:#116652;color:white;cursor:pointer;margin-top:16px}button:disabled{opacity:.45;cursor:default}textarea{min-height:130px}#preview{white-space:pre-wrap;background:#e7f4ee;padding:18px;border-radius:12px}#status{line-height:1.8}small{display:block;line-height:1.7;color:#49695e}li{margin:14px 0}[hidden]{display:none!important}</style></head><body><main>
<h1>تداوي | إدارة الإشعارات</h1><p>إشعارات خدمية تظهر من تطبيق تداوي على الجوال.</p>
<p id="status" role="status" aria-live="polite"></p>
<form id="login"><h2>دخول المسؤول</h2><label for="identifier">البريد الإلكتروني أو رقم الجوال</label><input id="identifier" autocomplete="username" required>
<label for="password">كلمة المرور</label><input id="password" type="password" autocomplete="current-password" required><button id="loginButton">تسجيل الدخول</button></form>
<div id="editor" hidden><form id="draft"><h2>إشعار جديد</h2><small>لتحديثات الخدمة فقط. الإعلانات التسويقية تحتاج موافقة مستقلة. لا تضع أسماء مرضى أو معلومات دوائية هنا.</small>
<label for="title">العنوان</label><input id="title" maxlength="80" value="تحديث من تداوي" required>
<label for="body">نص الإشعار</label><textarea id="body" maxlength="500" required></textarea>
<label for="locale">لغة الجمهور</label><select id="locale"><option value="ar">العربية</option><option value="en">English</option></select>
<label for="audience">المستلمون</label><select id="audience"><option value="self">حسابي فقط — تجربة</option><option value="all">الحسابات المؤهلة باللغة المختارة</option></select>
<small>الإشعار يفتح التطبيق. لا يثبت تحديثا ولا يفتح المتجر تلقائيا. الحساب المؤهل لديه ملف شخصي وجهاز مسجل بجلسة نشطة. نحترم ساعات الهدوء؛ الوصول يعتمد على إعدادات الجوال.</small>
<button id="previewButton">معاينة وعدّ المستلمين</button></form>
<section><div id="preview"></div><button id="send" disabled>إرسال الإشعار</button></section>
<section><h2>آخر الإشعارات</h2><ul id="history"></ul><small>العدد المعروض عدد الحسابات في قائمة الإرسال، وقد يملك الحساب أكثر من جهاز.</small></section>
<button id="logout">تسجيل الخروج</button></div></main><script>${script}</script></body></html>`;

export function registerAdminNoticePage(app: FastifyInstance): void {
  const hash = createHash('sha256').update(script).digest('base64');
  app.get('/admin/notifications', async (_req, reply) => reply
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
    .type('text/html; charset=utf-8').send(serviceNoticePage));
}
