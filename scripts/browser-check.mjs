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
const launchSortie = async () => {
  await page.waitForFunction(() => window.__DRIFT__.snapshot().flow === 'flight', { timeout: 25000 });
  // Control is handed over when the launch card clears; pausing during the cinematic is ignored.
  await page.locator('.launch-card').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
};

try {
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__DRIFT__), { timeout: 30000 });
  if (missionMode) {
    await page.locator('#title-begin').click();
    await page.locator('#launch-sortie').click();
    await launchSortie();
    const { runMission } = await import('./mission-run.mjs');
    await runMission(page);
    assert.equal(errors.length, 0, `browser errors: ${errors.join('; ')}`);
    console.log('Complete sortie passed: relay telemetry, three scanned archives, black box, station dock, payment and relaunch verified.');
  } else {
    assert.equal((await snapshot()).flow, 'title', 'sortie starts on the title screen');
    await page.screenshot({ path: 'artifacts/title.png' });

    await page.locator('#title-begin').click();
    await page.locator('#hangar-viewport canvas').waitFor({ timeout: 20000 });
    assert.equal((await snapshot()).flow, 'hangar', 'hangar opens before launch');
    await page.waitForTimeout(900);
    await page.screenshot({ path: 'artifacts/hangar.png' });
    await page.locator('.bay-tab[data-ship="mule"]').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'artifacts/hangar-mule.png' });
    await page.locator('.bay-tab[data-ship="kestrel"]').click();
    await page.waitForTimeout(400);

    await page.locator('#launch-sortie').click();
    assert.equal((await snapshot()).flow, 'launch', 'launch cinematic runs before control is handed over');
    await page.waitForTimeout(900);
    await page.screenshot({ path: 'artifacts/launch.png' });
    await launchSortie();
    await page.screenshot({ path: 'artifacts/desktop.png' });
    assert.equal((await snapshot()).stage, 0, 'the sortie opens on the first contract stage');
    assert(await page.locator('#collar-canvas').isVisible(), 'the bearing ring is drawn in flight');
    assert.equal(await page.locator('#radar-plate').isVisible(), false, 'the sector chart stays out of the flight view');

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
    assert(await page.locator('.map-legend').isVisible(), 'sector chart legend is shown');
    assert(await page.locator('#radar-canvas').isVisible(), 'the sector chart is drawn in map mode');
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
    await page.locator('#shipyard-bay canvas').waitFor({ timeout: 20000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: 'artifacts/shipyard.png' });
    await page.locator('#dialog-content [data-ship="mule"]').click();
    await launchSortie();
    assert.equal((await snapshot()).state.shipClass, 'mule');
    assert((await snapshot()).state.fuel > 29500, 'new sortie refills the tug');
    await page.locator('[data-view="shipyard"]').click();
    await page.locator('#shipyard-bay canvas').waitFor({ timeout: 20000 });
    await page.locator('#dialog-content [data-ship="needle"]').click();
    await launchSortie();
    assert.equal((await snapshot()).state.shipClass, 'needle');
    assert.equal((await snapshot()).recoveredCount, 0);

    // --- The shipyard: assemble a hull, buy a part, save it, fly it -------------------------
    await page.evaluate(() => window.__DRIFT__.openShipyard());
    await page.locator('#build-viewport canvas').waitFor({ timeout: 20000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: 'artifacts/build-empty.png' });
    const yard = () => page.evaluate(() => window.__DRIFT__.builder());
    /**
     * Fits a part through the real UI: click sockets until one that offers the part is selected,
     * then click the part. Gizmos can overlap in projection, so the first click is not always the
     * socket that ends up selected — the panel is the source of truth.
     */
    const fit = async (match, part) => {
      // Sockets of the wanted category first, then everything on screen: gizmos overlap in
      // projection, so the panel decides which socket a click actually reached.
      const order = await page.evaluate(selector => {
        const all = window.__DRIFT__.builder().sockets.filter(entry => entry.onScreen);
        return all.sort((a, b) => (b.id.includes(selector) ? 1 : 0) - (a.id.includes(selector) ? 1 : 0));
      }, match);
      assert(order.some(entry => entry.id.includes(match)), `a ${match} socket is on screen`);
      for (const socket of order) {
        await page.mouse.click(socket.x, socket.y);
        await page.waitForTimeout(160);
        const chosen = await page.locator('.builder-slot').getAttribute('data-socket');
        const option = page.locator(`[data-part="${part}"]`);
        if (chosen && await option.count() > 0) {
          await option.click();
          await page.waitForTimeout(220);
          return chosen;
        }
      }
      throw new Error(`no socket accepted ${part}`);
    };
    assert((await yard()).core === 'spar', 'the shipyard opens on the cheapest core');
    assert((await yard()).stats.valid === false, 'an empty frame refuses to launch');
    assert(await page.locator('#builder-launch').isDisabled(), 'launch is disabled while the build is invalid');
    const engineSocket = await fit('engine', 'eng-d9');
    await fit('tank', 'tnk-m');
    await fit('rcs', 'rcs-pod');
    assert((await yard()).stats.valid, 'engines, tanks and thrusters make a flyable hull');
    assert((await yard()).stats.mounts.length === 0, 'a hull with no guns reports no mounts');
    const creditsBefore = (await page.evaluate(() => window.__DRIFT__.profile())).credits;
    await fit('gun', 'wpn-ac70');
    const afterBuy = await page.evaluate(() => window.__DRIFT__.profile());
    assert(afterBuy.credits === creditsBefore - 2600, `an unowned gun is bought with credits (${creditsBefore} → ${afterBuy.credits})`);
    assert(afterBuy.owned.includes('wpn-ac70'), 'the purchase is recorded in the profile');
    const guns = (await yard()).stats.mounts;
    assert(guns.length === 2 && guns[0].lx === -guns[1].lx, 'mirrored gun sockets take a pair');
    assert(guns.every(gun => gun.weapon === 'ac70'), 'the fitted guns are the ones that were bought');
    // A filled socket is selectable again, and a part the balance cannot cover is refused there.
    const before = await page.evaluate(() => ({ credits: window.__DRIFT__.profile().credits, thrust: window.__DRIFT__.builder().stats.thrust }));
    const refitSocket = await fit('engine', 'eng-k12');
    assert(refitSocket, 'a fitted socket can be selected and refitted');
    const refused = await page.evaluate(() => ({ credits: window.__DRIFT__.profile().credits, thrust: window.__DRIFT__.builder().stats.thrust, owned: window.__DRIFT__.profile().owned, slots: window.__DRIFT__.builder().slots }));
    assert(before.credits < 9200, 'the balance cannot cover the K12 in this scenario');
    assert.equal(before.credits, refused.credits, 'a refused purchase does not touch the balance');
    assert.equal(refused.thrust, before.thrust, 'a refused purchase leaves the build untouched');
    assert(!refused.owned.includes('eng-k12'), 'a refused part is never added to the inventory');
    assert.equal(refused.slots[refitSocket], 'eng-d9', 'the refused part does not replace what is fitted');
    assert.equal(refused.slots[engineSocket], 'eng-d9', 'the first engine stays bolted on');
    // The core picker spends through the same path, without a raycast in the way.
    const coreBefore = await page.evaluate(() => window.__DRIFT__.profile().credits);
    await page.locator('[data-core="truss"]').click();
    await page.waitForTimeout(250);
    const coreAfter = await page.evaluate(() => ({ core: window.__DRIFT__.builder().core, credits: window.__DRIFT__.profile().credits, owned: window.__DRIFT__.profile().owned }));
    assert(coreAfter.credits < 6400, 'the balance cannot cover a truss core in this scenario');
    assert.equal(coreAfter.core, 'spar', 'an unaffordable core is not adopted');
    assert.equal(coreAfter.credits, coreBefore, 'the refused core does not touch the balance');
    assert(!coreAfter.owned.includes('truss'), 'the refused core is not added to the inventory');
    await page.screenshot({ path: 'artifacts/build-fitted.png' });
    await page.locator('#builder-save').click();
    await page.waitForTimeout(200);
    const saved = await page.evaluate(() => window.__DRIFT__.profile());
    assert(saved.builds.length === 1, 'the build is stored in the profile');
    await page.locator('#builder-launch').click();
    await launchSortie();
    assert.equal((await snapshot()).combat.weapons.join(','), 'ac70,ac70', 'the sortie flies the hull that was built');
    assert.equal(await page.locator('#ship-name').textContent(), 'New frame');
    await page.screenshot({ path: 'artifacts/build-flight.png' });
    await page.evaluate(() => window.__DRIFT__.openHangar());
    const tabs = await page.locator('#hangar-tabs .bay-tab').allTextContents();
    assert(tabs.some(text => text.includes('New frame')), 'the saved build appears as a hangar tab');
    await page.screenshot({ path: 'artifacts/hangar-build-tab.png' });
    await page.locator('#launch-sortie').click();
    await launchSortie();
    assert.equal((await snapshot()).combat.weapons.join(','), 'ac70,ac70', 'the hangar relaunches the saved build');
    const zoomBefore = (await snapshot()).zoom;
    await page.locator('#zoom-in').click();
    assert((await snapshot()).zoom > zoomBefore, 'zoom in raises the camera scale');
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
    writeFileSync('artifacts/browser-results.json', JSON.stringify({ passed: true, errors, checks: ['title screen', 'hangar bay', 'launch cinematic', 'WebGL scene', 'bearing ring', 'sector chart', 'thrust', 'propellant', 'inertia', 'rotation', 'braking', 'pause', 'sector radar', 'tactical chart', 'assist', 'cabin audio', 'flight manual', 'all ship classes', 'shipyard assembly', 'part purchase', 'refused purchase', 'build persistence', 'custom hull flight', 'zoom', 'cinematic view', 'mobile layout', 'touch input'] }, null, 2));
    console.log('Browser checks passed: startup flow, rendering, flight controls, chart, shipyard, mobile and touch.');
  }
} catch (error) {
  await page.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
  console.error(error); console.error('Browser errors:', errors); process.exitCode = 1;
} finally { await browser.close(); }
