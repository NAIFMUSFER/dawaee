/** A local print preview for the escaped HTML produced by buildPatientReport.
 * No popup, upload, persistent record, or Web Share support is required. */
export function showWebPatientReport(html: string, title: string, isCurrent: () => boolean): boolean {
  if (typeof document === 'undefined' || !isCurrent()) return false;
  const report = new DOMParser().parseFromString(html, 'text/html');
  const arabic = report.documentElement.lang === 'ar';
  const previousFocus = document.activeElement;
  const preview = document.createElement('dialog');
  preview.id = 'tadawee-patient-report-print';
  preview.setAttribute('aria-label', title);
  preview.dir = arabic ? 'rtl' : 'ltr';
  preview.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:24px;box-sizing:border-box;border:0;background:white;color:#102622;overflow:auto';
  // Isolate report typography from the app. The report builder escapes all data
  // and emits only static markup and local CSS, never scripts or remote assets.
  const host = document.createElement('div');
  preview.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = document.createElement('style');
  styles.textContent = (report.querySelector('style')?.textContent ?? '').replace(/body\{/g, ':host{') +
    '\n.controls{display:flex;gap:12px;position:sticky;top:0;background:white;padding:12px 0;border-bottom:1px solid #bccdc9}button{font:inherit;min-height:44px;padding:8px 20px;border:1px solid #086158;border-radius:8px;background:#e8f4f0;color:#086158;cursor:pointer}@media print{.controls{display:none!important}}';
  const controls = document.createElement('div');
  controls.className = 'controls';
  const print = document.createElement('button');
  print.textContent = arabic ? 'طباعة / حفظ PDF' : 'Print / Save PDF';
  const close = document.createElement('button');
  close.textContent = arabic ? 'إغلاق' : 'Close';
  controls.append(print, close);
  const content = document.createElement('article');
  content.append(...Array.from(report.body.childNodes));
  shadow.append(styles, controls, content);
  const printStyles = document.createElement('style');
  printStyles.textContent = '@media print{body > :not(#tadawee-patient-report-print){display:none!important}html,body{height:auto!important;overflow:visible!important}#tadawee-patient-report-print{display:block!important;position:static!important;width:auto!important;height:auto!important;max-height:none!important;padding:0!important;overflow:visible!important}#tadawee-patient-report-print::backdrop{display:none!important}}';
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (timer) clearInterval(timer);
    preview.remove();
    printStyles.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  close.addEventListener('click', cleanup);
  preview.addEventListener('close', cleanup);
  print.addEventListener('click', () => {
    if (!isCurrent()) { cleanup(); return; }
    window.print();
  });
  document.head.append(printStyles);
  document.body.append(preview);
  try {
    if (!isCurrent()) { cleanup(); return false; }
    preview.showModal();
    close.focus();
    timer = setInterval(() => { if (!isCurrent()) cleanup(); }, 250);
    return true;
  } catch (error) {
    cleanup();
    throw error;
  }
}
