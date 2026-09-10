import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../evidence/', import.meta.url));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const results = [];
async function inspect(label) {
  const issues = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button,.screen,.review,.fit-panel,.roster-panel,.menu-footer')) {
      if (!el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.x < -.5 || r.y < -.5 || r.right > innerWidth + .5 || r.bottom > innerHeight + .5) bad.push(`offscreen ${el.id || el.className || el.textContent}`);
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) bad.push(`overflow ${el.id || el.className || el.textContent}`);
    }
    const panel = document.querySelector('#stage[data-view=hangar] .fit-panel,#stage[data-view=lobby] .roster-panel');
    const footer = document.querySelector('.screen:not([hidden]) .menu-footer');
    if (panel && footer && panel.getBoundingClientRect().bottom > footer.getBoundingClientRect().top + 1) bad.push('panel overlaps footer');
    return bad;
  });
  results.push({ label, issues }); assert.deepEqual(issues, [], label);
}
try {
  await page.goto(process.env.DESIGN_URL || 'http://127.0.0.1:5173/design/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__DRIFT_DESIGN__?.ready);
  for (const [width, height] of [[1440, 900], [1366, 768], [390, 844], [844, 390], [320, 568], [568, 320]]) {
    await page.setViewportSize({ width, height });
    for (const screen of ['flight', 'lobby', 'hangar']) {
      await page.locator(`[data-screen=${screen}]`).click();
      await inspect(`${screen} ${width}x${height}`);
      if (width === 1440 || width === 390 || width === 568) await page.screenshot({ path: `${output}/${screen}-${width}.png` });
      if (screen === 'lobby' && width <= 600) {
        await page.locator('[data-lobby-pane=mission]').click(); await inspect(`lobby mission ${width}x${height}`);
        await page.locator('[data-lobby-pane=crew]').click();
      }
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator('[data-screen=lobby]').click();
  await page.locator('#ready').click(); assert.equal(await page.locator('#ready').getAttribute('aria-pressed'), 'true');
  await page.locator('#crew-next').click(); assert.equal(await page.locator('#roster .crew-row').count(), 4);
  assert.match(await page.locator('#roster').innerText(), /Open seat/); await page.locator('#crew-prev').click();
  await page.locator('[data-screen=hangar]').click(); await page.locator('#part-next').click();
  assert.equal(await page.locator('#part-name').innerText(), 'Lance rail'); await page.locator('#fit').click();
  assert.match(await page.locator('#fit-status').innerText(), /Ready status cleared/);
  await page.locator('#part-next').click(); assert.equal(await page.locator('#part-name').innerText(), 'Suture cutter');
  await page.locator('[data-screen=flight]').click(); await page.locator('#link-state').click();
  assert(await page.locator('#notice').isVisible()); assert(await page.locator('#scan').isDisabled());
  await page.locator('#link-state').click(); await page.locator('#scan').click();
  assert.match(await page.locator('#objective').innerText(), /Return to Vesper/);
  await page.keyboard.press('Tab'); assert(await page.evaluate(() => document.activeElement?.tagName === 'BUTTON'));
  assert.deepEqual(errors, []);
  console.log(`${results.length} viewport/screen checks and prototype interactions passed.`);
} finally {
  writeFileSync(`${output}/layout-check.json`, JSON.stringify({ results, errors, scope: 'Headless Chrome with software WebGL. No real LAN, physical phone performance or full release accessibility claim.' }, null, 2) + '\n');
  await browser.close();
}
