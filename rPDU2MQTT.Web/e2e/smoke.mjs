// Opens every GUI page in Chromium against a running bridge.
// BASE_URL (default http://127.0.0.1:18080), PW_CHROMIUM (optional browser path).
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:18080';
const out = new URL('./out/', import.meta.url).pathname;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const failures = [];

for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, httpCredentials: { username: 'admin', password: 'smoke' } });
  const page = await ctx.newPage();
  let errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

  await page.goto(base + '/');
  await page.waitForSelector('#nav a');
  await page.waitForTimeout(1000);
  if (errors.length) failures.push(`${name} load: ${errors.join('; ')}`);

  const labels = await page.$$eval('#nav a', as => as.map(a => a.dataset.label).filter(Boolean));
  if (labels.length < 10) failures.push(`${name}: only ${labels.length} pages in the nav`);

  for (const label of labels) {
    errors = [];
    await page.$eval(`#nav a[data-label="${label}"]`, a => a.click());
    await page.waitForTimeout(600);
    const text = await page.$eval('#sections', s => s.innerText.trim().length);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const why = [...errors];
    if (!text) why.push('the page is empty');
    if (overflow > 0) why.push(`${overflow}px wider than the screen`);
    if (why.length) {
      failures.push(`${name} ${label}: ${why.join('; ')}`);
      await mkdir(out, { recursive: true });
      await page.screenshot({ path: `${out}${name}-${label.replace(/\W+/g, '-')}.png`, fullPage: true });
    }
  }
  console.log(`${name}: ${labels.length} pages opened`);
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.error('browser smoke FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('browser smoke: every page renders, with no errors and no sideways scroll on a phone');
