/**
 * LAN match check (Plan B C1/C5). Starts its own host process on a spare port, claims the operator
 * seat the way the launcher does (loopback URL with its one-use fragment), then drives two real
 * browsers: the operator hosts, a guest joins, both ready up, the captain launches, and both must
 * observe the same live match with two crew and no console errors.
 *
 * The room's protocol behaviour is covered by tests/server.test.ts; this is the browser half.
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const BUN = process.env.BUN_PATH ?? 'bun';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT ?? 8099);

mkdirSync('artifacts', { recursive: true });

const results = { passed: false, port: PORT, epochs: {}, errors: [], steps: [] };
const activeSides = [];
let hostProcess = null;
let browser = null;

/** Wait for the host's startup banner and take the operator URL, fragment included. */
function startHost() {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN, ['src/server/serve.ts', '--port', String(PORT), '--mode', 'team-deathmatch', '--data', mkdtempSync(join(tmpdir(), 'drift-lan-check-'))], { cwd: process.cwd(), windowsHide: true });
    hostProcess = child;
    let output = '';
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`host did not start:\n${output.slice(-600)}`)), 40000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      const operator = output.match(/Operator:\s*(\S+)/)?.[1];
      const listening = /listening on 0\.0\.0\.0/.test(output);
      if (operator && listening) finish(null, { operatorUrl: operator, guestOrigin: `http://127.0.0.1:${PORT}/` });
    });
    child.stderr.on('data', chunk => {
      output += String(chunk);
    });
    child.on('exit', code => finish(new Error(`host exited with ${code}:\n${output.slice(-600)}`)));
    child.on('error', error => finish(error));
  });
}

