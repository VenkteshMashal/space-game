/**
 * Browser outcome checks (Plan A6). Runs the real application in Chromium at every size the plan
 * lists and asserts what a pilot would experience: every screen fits without clipping, the copy is
 * reachable and keyboard-traversable, offline play actually reaches a live flight screen, one Escape
 * closes exactly one layer, resizing keeps state, a hostile name stays text, and a session that ends
 * leaves no console error behind.
 *
 * This is layout, reachability and lifecycle evidence. It is not the physical LAN/phone matrix: it
 * runs on software WebGL and cannot measure real device frame times.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'portrait', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
  { name: 'small-portrait', width: 320, height: 568 },
  { name: 'small-landscape', width: 568, height: 320 },
];

/** Screens a headless run can reach without a host process; the rest are covered by tests/ui.test.ts. */
const REQUIRED_SCREENS = ['title', 'flight', 'join'];

mkdirSync('artifacts', { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const results = { passed: false, requiredScreens: REQUIRED_SCREENS, viewports: [], errors: [] };

const screenOf = page => page.evaluate(() => document.querySelector('[data-state-mirror]')?.getAttribute('data-screen') ?? null);
const mirror = page => page.evaluate(() => {
  const element = document.querySelector('[data-state-mirror]');
  if (!element) return null;
  return Object.fromEntries([...element.attributes].map(attribute => [attribute.name.replace('data-', ''), attribute.value]));
});

async function waitForScreen(page, screen, timeout = 45000) {
  await page.waitForFunction(
    expected => document.querySelector('[data-state-mirror]')?.getAttribute('data-screen') === expected,
    screen,
    { timeout },
  );
}

/** Document overflow: the page itself must never scroll on a fixed-viewport game. */
async function overflowReport(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const offenders = [];
    for (const element of document.querySelectorAll('#drift-ui-root *, #drift-viewport *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        const style = getComputedStyle(element);
        // A deliberate horizontal scroller is a container, not clipped content.
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
        offenders.push(`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} [${Math.round(rect.left)}..${Math.round(rect.right)}] of ${window.innerWidth}`);
      }
    }
    return {
      overflowX: Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth,
      overflowY: Math.max(root.scrollHeight, body.scrollHeight) - window.innerHeight,
      offenders: offenders.slice(0, 4),
    };
  });
}

function assertFits(name, stage, report) {
  assert.equal(report.overflowX <= 1 && report.overflowY <= 1, true, `${name}: ${stage} overflows the viewport (${JSON.stringify(report)})`);
  assert.deepEqual(report.offenders, [], `${name}: ${stage} content is clipped: ${report.offenders.join('; ')}`);
}

/**
 * Click a control that may re-render between locating and clicking. On phones the lobby paginates,
 * so the caller may allow advancing pages to reach the control instead of failing on it.
 */
