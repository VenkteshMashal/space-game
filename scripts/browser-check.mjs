import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

mkdirSync('artifacts', { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const missionMode = process.argv.includes('--mission');
const page = await browser.newPage({ viewport: missionMode ? { width: 480, height: 580 } : { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const snapshot = () => page.evaluate(() => window.__DRIFT__.snapshot());

try {
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__DRIFT__), { timeout: 30000 });
  if (missionMode) {
    const { runMission } = await import('./mission-run.mjs');
    await runMission(page);
    assert.equal(errors.length, 0, `browser errors: ${errors.join('; ')}`);
    console.log('Complete sortie passed: all three archives recovered, station docked, payment and replay verified.');
  } else {
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'artifacts/desktop.png' });
  assert.equal((await snapshot()).state.shipClass, 'kestrel');
  await page.keyboard.down('w');
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) > 8, { timeout: 20000 });
  await page.screenshot({ path: 'artifacts/engine-burn.png' });
  await page.keyboard.up('w');
  const afterBurn = await snapshot();
  assert(Math.hypot(afterBurn.state.velocity.x, afterBurn.state.velocity.y) > 5, 'main engine accelerates ship');
  assert(afterBurn.state.fuel < 16000, 'burn uses propellant');
  await page.waitForTimeout(400);
  const coast = await snapshot();
  assert(Math.abs(coast.state.velocity.x - afterBurn.state.velocity.x) < 0.2, 'coasting preserves momentum');
  await page.keyboard.down('a');
  await page.waitForFunction(angle => window.__DRIFT__.snapshot().state.angle > angle + 0.04, afterBurn.state.angle, { timeout: 15000 });
  await page.keyboard.up('a');
  assert((await snapshot()).state.angle > afterBurn.state.angle, 'rotation responds to keys');
  await page.locator('#brake-button').click();
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) < 0.05, { timeout: 15000 });
  await page.keyboard.down('s');
  await page.waitForFunction(() => window.__DRIFT__.snapshot().state.thrustLevel < 0 && window.__DRIFT__.snapshot().state.rcsActive);
  await page.keyboard.up('s');
  await page.keyboard.down('x');
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) < 0.05);
  await page.keyboard.up('x');
  await page.locator('#pause-button').click();
  const frozen = await snapshot(); await page.waitForTimeout(350);
  assert.equal((await snapshot()).elapsed, frozen.elapsed, 'pause freezes physics');
  await page.locator('#resume-button').click();
  await page.locator('[data-view="map"]').click();
  assert.equal((await snapshot()).tactical, true);
  await page.screenshot({ path: 'artifacts/system-map.png' });
  await page.locator('[data-view="flight"]').click();
  await page.locator('#assist-button').click(); assert.equal((await snapshot()).state.assist, false);
  await page.locator('#sound-button').click();
  await page.getByRole('button', { name: 'Mute cabin audio' }).waitFor();
  await page.locator('#sound-button').click();
  await page.getByRole('button', { name: 'Enable cabin audio' }).waitFor();
  await page.locator('#help-button').click();
  await page.locator('#dialog-title').filter({ hasText: 'Space doesn’t have brakes.' }).waitFor();
  await page.screenshot({ path: 'artifacts/flight-manual.png' });
  await page.locator('#manual-close').click();
  await page.locator('[data-view="shipyard"]').click();
  await page.locator('[data-preview="needle"] img').waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'artifacts/shipyard.png' });
  await page.locator('[data-ship="mule"]').click();
  assert.equal((await snapshot()).state.shipClass, 'mule');
  assert.equal((await snapshot()).state.fuel, 30000);
  await page.locator('[data-view="shipyard"]').click();
  await page.locator('[data-ship="needle"]').click();
  assert.equal((await snapshot()).state.shipClass, 'needle');
  assert.equal((await snapshot()).recoveredCount, 0);
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-value').filter({ hasText: '1.1×' }).waitFor();
  await page.locator('#camera-button').click();
  assert(await page.locator('.game-shell').evaluate(el => el.classList.contains('cinematic')));
  await page.locator('#camera-button').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toast').evaluate(el => el.classList.remove('visible'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/mobile.png' });
  assert(await page.locator('.touch-controls').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on mobile');
  const thrustButton = page.locator('[data-key="KeyW"]');
  const rect = await thrustButton.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) > 2, { timeout: 15000 });
  await page.mouse.up();
  assert(Math.hypot((await snapshot()).state.velocity.x, (await snapshot()).state.velocity.y) > 1, 'touch burn control accelerates ship');
  assert.equal(errors.length, 0, `browser errors: ${errors.join('; ')}`);
  writeFileSync('artifacts/browser-results.json', JSON.stringify({ passed: true, errors, checks: ['WebGL scene', 'thrust', 'propellant', 'inertia', 'rotation', 'braking', 'pause', 'tactical map', 'assist', 'cabin audio', 'flight manual', 'all ship classes', 'zoom', 'cinematic view', 'mobile layout', 'touch input'] }, null, 2));
  console.log('Browser checks passed: rendering, flight controls, views, shipyard, mobile and touch.');
  }
} catch (error) {
  await page.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
  console.error(error); console.error('Browser errors:', errors); process.exitCode = 1;
} finally { await browser.close(); }
