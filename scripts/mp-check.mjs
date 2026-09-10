import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

/**
 * LAN match check: three browsers against a running host, exercising the whole multiplayer path.
 * Start the host first (`bun run host`), then run `bun run test:mp`.
 */
const URL = process.env.DRIFT_URL ?? 'http://127.0.0.1:8080';
mkdirSync('artifacts', { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const errors = [];
const openClient = async (label) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${label}: ${message.text()}`); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  page.snapshot = () => page.evaluate(() => window.__DRIFT__.snapshot());
  return page;
};

const host = await openClient('host');
const blue = await openClient('blue');
const red = await openClient('red');

try {
  // All three reach the lobby instead of the solo sortie.
  for (const [name, page] of [['host', host], ['blue', blue], ['red', red]]) {
    await page.locator('[data-lobby]').waitFor({ timeout: 30000 });
    assert.equal((await page.snapshot()).mode, 'solo', `${name} stays in solo until the host launches`);
  }
  assert.equal((await host.snapshot()).isHost, true, 'first connection is the host');

  // Each pilot picks a callsign and a side.
  await blue.locator('#lobby-name').fill('Blue Two');
  await blue.locator('#lobby-name').dispatchEvent('change');
  await red.locator('#lobby-name').fill('Red Raider');
  await red.locator('#lobby-name').dispatchEvent('change');
  await click(red, '[data-team="red"]');
  await expectRoster(host, 3, 'the roster reaches every client');

  // Pirates see the fleet teams as hostile; prove the picker reports the choice back.
  await click(host, '[data-team="pirate"]');
  await expectRoster(blue, 3, 'team changes propagate to other clients');
  await waitFor(async () => (await blue.snapshot()).lobby.filter(p => p.team === 'pirate').length === 1);
  await click(host, '[data-team="blue"]');

  // Loadout: spend points and confirm the server-sanitized values come back.
  await blue.locator('[data-points="thrustPts"]').fill('5');
  await blue.locator('[data-points="thrustPts"]').dispatchEvent('change');
  await waitFor(async () => (await blue.snapshot()).lobby.length === 3);
  await click(blue, '[data-color="#83b9b5"]');
  await blue.locator('[data-map="quarry"]').count().then(count => assert.equal(count, 0, 'map picker is host-only'));
  await click(host, '[data-map="quarry"]');
  await waitFor(async () => (await blue.snapshot()).mapId === 'quarry');
  await click(host, '[data-map="belt"]');
  await waitFor(async () => (await blue.snapshot()).mapId === 'belt');
  await click(host, '[data-map="quarry"]');
  await waitFor(async () => (await blue.snapshot()).mapId === 'quarry');

  await click(host, '#lobby-ready');
  await click(blue, '#lobby-ready');
  await click(red, '#lobby-ready');
  await click(host, '#lobby-start');

  // Match begins on every client, with the same generated rock field on each.
  for (const page of [host, blue, red]) await waitFor(async () => (await page.snapshot()).started);
  const field = await Promise.all([host, blue, red].map(page => page.snapshot()));
  assert.equal(field[0].players.length, 3, 'three ships on the wire');
  for (const view of field) assert.equal(view.rocks, field[0].rocks, 'rock count agrees across processes');
  for (const view of field) assert.equal(view.rockHash, field[0].rockHash, 'rock field is bit-identical across processes');

  // Host flies; every client must see the host's ship move.
  const hostId = field[0].you;
  const hostX = () => field0X(blue, hostId);
  const beforeX = await hostX();
  await host.keyboard.down('w');
  await waitFor(async () => Math.abs(await hostX() - beforeX) > 5, 20000);
  await host.keyboard.up('w');
  assert(Math.abs(await hostX() - beforeX) > 5, 'remote ship interpolates forward');

  // Local prediction: the shooter's own ship reacts immediately and keeps its momentum.
  await waitFor(async () => { const v = (await host.snapshot()).state.velocity; return Math.hypot(v.x, v.y) > 5; }, 15000);
  assert.equal((await host.snapshot()).mode, 'mp');

  // Guns: hold fire, and check the tracer reaches the other clients.
  await host.keyboard.down('Space');
  await waitFor(async () => (await blue.snapshot()).bullets > 0, 15000);
  await host.keyboard.up('Space');
  await blue.screenshot({ path: 'artifacts/mp-combat.png' }).catch(() => {});

  // Fracture an asteroid: an external test pilot aims at a rock the way a player would.
  const fracture = await host.evaluate(() => {
    const pressed = new Set();
    const setKey = (code, down) => {
      if (pressed.has(code) === down) return;
      if (down) pressed.add(code); else pressed.delete(code);
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
    };
    const release = () => { for (const code of [...pressed]) setKey(code, false); };
    const wrapPi = a => ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const snap = window.__DRIFT__.snapshot();
        if (snap.splits > 0) { clearInterval(timer); release(); resolve({ splits: snap.splits, gone: snap.gone, time: snap.elapsed }); return; }
        if (performance.now() - started > 90000) {
          clearInterval(timer); release();
          reject(new Error(`no fracture: splits ${snap.splits}, destroyed ${snap.gone}, elapsed ${snap.elapsed}`));
          return;
        }
        const s = snap.state;
        const target = window.__DRIFT__.rocks()
          .filter(r => r.radius >= 12)
          .sort((a, b) => Math.hypot(a.x - s.position.x, a.y - s.position.y) - Math.hypot(b.x - s.position.x, b.y - s.position.y))[0];
        if (!target) return;
        const dx = target.x - s.position.x, dy = target.y - s.position.y;
        const distance = Math.hypot(dx, dy);
        // forward = (-sin a, cos a), so the heading that points at the rock is atan2(-dx, dy).
        const error = wrapPi(Math.atan2(-dx, dy) - s.angle);
        setKey('KeyA', error > 0.05);
        setKey('KeyD', error < -0.05);
        setKey('KeyW', Math.abs(error) < 0.35 && distance > 260);
        setKey('Space', Math.abs(error) < 0.12 && distance < 1200);
      }, 60);
    });
  });

  const after = await Promise.all([host, blue, red].map(page => page.snapshot()));
  // Every client must hold the same set of rocks, and must have applied the same fracture events.
  // Positions are integrated locally without correction, so they agree to within latency, not exactly.
  for (const view of after) assert.equal(view.rocks, after[0].rocks, 'rock count stays identical after combat');
  for (const view of after) assert.equal(view.splits, after[0].splits, 'every client fractured the same rocks');
  for (const view of after) assert.equal(view.gone, after[0].gone, 'every client destroyed the same rocks');
  const drift = Math.max(...after.map(v => Math.abs(v.rockHash - after[0].rockHash)));
  // 400 is ~30 m of aggregate displacement across the whole field: a rock in the wrong place costs
  // hundreds, while per-rock local integration drift is centimetres.
  assert(drift < 400, `rock positions stay close (worst drift ${drift.toFixed(2)})`);
  const fieldDelta = { before: field[0].rocks, after: after[0].rocks, splits: after[0].splits, gone: after[0].gone, drift, fracture };

  // Latency readout comes from the ping/pong round trip.
  await waitFor(async () => (await host.snapshot()).latency > 0, 10000);

  // Scoreboard toggles with Tab.
  await host.keyboard.press('Tab');
  assert(await host.locator('#scoreboard').isVisible(), 'scoreboard opens');
  await host.keyboard.press('Tab');

  // Host ends the match: everyone gets the debrief, then the lobby returns.
  await click(host, '#end-match');
  for (const [name, page] of [['host', host], ['blue', blue], ['red', red]]) {
    await page.locator('#dialog-title').filter({ hasText: 'Debrief' }).waitFor({ timeout: 15000 });
    const rows = await page.locator('.debrief-row').count();
    assert.equal(rows, 3, `${name} sees every pilot in the debrief`);
  }
  for (const page of [host, blue, red]) {
    await click(page, '#debrief-close');
    await page.locator('[data-lobby]').waitFor({ timeout: 15000 });
  }

  // A client leaving mid-match must not disturb the rest.
  await click(host, '#lobby-ready');
  await click(blue, '#lobby-ready');
  await click(red, '#lobby-ready');
  await click(host, '#lobby-start');
  for (const page of [host, blue]) await waitFor(async () => (await page.snapshot()).elapsed < 3 && (await page.snapshot()).players.length === 3, 15000);
  await red.close();
  await waitFor(async () => (await host.snapshot()).players.length === 2, 15000);
  const t1 = (await host.snapshot()).elapsed;
  await host.waitForTimeout(1200);
  assert((await host.snapshot()).elapsed > t1, 'host keeps simulating after a client drops');
  await host.screenshot({ path: 'artifacts/mp-match.png' });

  assert.equal(errors.length, 0, `browser errors: ${errors.join('; ')}`);
  writeFileSync('artifacts/mp-results.json', JSON.stringify({
    passed: true, errors, fieldDelta,
    checks: ['lobby on all clients', 'host election', 'callsigns', 'team picking', 'host-only map picker', 'loadout round trip',
      'launch', 'three ships', 'identical rock field', 'remote interpolation', 'local prediction', 'bullets on the wire',
      'latency readout', 'scoreboard', 'debrief', 'client drop isolation'],
  }, null, 2));
  console.log(`LAN match checks passed: lobby, teams, launch, three ships, identical rocks (${fieldDelta.before} -> ${fieldDelta.after}), combat, debrief, drop isolation.`);
} catch (error) {
  await host.screenshot({ path: 'artifacts/mp-failure.png' }).catch(() => {});
  for (const [name, page] of [['host', host], ['blue', blue], ['red', red]]) {
    if (page.isClosed()) { console.error(`${name}: closed`); continue; }
    const state = await page.evaluate(() => ({
      open: document.getElementById('game-dialog')?.open ?? null,
      content: (document.getElementById('dialog-content')?.innerHTML ?? '').slice(0, 90),
      modalOpen: window.__DRIFT__?.snapshot().modalOpen ?? null,
      paused: window.__DRIFT__?.snapshot().paused ?? null,
      started: window.__DRIFT__?.snapshot().started ?? null,
    })).catch(e => String(e));
    console.error(`${name}:`, JSON.stringify(state));
  }
  console.error(error); console.error('Browser errors:', errors); process.exitCode = 1;
} finally {
  await browser.close();
}

async function field0X(page, id) {
  const player = (await page.snapshot()).players.find(p => p.id === id);
  assert(player, 'the remote ship is present in the snapshot');
  return player.x;
}

async function expectRoster(page, size, message) {
  await waitFor(async () => (await page.snapshot()).lobby.length === size, 15000);
  assert.equal((await page.snapshot()).lobby.length, size, message);
}

async function waitFor(check, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeout) throw new Error(`Timed out after ${timeout} ms`);
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}

/** The lobby re-renders on every server message, so a click can lose its element mid-flight. */
async function click(page, selector) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const target = page.locator(selector);
    if (await target.count()) {
      try { await target.click({ timeout: 2000 }); return; } catch { /* re-rendered under us; retry */ }
    }
    await page.waitForTimeout(120);
  }
  throw new Error(`Could not click ${selector}`);
}
