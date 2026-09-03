import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
const go = async (r, n) => {
  await page.goto('http://localhost:8081' + r, { waitUntil: 'networkidle' });
  await sleep(2500);
  await page.screenshot({ path: `/tmp/shots/p-${n}.png` });
};
await go('/', 'today');
console.log('TODAY:', (await page.locator('body').innerText()).slice(0, 320).replace(/\n+/g, ' | '));
for (const [r, n] of [['/medications','meds'], ['/history','history'], ['/family','family'], ['/reports/adherence','adherence']]) await go(r, n);
console.log('ADHERENCE:', (await page.locator('body').innerText()).slice(0, 260).replace(/\n+/g, ' | '));
console.log('ERRORS:', errors.slice(0, 4));
await browser.close();
