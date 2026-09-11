import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

mkdirSync('artifacts', { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const snapshot = () => page.evaluate(() => window.__DRIFT__.snapshot());
const yard = () => page.evaluate(() => window.__DRIFT__.builder());
const launch = async () => {
  await page.waitForFunction(() => window.__DRIFT__.snapshot().flow === 'flight', null, { timeout: 40000 });
  await page.locator('.navigation-info').waitFor({ state: 'visible' });
};
const fit = async (socket, part) => {
  await page.locator(`button[data-socket="${socket}"]`).click();
  await page.locator(`[data-part="${part}"]`).click();
  assert.equal((await yard()).slots[socket], part || null);
};
const shots = [];
try {
  // Deliberately migrate a broke legacy profile; the full catalog must still be usable.
  await page.addInitScript(() => {
    if (!localStorage.getItem('drift-profile-v1')) localStorage.setItem('drift-profile-v1', JSON.stringify({
      v: 1, credits: 0, owned: [], builds: [], activeShip: { kind: 'stock', id: 'kestrel' }, completed: [], callsign: 'Rook', bestTimes: {},
    }));
  });
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__DRIFT__), null, { timeout: 45000 });
  assert.equal((await snapshot()).flow, 'hangar');
  assert.equal(await page.locator('#title-screen').isVisible(), false);
  assert.equal(await page.locator('.brief-details').getAttribute('open'), null);
  await page.screenshot({ path: 'artifacts/hangar.png' }); shots.push('hangar');
  await page.locator('#hangar-back').click();
  await page.locator('#manual-close').click();
  assert(await page.locator('#hangar-viewport canvas').isVisible(), 'closing help retains the ship preview');
  for (const ship of ['mule', 'needle', 'kestrel']) {
    await page.locator(`#hangar-tabs [data-ship="${ship}"]`).click();
    assert((await page.locator('#hangar-ship').textContent()).toLowerCase().includes(ship));
  }
  await page.locator('#hangar-shipyard').click();
  await page.locator('#build-viewport canvas').waitFor();
  assert.equal((await yard()).core, 'aegis');
  assert((await yard()).stats.valid);
  assert((await yard()).stats.mounts.some(m => m.weapon === 'torpedo'));
  assert((await yard()).stats.mounts.some(m => m.weapon === 'plasma'));
  assert.equal(await page.locator('.part-preview').count(), 29);
  assert(await page.locator('.part-preview').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
  await page.screenshot({ path: 'artifacts/shipyard.png' }); shots.push('shipyard');
  await fit('port-forward-turret', 'wpn-ac70');
  assert.equal((await yard()).slots['starboard-forward-turret'], 'wpn-ac70');
  await page.locator('#builder-mirror').click();
  await fit('port-forward-turret', 'wpn-pdc');
  assert.equal((await yard()).slots['starboard-forward-turret'], 'wpn-ac70', 'asymmetric fitting preserves paired mount');
  await page.locator('#builder-name').fill('Wayfarer Sentinel');
  await page.locator('#builder-save').click();
  assert.equal((await page.evaluate(() => window.__DRIFT__.profile())).credits, 0);
  await page.locator('#builder-view-top').click();
  await page.locator('#builder-view-side').click();
  await page.locator('#builder-view-reset').click();
  await page.locator('details.hull-section summary').click();
  await page.locator('[data-core="keel"]').click();
  assert.equal((await yard()).core, 'keel');
  assert(await page.locator('#builder-launch').isDisabled(), 'empty draft requires engine and fuel');
  await page.locator('details.starter-section summary').click();
  await page.locator('[data-preset="patrol"]').click();
  await page.locator('#builder-name').fill('Wayfarer Sentinel');
  await page.locator('#builder-save').click();
  await page.locator('#builder-launch').click();
  await launch();
  assert((await snapshot()).combat.weapons.includes('pdc'));
  assert((await snapshot()).combat.weapons.includes('torpedo'));
  assert.equal(await page.locator('#ship-name').textContent(), 'Wayfarer Sentinel');
  assert(await page.locator('.navigation-info').isVisible());
  assert.equal(await page.locator('.weapon-row').count(), 3);
  assert.equal(await page.locator('#radar-plate').isVisible(), false);
  assert.equal(await page.locator('#hull-value').evaluate(el => getComputedStyle(el).opacity), '1');
  await page.locator('#space-canvas').click({ position: { x: 640, y: 400 } });
  await page.keyboard.down('Space');
  await page.waitForFunction(() => window.__DRIFT__.snapshot().combat.liveRounds > 0);
  assert.equal((await snapshot()).combat.missiles, 0, 'primary trigger does not launch missiles');
  await page.keyboard.up('Space');
  await page.keyboard.down('g');
  await page.waitForFunction(() => window.__DRIFT__.snapshot().combat.missiles > 0);
  await page.keyboard.up('g');
  await page.keyboard.down('c');
  await page.waitForFunction(() => window.__DRIFT__.render().beams.some(beam => beam.visible));
  await page.keyboard.up('c');
  await page.screenshot({ path: 'artifacts/desktop.png' }); shots.push('desktop');
  await page.keyboard.down('w');
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) > 6);
  await page.keyboard.up('w');
  await page.locator('#brake-button').click();
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) < .1);
  await page.locator('#pause-button').click();
  const stopped = await snapshot(); await page.waitForTimeout(200);
  assert.equal((await snapshot()).elapsed, stopped.elapsed);
  await page.locator('#resume-button').click();
  await page.locator('[data-view="map"]').click();
  assert((await snapshot()).tactical);
  await page.locator('[data-view="flight"]').click();
  await page.evaluate(() => window.__DRIFT__.openHangar());
  assert((await page.locator('#hangar-tabs').textContent()).includes('Wayfarer Sentinel'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__DRIFT__));
  assert((await page.locator('#hangar-tabs').textContent()).includes('Wayfarer Sentinel'));
  await page.locator('#launch-sortie').click(); await launch();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  assert(await page.locator('.touch-controls').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const panels = await page.locator('.hud-bottom-left, .hud-bottom-right').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, bottom: r.bottom }; }));
  assert(panels[0].right <= panels[1].x, 'mobile instrument panels do not overlap');
  assert(panels.every(panel => panel.x >= 0 && panel.right <= 390 && panel.bottom <= 844));
  await page.screenshot({ path: 'artifacts/mobile.png' }); shots.push('mobile');
  const burn = await page.locator('[data-key="KeyW"]').boundingBox();
  await page.mouse.move(burn.x + burn.width / 2, burn.y + burn.height / 2); await page.mouse.down();
  await page.waitForFunction(() => Math.hypot(window.__DRIFT__.snapshot().state.velocity.x, window.__DRIFT__.snapshot().state.velocity.y) > 2);
  await page.mouse.up();
  await page.evaluate(() => window.__DRIFT__.openShipyard());
  await page.screenshot({ path: 'artifacts/shipyard-mobile.png' }); shots.push('shipyard-mobile');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(errors.length, 0, errors.join('; '));
  writeFileSync('artifacts/browser-results.json', JSON.stringify({ passed: true, errors, shots, checks: ['direct hangar startup', 'stock fleet', 'free legacy migration', '29 rendered component previews', 'socket fitting', 'mirror toggle', 'free hulls and presets', 'invalid draft gating', 'persistence', 'custom flight', 'separate missile input', 'mining beam', 'readable HUD', 'thrust and braking', 'pause', 'map', 'mobile HUD and touch'] }, null, 2));
  console.log('Browser checks passed: free shipyard, custom flight, weapons, mining, HUD and touch.');
} catch (error) {
  await page.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
  console.error(error); console.error('Browser errors:', errors); process.exitCode = 1;
} finally { await browser.close(); }