async function clickAction(page, action, { paginate = false, attempts = 12 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const target = page.locator(`[data-action="${action}"]`).first();
    if (await target.count() > 0 && await target.isVisible().catch(() => false)) {
      if (!(await target.isDisabled().catch(() => true))) {
        try {
          await target.click({ timeout: 2000 });
          return true;
        } catch {
          // The screen re-rendered under the click; try again.
        }
      }
    }
    if (paginate) {
      const next = page.locator('[data-action="lobby.page-next"]').first();
      if (await next.count() > 0 && await next.isVisible().catch(() => false)) {
        await next.click({ timeout: 2000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Offline play is lobby -> ready -> launch. On phones the Ready control lives on the Fit tab and on
 * a later page, while on desktop it is on the first page; try it where it is and open the tab that
 * owns it when it is not visible.
 */
async function launchOfflineMatch(page) {
  for (const tab of [null, 'lobby.tab-fit', 'lobby.tab-crew', 'lobby.tab-mission']) {
    if (tab) await clickAction(page, tab, { attempts: 3 });
    if (await clickAction(page, 'lobby.ready', { paginate: true, attempts: 4 })) {
      await page.waitForTimeout(500);
      return clickAction(page, 'lobby.start', { paginate: true, attempts: 8 });
    }
  }
  return false;
}

async function openTitle(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  // A hidden page suspends requestAnimationFrame and the shell advances boot on its frame loop, so a
  // background tab would look like a hung application.
  await page.bringToFront();
  await page.waitForSelector('[data-state-mirror]', { state: 'attached', timeout: 30000 });
  await waitForScreen(page, 'title');
}

async function checkViewport(viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = message.location()?.url ?? '';
    // A dev server has no host process, so its /api/info probe 404s; the Host screen already explains
    // the launcher in that case. Every other console error stays fatal.
    if (text.includes('Failed to load resource') && (url.includes('/api/info') || text.includes('/api/info'))) return;
    errors.push(url ? `${text} @ ${url}` : text);
  });

  const record = { name: viewport.name, width: viewport.width, height: viewport.height, screens: [], ok: true };
  try {
    // 1. Title, fit and keyboard reachability.
    await openTitle(page);
    record.screens.push('title');
    assert.deepEqual((await mirror(page))?.screen, 'title', `${viewport.name}: boot did not reach the title screen`);
    assertFits(viewport.name, 'title', await overflowReport(page));
    await page.screenshot({ path: `artifacts/outcome-${viewport.name}-title.png` });

    const focusTrail = [];
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press('Tab');
      focusTrail.push(await page.evaluate(() => {
        const element = document.activeElement;
        if (!element) return 'none';
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
        return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}:${visible ? 'visible' : 'offscreen'}`;
      }));
    }
    assert.equal(focusTrail.some(entry => entry.includes('offscreen')), false, `${viewport.name}: Tab reached an offscreen control: ${focusTrail.join(', ')}`);
    record.focusTrail = focusTrail;

    // 2. Offline play: title -> local lobby -> ready -> launch -> live flight under a real authority.
    await page.click('[data-action="title.offline"]', { timeout: 10000 });
    await waitForScreen(page, 'lobby', 45000);
    record.screens.push('lobby');
    assert.equal(await launchOfflineMatch(page), true, `${viewport.name}: the offline lobby would not launch`);
    await waitForScreen(page, 'flight', 60000);
    await page.waitForFunction(() => window.__DRIFT__?.view().phase === 'live');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#drift-ui-root')).backgroundColor), 'rgba(0, 0, 0, 0)', 'Flight UI hides the game canvas');
    assert.equal(await page.evaluate(() => window.__DRIFT__.view().ships.length >= 3), true, 'Offline skirmish has no opponents');
    if (viewport.name === 'desktop') {
      await page.mouse.click(viewport.width / 2, viewport.height / 2);
      const before = await page.evaluate(() => window.__DRIFT__.view().self.predictionState.fuelKg);
      await page.keyboard.down('KeyW');
      await page.waitForFunction(fuel => window.__DRIFT__.view().self.predictionState.fuelKg < fuel, before);
      await page.keyboard.up('KeyW');
      const ammo = await page.evaluate(() => window.__DRIFT__.view().weapons.reduce((sum, w) => sum + (w.magazine ?? 0), 0));
      await page.mouse.down();
      await page.waitForFunction(ammo => window.__DRIFT__.view().weapons.reduce((sum, w) => sum + (w.magazine ?? 0), 0) < ammo, ammo);
      await page.mouse.up();
    }
    record.screens.push('flight');
    const hud = await page.evaluate(() => ({
      regions: ['root', 'instruments', 'radar'].filter(region => document.querySelector(`[data-hud="${region}"]`)),
      canvas: (() => { const canvas = document.querySelector('#drift-viewport canvas'); return canvas ? [canvas.width, canvas.height] : null; })(),
      contacts: document.querySelectorAll('[data-contact]').length,
    }));
    assert.deepEqual(hud.regions, ['root', 'instruments', 'radar'], `${viewport.name}: HUD regions missing (${JSON.stringify(hud)})`);
    assert.equal(hud.canvas !== null && hud.canvas[0] > 0 && hud.canvas[1] > 0, true, `${viewport.name}: no sized WebGL canvas behind the shell`);
    assertFits(viewport.name, 'flight', await overflowReport(page));
    await page.screenshot({ path: `artifacts/outcome-${viewport.name}-flight.png` });

    // 3. The menu key opens exactly one layer; Escape closes exactly one layer, and neither changes
    //    the authority phase. (`P` is the documented Pause / menu binding; Escape closes layers.)
    const phaseBefore = (await mirror(page))?.phase;
    await page.keyboard.press('KeyP');
    await page.waitForTimeout(300);
    assert.equal((await mirror(page))?.overlay, 'menu', `${viewport.name}: the menu key did not open the menu`);
    const pausedTick = await page.evaluate(() => window.__DRIFT__.view().tick);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__DRIFT__.view().tick), pausedTick, 'Offline pause did not stop simulation');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal((await mirror(page))?.overlay, 'none', `${viewport.name}: Escape did not close one layer`);
    assert.equal((await mirror(page))?.phase, phaseBefore, `${viewport.name}: an overlay changed the authority phase`);

    // 4. Rotating must keep the live screen and still fit.
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await page.waitForTimeout(500);
    assert.equal(await screenOf(page), 'flight', `${viewport.name}: rotating left the flight screen`);
    assertFits(viewport.name, 'rotated flight', await overflowReport(page));
    await page.screenshot({ path: `artifacts/outcome-${viewport.name}-rotated.png` });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // 5. Join: a hostile name stays text.
    await openTitle(page);
    await page.click('[data-action="title.join"]', { timeout: 10000 });
    await waitForScreen(page, 'join', 20000);
    record.screens.push('join');
    const field = page.locator('input[type="text"], input:not([type])').first();
    if (await field.count() > 0) {
      await field.fill('<img src=x onerror="window.__XSS__=1">');
      await page.waitForTimeout(200);
      const injected = await page.evaluate(() => ({ images: document.querySelectorAll('#drift-ui-root img').length, xss: Boolean(window.__XSS__) }));
      assert.equal(injected.images, 0, `${viewport.name}: a name became a DOM element`);
      assert.equal(injected.xss, false, `${viewport.name}: a name executed as script`);
    }
    assertFits(viewport.name, 'join', await overflowReport(page));
    await page.screenshot({ path: `artifacts/outcome-${viewport.name}-join.png` });

    for (const required of REQUIRED_SCREENS) {
      assert.equal(record.screens.includes(required), true, `${viewport.name}: never reached the ${required} screen`);
    }
    assert.deepEqual(errors, [], `${viewport.name}: browser errors: ${errors.join(' | ')}`);
  } catch (error) {
    record.ok = false;
    record.failure = error instanceof Error ? error.message : String(error);
    // Capture what the screen actually offered, so a failure names the control that was missing.
    record.diagnostics = await page.evaluate(() => {
      const mirror = document.querySelector('[data-state-mirror]');
      const visible = element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return {
        mirror: mirror ? Object.fromEntries([...mirror.attributes].map(attribute => [attribute.name, attribute.value])) : null,
        actions: [...document.querySelectorAll('[data-action]')].filter(visible).map(element => element.getAttribute('data-action')),
        overlays: [...document.querySelectorAll('[data-overlay]')].map(element => `${element.getAttribute('data-overlay')}${visible(element) ? '' : '(hidden)'}`),
        text: (document.querySelector('#drift-ui-root .screen, #drift-ui-root [data-screen]')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
      };
    }).catch(() => null);
    results.errors.push(`${viewport.name}: ${record.failure}`);
    await page.screenshot({ path: `artifacts/outcome-${viewport.name}-failure.png` }).catch(() => {});
  } finally {
    record.browserErrors = errors;
    results.viewports.push(record);
    await page.close();
  }
}

for (const viewport of VIEWPORTS) {
  await checkViewport(viewport);
  process.stdout.write(`\rchecked ${viewport.name}          `);
}
process.stdout.write('\n');

await browser.close();

results.passed = results.viewports.every(entry => entry.ok) && results.errors.length === 0;
writeFileSync('artifacts/outcome-results.json', JSON.stringify(results, null, 2));

for (const entry of results.viewports) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name} ${entry.width}x${entry.height} screens=${entry.screens.join(',')}${entry.failure ? ` — ${entry.failure}` : ''}`);
  if (!entry.ok && entry.diagnostics) console.log(`     saw: ${JSON.stringify(entry.diagnostics)}`);
}

if (!results.passed) {
  console.error(`\nOutcome checks failed:\n${results.errors.join('\n')}`);
  process.exit(1);
}
console.log('\nBrowser outcome checks passed at every listed viewport.');