/** Read the room's join policy from the host itself, so a local-only UI change cannot pass this. */
async function hostPolicy() {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/info`);
  const info = await response.json();
  return info.joinPolicy ?? null;
}

const mirror = page => page.evaluate(() => {
  const element = document.querySelector('[data-state-mirror]');
  return element ? Object.fromEntries([...element.attributes].map(attribute => [attribute.name.replace('data-', ''), attribute.value])) : null;
});

async function waitFor(page, screen, timeout = 45000) {
  await page.waitForFunction(
    expected => document.querySelector('[data-state-mirror]')?.getAttribute('data-screen') === expected,
    screen,
    { timeout },
  );
}

async function clickAction(page, action, { attempts = 12, paginate = false } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const target = page.locator(`[data-action="${action}"]`).first();
    if (await target.count() > 0 && await target.isVisible().catch(() => false)) {
      if (!(await target.isDisabled().catch(() => true))) {
        try {
          await target.click({ timeout: 2000 });
          return true;
        } catch {
          // The screen re-rendered under the click.
        }
      }
    }
    if (paginate) {
      const next = page.locator('[data-action="lobby.page-next"]').first();
      if (await next.count() > 0 && await next.isVisible().catch(() => false)) await next.click({ timeout: 1500 }).catch(() => {});
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function openPage(label, url) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${String(error.message).slice(0, 160)}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 160)}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForSelector('[data-state-mirror]', { state: 'attached', timeout: 30000 });
  await waitFor(page, 'title');
  return { label, page, url, errors };
}

async function joinRoom(side, name) {
  side.page.bringToFront();
  assert.equal(await clickAction(side.page, 'title.join'), true, `${side.label}: no Join LAN control`);
  await waitFor(side.page, 'join');
  await side.page.locator('input[data-field="join-name"]').fill(name);
  await side.page.locator('input[data-field="join-address"]').fill(new URL(side.url).host);
  await side.page.waitForTimeout(300);
  assert.equal(await clickAction(side.page, 'join.connect'), true, `${side.label}: Connect stayed blocked`);
  await waitFor(side.page, 'lobby', 45000);
}

/** Phones keep Ready on the Fit tab; the desktop lobby shows it in the fit pane and the footer. */
async function ready(page) {
  for (const tab of [null, 'lobby.tab-fit', 'lobby.tab-crew', 'lobby.tab-mission']) {
    if (tab) await clickAction(page, tab, { attempts: 3 });
    if (await clickAction(page, 'lobby.ready', { attempts: 4, paginate: true })) return true;
  }
  return false;
}

/** The crew readout arrives with the first HUD flush after the match goes live. */
async function awaitCrew(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => {
      const crew = document.querySelector('[data-hud="crew"]') ?? document.querySelector('[data-hud-region]');
      return crew?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null;
    }).catch(() => null);
    if (text && /\b2\b/.test(text)) return text;
    await page.waitForTimeout(400);
  }
  // Nothing to report: capture what the flight screen actually held so the next look is informed.
  results.crewDebug = await page.evaluate(() => {
    const drift = window.__DRIFT__;
    const view = drift?.view?.() ?? null;
    return {
      hudAttributes: [...document.querySelectorAll('[data-hud], [data-hud-region]')].map(element => `${element.getAttribute('data-hud') ?? 'region'}:${(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}`),
      flightHtml: document.querySelector('[data-screen="flight"]')?.outerHTML?.slice(0, 400) ?? null,
      phase: document.querySelector('[data-state-mirror]')?.getAttribute('data-phase'),
      view: view
        ? { link: view.link, phase: view.phase, epoch: view.epoch, tick: view.tick, ships: view.ships.length, self: view.self ? { life: view.self.ship.life, hull: view.self.ship.hull } : null, weapons: view.weapons.length, bodies: view.bodies.length }
        : 'no inspection hook',
    };
  }).catch(error => ({ error: String(error.message).slice(0, 140) }));
  return null;
}

const failureReport = async () => {
  for (const side of activeSides) {
    results[`${side.label}State`] = await mirror(side.page).catch(() => null);
    results[`${side.label}Blockers`] = await side.page.evaluate(() => ({
      blockers: [...document.querySelectorAll('[data-blocker]')].map(element => `${element.getAttribute('data-action')}: ${element.getAttribute('data-blocker')}`),
      readyNote: [...document.querySelectorAll('.blockers, .ready-note')].map(element => element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120)),
    })).catch(() => null);
    await side.page.screenshot({ path: `artifacts/lan-${side.label}-failure.png` }).catch(() => {});
  }
};

try {
  const hostInfo = await startHost();
  results.steps.push({ operatorUrl: hostInfo.operatorUrl.replace(/#.*/, '#<claim>') });
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  // The operator opens the loopback URL from the launcher, fragment and all, and claims the room.
  const operator = await openPage('operator', hostInfo.operatorUrl);
  activeSides.push(operator);

  // Host screen settings must reach the authority — not a 404 and not local-only UI state.
  await operator.page.bringToFront();
  assert.equal(await clickAction(operator.page, 'title.host'), true, 'operator: no Host guide control');
  await waitFor(operator.page, 'host');
  const policyBefore = await hostPolicy();
  assert.equal(await clickAction(operator.page, 'host.policy-code'), true, 'operator: no private-room control');
  await operator.page.waitForTimeout(600);
  assert.equal(await hostPolicy(), 'code', 'operator: the room policy did not change on the authority');
  assert.equal(await clickAction(operator.page, 'host.policy-open'), true, 'operator: no open-room control');
  await operator.page.waitForTimeout(600);
  assert.equal(await hostPolicy(), 'open', 'operator: the room policy did not return to open');
  results.policyBefore = policyBefore;
  await operator.page.screenshot({ path: 'artifacts/lan-operator-host.png' });
  assert.equal(await clickAction(operator.page, 'host.back'), true, 'operator: no way back from the Host screen');
  await waitFor(operator.page, 'title');

  await joinRoom(operator, 'Host pilot');
  const operatorState = await mirror(operator.page);
  assert.equal(operatorState?.link, 'online', `operator: link is ${operatorState?.link}`);
  assert.equal(await operator.page.evaluate(() => document.querySelector('[data-action="lobby.start"]')?.getAttribute('data-blocker') ?? null) !== 'Only the captain starts', true, 'operator did not become the captain');

  const guest = await openPage('guest', hostInfo.guestOrigin);
  activeSides.push(guest);
  await joinRoom(guest, 'Guest pilot');

  assert.equal(await ready(operator.page), true, 'operator could not ready up');
  guest.page.bringToFront();
  assert.equal(await ready(guest.page), true, 'guest could not ready up');
  operator.page.bringToFront();
  await operator.page.waitForTimeout(400);
  assert.equal(await clickAction(operator.page, 'lobby.start', { attempts: 12, paginate: true }), true, 'the captain could not launch the match');

  for (const side of [operator, guest]) {
    await waitFor(side.page, 'flight', 90000);
    const state = await mirror(side.page);
    results.epochs[side.label] = state?.epoch ?? null;
    assert.equal(state?.phase === 'live' || state?.phase === 'countdown', true, `${side.label}: match did not go live (${state?.phase})`);
    assert.equal(state?.link, 'online', `${side.label}: link is ${state?.link}`);
  }
  assert.equal(results.epochs.guest, results.epochs.operator, `pilots are in different matches (${JSON.stringify(results.epochs)})`);
  assert.equal(typeof results.epochs.operator === 'string' && results.epochs.operator.length > 0, true, 'no match epoch was reported');
  await operator.page.waitForFunction(() => window.__DRIFT__?.view().phase === 'live');
  await operator.page.bringToFront();
  await operator.page.mouse.click(600, 350);
  const beforeFlight = await operator.page.evaluate(() => { const v = window.__DRIFT__.view(); return { pilotId: v.pilotId, fuel: v.self.predictionState.fuelKg, position: v.self.ship.position }; });
  await operator.page.keyboard.down('KeyW');
  await operator.page.waitForFunction(fuel => window.__DRIFT__.view().self.predictionState.fuelKg < fuel - 0.01, beforeFlight.fuel);
  await operator.page.keyboard.up('KeyW');
  await guest.page.waitForFunction(before => { const ship = window.__DRIFT__.view().ships.find(s => s.pilotId === before.pilotId); return ship && Math.hypot(ship.position.x - before.position.x, ship.position.y - before.position.y) > 0.1; }, beforeFlight);
  results.steps.push('Keyboard thrust consumed fuel and moved the same ship on the guest');

  const crews = {};
  for (const side of [operator, guest]) {
    // The HUD flushes at 10 Hz, so the first frames after a phase change may not have painted yet.
    crews[side.label] = await awaitCrew(side.page);
    await side.page.screenshot({ path: `artifacts/lan-${side.label}.png` });
  }
  results.crews = crews;
  for (const [label, text] of Object.entries(crews)) {
    assert.equal(text !== null, true, `${label}: no crew readout appeared`);
    assert.equal(/\b2\b/.test(text), true, `${label}: crew did not report two pilots (${text})`);
  }

  assert.deepEqual(operator.errors, [], `operator console: ${operator.errors.join(' | ')}`);
  assert.deepEqual(guest.errors, [], `guest console: ${guest.errors.join(' | ')}`);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.message : String(error);
  results.errors.push(results.failure);
  await failureReport();
} finally {
  if (browser) await browser.close();
  hostProcess?.kill();
  writeFileSync('artifacts/lan-results.json', JSON.stringify(results, null, 2));
}

if (!results.passed) {
  console.error(`LAN check failed: ${results.failure}`);
  console.error(JSON.stringify({ crewDebug: results.crewDebug, operatorBlockers: results.operatorBlockers, guestBlockers: results.guestBlockers }, null, 1));
  process.exit(1);
}
console.log(`LAN check passed: operator + guest in one live match (epoch ${results.epochs.operator}), crew ${JSON.stringify(results.crews)}.`);
