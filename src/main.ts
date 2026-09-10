import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow/latin-700.css';
import '@fontsource/barlow-condensed/latin-400.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import './style.css';
import { icon } from './icons';
import { SpaceScene } from './scene';
import { FlightAudio } from './audio';
import { canDock, canRecover, clamp, createCargo, createObstacles, createShip, distance, heading, length, resolveCollision, SHIPS, STATION, stepShip } from './physics';
import type { ShipClass, Vec2 } from './physics';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const shipDrawing = `<svg class="ship-drawing" viewBox="0 0 180 210" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1"><path d="m81 22-13 28v78l-10 28 8 25h15v-19h18v19h15l8-25-10-28V50L99 22Z"/><path d="M81 22h18v30H81zm-13 32h44M76 61h28v68H76zm6 8h16v20H82zm-6 26h28m-28 8h28m-28 8h28m-22 18v29m16-29v29M64 82H52v57h12m52-57h12v57h-12M52 98h12m-12 24h12m52-24h12m-12 24h12M70 146h9v26H66zm31 0h9l4 26h-13z"/><path d="M44 56v-9h9m74 0h9v9M44 157v9h9m74 0h9v-9" opacity=".5"/><path d="M87 7h6v14M40 104H16m124 0h24M90 184v16" stroke-dasharray="2 3"/></g><g fill="currentColor"><circle cx="52" cy="87" r="2"/><circle cx="128" cy="87" r="2"/><rect x="82" y="57" width="16" height="3" opacity=".7"/></g></svg>`;

$('#app').innerHTML = `
  <div class="game-shell" inert>
    <header class="topbar">
      <a class="brand" href="./" aria-label="DRIFT home"><svg class="brand-mark" viewBox="0 0 38 40" fill="none" aria-hidden="true"><path d="M5 32 18 4l7 17-9-5-4 16Z" fill="currentColor"/><path d="m21 32 8-18 7 18Z" fill="currentColor"/></svg><span>DRIFT</span><i></i><small>Belt operations</small></a>
      <nav class="main-nav" aria-label="Game views"><button class="nav-button active" data-view="flight" aria-label="Flight deck">${icon('flight')}<span>Flight deck</span></button><button class="nav-button" data-view="map" aria-label="System map">${icon('map')}<span>System map</span><kbd>M</kbd></button><button class="nav-button" data-view="shipyard" aria-label="Shipyard">${icon('ship')}<span>Shipyard</span></button></nav>
      <div class="top-actions"><span class="connection"><i></i>Local simulation</span><button class="icon-button" id="sound-button" aria-label="Enable cabin audio" title="Cabin audio">${icon('mute')}</button><button class="icon-button" id="pause-button" aria-label="Pause simulation" title="Pause · Space">${icon('pause')}</button><button class="icon-button" id="help-button" aria-label="Open flight manual" title="Flight manual · H">${icon('help')}</button></div>
    </header>

    <main class="flight-deck" aria-label="Flight deck">
      <div id="space-canvas"></div>
      <div class="viewport-shade"></div>
      <div class="sector-label"><span class="sector-coordinates">Sol system <span>/</span> 28.4 AU</span><h1>The outer belt<span>.</span></h1><p>Nereid sector <span class="tiny-cross">+</span> Unregulated space</p></div>
      <div class="view-status"><span class="status-pip"></span><span id="view-label">Flight in progress</span><span class="view-divider"></span><span id="session-time">T+ 00:00</span></div>

      <aside class="mission-panel" aria-label="Mission and nearby contacts">
        <div class="mission-title-row"><span class="section-label">Active contract</span><span class="contract-id">SR–084</span></div>
        <h2>Ghosts in the belt</h2><p class="mission-copy">A survey crew never made it home.<br>Bring back what they left behind.</p>
        <div class="mission-progress"><div><span>Recover flight archives</span><strong id="cargo-count">0 <span>/ 3</span></strong></div><div class="progress-track"><span id="mission-bar"></span></div></div>
        <div class="objective"><span class="objective-node current" id="recover-node"></span><div><strong>Recover the three archives</strong><small>Approach within 75 m at less than 12 m/s.</small></div></div>
        <div class="objective"><span class="objective-node" id="dock-node"></span><div><strong>Return to Wayfarer</strong><small>Dock at less than 8 m/s.</small></div></div>
        <button class="contract-action" id="objective-button">${icon('target')}<span>Track nearest archive</span>${icon('chevron')}</button>
        <div class="contacts-heading"><span class="section-label">Local contacts</span><span id="contact-count">04</span></div>
        <div id="contact-list"></div>
        <div class="contract-reward"><span>Contract value</span><strong>12,400 <small>cr</small></strong></div>
      </aside>

      <aside class="vessel-panel" aria-label="Vessel status">
        <div class="vessel-title"><span class="status-pip"></span><span>Your vessel</span><button id="change-ship" class="text-icon-button" aria-label="Change ship">${icon('chevron')}</button></div>
        <h2 id="ship-name">Kestrel</h2><p id="ship-role">Independent corvette</p>
        <div class="vessel-schematic">${shipDrawing}<span class="schematic-tag">KSTR–04</span><span class="schematic-scale">42 m</span></div>
        <div class="system-readout"><div>${icon('shield')}<span>Hull integrity</span><strong id="hull-value">100<small>%</small></strong></div><div class="meter"><span id="hull-bar"></span></div></div>
        <div class="system-readout"><div>${icon('fuel')}<span>Propellant</span><strong id="fuel-value">100<small>%</small></strong></div><div class="meter fuel-meter"><span id="fuel-bar"></span></div></div>
        <div class="system-readout"><div>${icon('bolt')}<span>Drive heat</span><strong id="heat-value">0<small>%</small></strong></div><div class="meter heat-meter"><span id="heat-bar"></span></div></div>
        <div class="ship-status"><span>Reactor</span><span><i></i>Nominal</span></div>
        <div class="ship-status"><span>Flight assist</span><span id="assist-status">Attitude hold</span></div>
        <div class="mass-readout"><span>Wet mass</span><strong id="mass-value">98.0 <small>t</small></strong></div>
      </aside>

      <div id="world-labels" aria-label="Navigation targets"></div>
      <div class="ship-label" id="player-label"><span class="label-rule"></span><div><strong id="player-name">Kestrel</strong><small id="player-mode">Coasting</small></div></div>
      <div class="map-legend" hidden><h2>Local system</h2><p>Nereid recovery zone</p><span><i class="legend-ship"></i>Your vessel</span><span><i class="legend-cargo"></i>Recoverable archive</span><span><i class="legend-station"></i>Wayfarer station</span><small>Choose a contact to set your navigation target.</small></div>
      <div class="navigation-info"><span class="bearing-line"></span><span id="target-summary">Flight recorder</span><strong id="target-range">291 m</strong><span id="target-speed">Target selected</span></div>
      <div class="viewport-tools"><button class="icon-button" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><span id="zoom-value">1.0×</span><button class="icon-button" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><span class="tool-separator"></span><button class="icon-button" id="camera-button" aria-label="Toggle cinematic view" title="Cinematic view · V">${icon('eye')}</button></div>
      <div class="action-prompt" id="action-prompt"><span class="prompt-dot"></span><span id="flight-tip">In space, letting go doesn’t slow you down.</span><button id="interact-button">Recover <kbd>R</kbd></button></div>
      <div class="touch-controls" aria-label="Touch flight controls"><div class="touch-steering"><button data-key="KeyA" aria-label="Rotate left">↶</button><button data-key="KeyD" aria-label="Rotate right">↷</button></div><div class="touch-drive"><button data-key="KeyX" aria-label="Brake">Brake</button><button data-key="KeyW" class="touch-burn" aria-label="Main thrust">${icon('flight')} Burn</button></div></div>
      <div class="paused-indicator" hidden><span>Simulation paused</span><button id="resume-button">Resume flight ${icon('play')}</button></div>
      <div id="toast" role="status" aria-live="polite"></div>
      <div class="loading-state" id="loading-state"><span class="brand-loading">DRIFT</span><p>Bringing flight systems online…</p></div>
    </main>

    <footer class="instrument-deck">
      <div class="instruments-main">
        <div class="velocity-instrument"><div class="instrument-heading"><span>Relative velocity</span><span id="motion-state">At rest</span></div><div class="velocity-number"><strong id="velocity-value">0.0</strong><span>m/s</span><svg viewBox="0 0 60 25" class="velocity-spark" aria-hidden="true"><path d="M0 21h8l4-8 6 8 6-17 7 17 5-10 6 10h18"/></svg></div><div class="velocity-scale"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><span id="velocity-fill"></span></div></div>
        <div class="heading-instrument"><div class="compass"><div class="compass-ticks"></div><span class="compass-n">N</span><span class="compass-e">E</span><span class="compass-s">S</span><span class="compass-w">W</span><div class="compass-needle" id="compass-needle">${icon('flight')}</div></div><div><span class="instrument-heading">Heading</span><strong class="heading-value" id="heading-value">036<small>°</small></strong><span class="turn-rate" id="turn-rate">0.0 °/s</span></div></div>
        <div class="drive-instrument"><div class="instrument-heading"><span>Main drive</span><strong id="drive-state">Standby</strong></div><div class="drive-readout"><strong id="accel-value">0.00 <small>g</small></strong><span>Burn limiter <b id="limiter-value">100%</b></span></div><input id="throttle" type="range" min="10" max="100" value="100" aria-label="Main engine thrust limit"/><div class="range-labels"><span>0</span><span>50</span><span>100%</span></div></div>
        <div class="flight-buttons"><button id="assist-button" class="assist-button active" aria-pressed="true">${icon('target')}<span>Flight assist <strong>On</strong></span><kbd>F</kbd></button><button id="brake-button" class="brake-button" aria-pressed="false">${icon('reset')}<span>Kill velocity</span><kbd>X</kbd></button></div>
      </div>
      <div class="controls-bar"><div class="keyboard-guide"><span><kbd>W</kbd><kbd>S</kbd> Thrust</span><span><kbd>A</kbd><kbd>D</kbd> Rotate</span><span><kbd>Q</kbd><kbd>E</kbd> Strafe</span><span><kbd>Shift</kbd> Hard burn</span><span><kbd>R</kbd> Interact</span></div><span class="physics-note"><i></i>Newtonian flight <span>/</span> No speed limit</span><button id="controls-help">Flight manual ${icon('help')}</button></div>
    </footer>
  </div>
  <dialog id="game-dialog" aria-labelledby="dialog-title"><div class="dialog-inner"><button class="dialog-close icon-button" aria-label="Close dialog">${icon('cross')}</button><div id="dialog-content"></div></div></dialog>
`;

let state = createShip();
let cargos = createCargo();
const obstacles = createObstacles();
let scene: SpaceScene;
const sound = new FlightAudio();
const keys = new Set<string>();
let paused = false;
let modalOpen = false;
let targetId = 'cargo-1';
let brakeLatched = false;
let elapsed = 0;
let recoveredCount = 0;
let missionComplete = false;
let crashed = false;
let burnLimit = 1;
let accumulator = 0;
let lastFrame = performance.now();
let lastHUD = 0;
let toastTimeout = 0;
let lastCollisionNotice = -10;
let hiddenPaused = false;
let previewImages: Record<ShipClass, string> | undefined;
const dialog = $<HTMLDialogElement>('#game-dialog');
const markers = new Map<string, HTMLButtonElement>();

function toast(message: string) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}

function formatDistance(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`; }
function getTarget(): Vec2 | undefined { return targetId === 'station' ? STATION : cargos.find(c => c.id === targetId && !c.collected)?.position; }
function targetName() { return targetId === 'station' ? 'Wayfarer station' : cargos.find(c => c.id === targetId)?.name || 'No target'; }

function updateContacts() {
  const contacts = [...cargos.filter(c => !c.collected).map(c => ({ id: c.id, name: c.name, icon: 'box', position: c.position })), { id: 'station', name: 'Wayfarer station', icon: 'station', position: STATION }];
  $('#contact-count').textContent = String(contacts.length).padStart(2, '0');
  $('#contact-list').innerHTML = contacts.map(c => `<button class="contact ${c.id === targetId ? 'selected' : ''}" data-target="${c.id}">${icon(c.icon)}<span>${c.name}</span><small data-range="${c.id}">${formatDistance(distance(state.position, c.position))}</small></button>`).join('');
  $('#contact-list').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.addEventListener('click', () => selectTarget(button.dataset.target!)));
  const labels = $('#world-labels'); labels.innerHTML = ''; markers.clear();
  for (const contact of contacts) {
    const marker = document.createElement('button'); marker.className = `world-marker ${contact.id === targetId ? 'selected' : ''} ${contact.id === 'station' ? 'station-marker' : ''}`;
    marker.innerHTML = `<span class="marker-shape">${icon(contact.icon)}</span><span class="marker-copy"><strong>${contact.name}</strong><small></small></span>`;
    marker.setAttribute('aria-label', `Track ${contact.name}`);
    marker.addEventListener('click', () => selectTarget(contact.id)); labels.appendChild(marker); markers.set(contact.id, marker);
  }
}

function selectTarget(id: string) { targetId = id; updateContacts(); sound.ping(); }
function trackNearest() {
  const remaining = cargos.filter(c => !c.collected).sort((a, b) => distance(state.position, a.position) - distance(state.position, b.position));
  selectTarget(remaining[0]?.id || 'station');
  toast(`Navigation set to ${targetName()}. Burn toward the marker, then hold X to brake.`);
}

function setPaused(value: boolean) {
  paused = value; keys.clear();
  $<HTMLElement>('.paused-indicator').hidden = !paused || modalOpen;
  $('#pause-button').innerHTML = icon(paused ? 'play' : 'pause');
  $('#pause-button').setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
  $('#view-label').textContent = paused ? 'Simulation paused' : scene.tactical ? 'Tactical navigation' : 'Flight in progress';
  $('.view-status').classList.toggle('is-paused', paused);
}

function setView(map: boolean) {
  scene.setTactical(map);
  $('.game-shell').classList.toggle('map-view', map);
  $<HTMLElement>('.map-legend').hidden = !map;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', (el as HTMLElement).dataset.view === (map ? 'map' : 'flight')));
  $('#view-label').textContent = paused ? 'Simulation paused' : map ? 'Tactical navigation' : 'Flight in progress';
}

function setCinematic() {
  scene.cinematic = !scene.cinematic;
  $('.game-shell').classList.toggle('cinematic', scene.cinematic);
  $('#camera-button').classList.toggle('active', scene.cinematic);
  toast(scene.cinematic ? 'Cinematic view. Press V to restore instruments.' : 'Flight instruments restored.');
}

function openDialog(content: string, wide = false) {
  keys.clear(); modalOpen = true;
  $('#dialog-content').innerHTML = content;
  dialog.classList.toggle('wide-dialog', wide);
  $('.paused-indicator').hidden = true;
  dialog.showModal();
}
function closeDialog() { dialog.close(); }
dialog.addEventListener('close', () => { modalOpen = false; keys.clear(); $('.paused-indicator').hidden = !paused; lastFrame = performance.now(); });
$('.dialog-close').addEventListener('click', closeDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });

function showHelp() {
  openDialog(`<span class="dialog-kicker">Kestrel flight school</span><h2 id="dialog-title">Space doesn’t have brakes.</h2><p class="dialog-description">Your engines change your velocity. Your thrusters change your heading. Learn to use them independently, and the belt is yours.</p><div class="manual-feature"><span class="manual-orbit">${icon('flight')}</span><div><strong>Burn. Coast. Counterburn.</strong><p>Point at your target and hold W to accelerate. Release W to coast. Hold X to fire braking thrusters before you arrive. Rotating alone won’t change where you’re going.</p></div></div><div class="manual-grid"><div><kbd>W</kbd><kbd>S</kbd><span>Main / reverse thrust</span></div><div><kbd>A</kbd><kbd>D</kbd><span>Rotate left / right</span></div><div><kbd>Q</kbd><kbd>E</kbd><span>Translate left / right</span></div><div><kbd>Shift</kbd><span>Hard burn (hold with W)</span></div><div><kbd>X</kbd><span>Hold to brake</span></div><div><kbd>F</kbd><span>Toggle attitude assist</span></div><div><kbd>R</kbd><span>Recover cargo / dock</span></div><div><kbd>Space</kbd><span>Pause simulation</span></div><div><kbd>M</kbd><span>Local system map</span></div><div><kbd>V</kbd><span>Cinematic view</span></div></div><div class="manual-mission"><strong>Your first contract</strong><p>Find the three amber archive markers. Get within 75 m, slow below 12 m/s, and press R to recover. Bring all three to Wayfarer station and dock within 115 m at less than 8 m/s. Collisions damage your hull.</p></div><button class="primary-button" id="manual-close">Take the controls ${icon('flight')}</button>`);
  $('#manual-close').addEventListener('click', closeDialog);
}

async function showShipyard() {
  openDialog(`<span class="dialog-kicker">Independent fleet</span><h2 id="dialog-title">Find your kind of trouble.</h2><p class="dialog-description">Three ships. Three ways through the belt. Switching vessels starts a fresh sortie.</p><div class="shipyard-grid">${(Object.keys(SHIPS) as ShipClass[]).map(type => {
    const ship = SHIPS[type];
    return `<article class="ship-card ${state.shipClass === type ? 'current-ship' : ''}"><div class="ship-card-top"><span>${type === 'kestrel' ? 'All-rounder' : type === 'mule' ? 'Endurance' : 'Agility'}</span>${state.shipClass === type ? '<span class="current-tag">Current vessel</span>' : ''}</div><div class="ship-preview" data-preview="${type}"></div><h3>${ship.name}</h3><p>${ship.role}</p><dl><div><dt>Dry mass</dt><dd>${ship.mass / 1000} t</dd></div><div><dt>Max acceleration</dt><dd>${(ship.thrust / (ship.mass + ship.fuel) / 9.81).toFixed(2)} g</dd></div><div><dt>Propellant</dt><dd>${ship.fuel / 1000} t</dd></div></dl><button class="${state.shipClass === type ? 'secondary-button' : 'primary-button'}" data-ship="${type}">${state.shipClass === type ? 'Restart with Kestrel'.replace('Kestrel', ship.name) : `Command ${ship.name}`}${icon('arrow')}</button></article>`;
  }).join('')}</div>`, true);
  document.querySelectorAll<HTMLButtonElement>('[data-ship]').forEach(button => button.addEventListener('click', () => { resetSortie(button.dataset.ship as ShipClass); closeDialog(); toast(`${SHIPS[state.shipClass].name} is ready. Your new sortie has begun.`); }));
  if (!previewImages) {
    const { shipPreviews } = await import('./previews');
    previewImages = shipPreviews();
  }
  if (!dialog.open || !$('.shipyard-grid')) return;
  for (const type of Object.keys(SHIPS) as ShipClass[]) {
    const holder = document.querySelector(`[data-preview="${type}"]`);
    if (holder) holder.innerHTML = `<img src="${previewImages[type]}" alt="${SHIPS[type].name} spacecraft"/>`;
  }
}

function resetSortie(shipClass: ShipClass = state.shipClass) {
  state = createShip(shipClass); cargos = createCargo();
  scene.changeShip(shipClass); targetId = 'cargo-1'; elapsed = 0; recoveredCount = 0; missionComplete = false; crashed = false; brakeLatched = false; accumulator = 0; burnLimit = 1; lastCollisionNotice = -10;
  $<HTMLInputElement>('#throttle').value = '100'; $('#limiter-value').textContent = '100%';
  setPaused(false); updateContacts(); updateMission(); updateAssist();
  $('#ship-name').textContent = SHIPS[shipClass].name; $('#player-name').textContent = SHIPS[shipClass].name; $('#ship-role').textContent = SHIPS[shipClass].role;
  $('.schematic-tag').textContent = shipClass === 'kestrel' ? 'KSTR–04' : shipClass === 'mule' ? 'MULE–09' : 'NDLE–02';
  $('.schematic-scale').textContent = `${SHIPS[shipClass].length} m`;
  $('.vessel-schematic').setAttribute('data-class', shipClass);
}

function updateMission() {
  $('#cargo-count').innerHTML = `${recoveredCount} <span>/ 3</span>`;
  $('#mission-bar').style.width = `${recoveredCount / 3 * 100}%`;
  $('#recover-node').classList.toggle('complete', recoveredCount === 3);
  $('#recover-node').classList.toggle('current', recoveredCount < 3);
  $('#dock-node').classList.toggle('current', recoveredCount === 3 && !missionComplete);
  $('#dock-node').classList.toggle('complete', missionComplete);
  $('#objective-button span').textContent = recoveredCount === 3 ? 'Track Wayfarer station' : 'Track nearest archive';
}

function interact() {
  if (paused || modalOpen || crashed) return;
  const recoverable = cargos.filter(c => canRecover(state, c)).sort((a, b) => distance(state.position, a.position) - distance(state.position, b.position))[0];
  if (recoverable) {
    recoverable.collected = true; recoveredCount++;
    sound.ping(); toast(`${recoverable.name} secured. ${recoveredCount === 3 ? 'All archives aboard. Return to Wayfarer.' : `${3 - recoveredCount} archives remaining.`}`);
    if (targetId === recoverable.id) {
      const next = cargos.filter(c => !c.collected).sort((a, b) => distance(state.position, a.position) - distance(state.position, b.position))[0];
      targetId = next?.id || 'station';
    }
    updateContacts(); updateMission(); return;
  }
  if (canDock(state)) {
    state.velocity = { x: 0, y: 0 }; state.angularVelocity = 0;
    state.fuel = SHIPS[state.shipClass].fuel; state.hull = SHIPS[state.shipClass].hull; state.heat = 0;
    sound.ping();
    if (recoveredCount === 3 && !missionComplete) {
      missionComplete = true; updateMission();
      const minutes = Math.floor(elapsed / 60), seconds = Math.floor(elapsed % 60);
      let best = elapsed;
      try { const saved = Number(localStorage.getItem('drift-best-time')); if (saved > 0) best = Math.min(saved, elapsed); localStorage.setItem('drift-best-time', String(best)); } catch { /* Storage is optional. */ }
      openDialog(`<span class="dialog-kicker">Contract SR–084 complete</span><div class="success-icon">${icon('check')}</div><h2 id="dialog-title">You brought them home.</h2><p class="dialog-description">Three archives recovered. A little more of the crew’s story survives. Wayfarer has transferred your payment.</p><div class="debrief-stats"><div><span>Payment received</span><strong>12,400 <small>cr</small></strong></div><div><span>Flight time</span><strong>${minutes}:${String(seconds).padStart(2, '0')}</strong></div><div><span>Best time</span><strong>${Math.floor(best / 60)}:${String(Math.floor(best % 60)).padStart(2, '0')}</strong></div></div><button class="primary-button" id="next-sortie">Fly another sortie ${icon('flight')}</button>`);
      $('#next-sortie').addEventListener('click', () => { resetSortie(); closeDialog(); });
    } else toast('Docked at Wayfarer. Hull repaired and propellant replenished.');
    return;
  }
  const nearest = cargos.filter(c => !c.collected).sort((a, b) => distance(state.position, a.position) - distance(state.position, b.position))[0];
  if (nearest && distance(state.position, nearest.position) < 75) toast('Approach too fast. Hold X to slow below 12 m/s.');
  else if (distance(state.position, STATION) < 115) toast('Docking speed is too high. Hold X to slow below 8 m/s.');
  else toast('Get closer to an archive or Wayfarer station to interact.');
}

function updateAssist() {
  $('#assist-button').classList.toggle('active', state.assist); $('#assist-button').setAttribute('aria-pressed', String(state.assist));
  $('#assist-button strong').textContent = state.assist ? 'On' : 'Off'; $('#assist-status').textContent = state.assist ? 'Attitude hold' : 'Manual rotation';
}
function toggleAssist() { state.assist = !state.assist; updateAssist(); toast(state.assist ? 'Attitude assist on. Thrusters stop rotation when released.' : 'Attitude assist off. Angular momentum is conserved.'); }

function updateHUD(now: number) {
  const speed = length(state.velocity);
  const spec = SHIPS[state.shipClass];
  const hull = state.hull / spec.hull * 100, fuel = state.fuel / spec.fuel * 100, heat = state.heat * 100;
  $('#velocity-value').textContent = speed.toFixed(1); $('#motion-state').textContent = speed < 0.1 ? 'At rest' : state.acceleration > 0.1 ? 'Under thrust' : 'Coasting';
  $('#velocity-fill').style.width = `${Math.min(100, speed / 200 * 100)}%`;
  $('#heading-value').innerHTML = `${String(Math.round(heading(state.angle)) % 360).padStart(3, '0')}<small>°</small>`;
  $('#compass-needle').style.transform = `translate(-50%, -50%) rotate(${heading(state.angle)}deg)`;
  $('#turn-rate').textContent = `${(-state.angularVelocity * 180 / Math.PI).toFixed(1)} °/s`;
  $('#accel-value').innerHTML = `${(state.acceleration / 9.81).toFixed(2)} <small>g</small>`;
  $('#drive-state').textContent = state.thrustLevel > 1 ? 'Hard burn' : state.thrustLevel > 0 ? 'Burning' : state.rcsActive || state.thrustLevel < 0 ? 'RCS active' : 'Standby';
  $('.drive-instrument').classList.toggle('burning', Math.abs(state.thrustLevel) > 0);
  $('#hull-value').innerHTML = `${Math.ceil(hull)}<small>%</small>`; $('#hull-bar').style.width = `${hull}%`;
  $('#hull-bar').classList.toggle('danger', hull < 30);
  $('#fuel-value').innerHTML = `${fuel.toFixed(0)}<small>%</small>`; $('#fuel-bar').style.width = `${fuel}%`;
  $('#heat-value').innerHTML = `${heat.toFixed(0)}<small>%</small>`; $('#heat-bar').style.width = `${heat}%`;
  $('#mass-value').innerHTML = `${((spec.mass + state.fuel) / 1000).toFixed(1)} <small>t</small>`;
  $('#session-time').textContent = `T+ ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
  $('#player-mode').textContent = speed < 0.1 ? 'Holding position' : state.thrustLevel > 0 ? 'Main drive active' : state.rcsActive ? 'Maneuvering' : 'Ballistic coast';
  const target = getTarget();
  $('#target-summary').textContent = targetName();
  $('#target-range').textContent = target ? formatDistance(distance(state.position, target)) : '—';
  const maxBrake = spec.thrust / (spec.mass + state.fuel) * 0.65;
  const stoppingDistance = speed * speed / (2 * maxBrake);
  const tooFast = !!target && stoppingDistance > distance(state.position, target) - 40 && speed > 12;
  $('#target-speed').textContent = tooFast ? 'Brake for approach' : speed > 0.5 ? `Stopping distance ${formatDistance(stoppingDistance)}` : 'Target selected';
  $('.navigation-info').classList.toggle('approach-warning', tooFast);
  for (const cargo of cargos) { const el = document.querySelector(`[data-range="${cargo.id}"]`); if (el) el.textContent = formatDistance(distance(state.position, cargo.position)); }
  $('[data-range="station"]').textContent = formatDistance(distance(state.position, STATION));
  const recoverable = cargos.some(c => canRecover(state, c));
  const dockable = canDock(state);
  const interactButton = $<HTMLButtonElement>('#interact-button');
  interactButton.hidden = !(recoverable || dockable);
  interactButton.innerHTML = `${recoverable ? 'Recover archive' : 'Dock at Wayfarer'} <kbd>R</kbd>`;
  $('#flight-tip').textContent = state.fuel <= 0 ? 'Propellant exhausted. Open the flight manual to restart your sortie.' : tooFast ? 'Start your counterburn. Hold X to reduce velocity.' : recoverable ? 'Archive within reach. Ready for recovery.' : dockable ? 'Docking corridor clear. Welcome to Wayfarer.' : speed < 0.5 ? 'In space, letting go doesn’t slow you down.' : 'Your velocity vector shows where you’re actually going.';
  if (brakeLatched && speed < 0.04) brakeLatched = false;
  $('#brake-button').classList.toggle('active', brakeLatched || keys.has('KeyX'));
  $('#brake-button').setAttribute('aria-pressed', String(brakeLatched));
  lastHUD = now;
}

function updateLabels() {
  const bounds = $('#space-canvas').getBoundingClientRect();
  const mobile = bounds.width <= 700;
  for (const [id, marker] of markers) {
    const pos = id === 'station' ? STATION : cargos.find(c => c.id === id)!.position;
    const point = scene.project(pos, 12);
    let x = point.x, y = point.y;
    const left = mobile ? 32 : 290, right = bounds.width - (mobile ? 142 : 310);
    const top = mobile ? 247 : 112, bottom = bounds.height - (mobile ? 175 : 132);
    const offscreen = id === targetId && (x < left || x > right || y < top || y > bottom);
    if (offscreen) { x = clamp(x, left, Math.max(left, right)); y = clamp(y, Math.min(top, bottom), bottom); }
    marker.style.transform = `translate(${x}px, ${y}px)`;
    marker.hidden = (!point.visible && id !== targetId) || scene.cinematic;
    marker.classList.toggle('offscreen', offscreen);
    const shape = marker.querySelector<HTMLElement>('.marker-shape')!;
    if (offscreen) {
      if (shape.dataset.offscreen !== 'true') shape.innerHTML = icon('arrow');
      shape.style.setProperty('--bearing', `${Math.atan2(point.y - bounds.height / 2, point.x - bounds.width / 2)}rad`);
    } else if (shape.dataset.offscreen === 'true') shape.innerHTML = icon(id === 'station' ? 'station' : 'box');
    shape.dataset.offscreen = String(offscreen);
    marker.querySelector('small')!.textContent = `${formatDistance(distance(state.position, pos))}${offscreen ? ' / Beyond view' : id === 'station' ? ' / Anchorage' : ' / Salvage'}`;
  }
  const point = scene.project(state.position, 0);
  $('#player-label').style.transform = `translate(${point.x + (scene.tactical ? 22 : 57)}px, ${point.y + (scene.tactical ? 13 : 41)}px)`;
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const delta = Math.min((now - lastFrame) / 1000, 0.25); lastFrame = now;
  const stopped = paused || modalOpen || hiddenPaused || crashed;
  if (!stopped) {
    accumulator += delta;
    const input = {
      thrust: (keys.has('KeyW') || keys.has('ArrowUp') ? burnLimit : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 0.28 : 0),
      turn: (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0),
      strafe: (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0),
      brake: keys.has('KeyX') || brakeLatched, boost: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    };
    while (accumulator >= 1 / 120) {
      stepShip(state, input, 1 / 120); elapsed += 1 / 120;
      for (const rock of obstacles) {
        const damage = resolveCollision(state, rock);
        if (damage > 2 && elapsed - lastCollisionNotice > 2) { toast(`Impact detected. Hull integrity ${Math.ceil(state.hull / SHIPS[state.shipClass].hull * 100)}%.`); lastCollisionNotice = elapsed; }
      }
      accumulator -= 1 / 120;
    }
    if (state.hull <= 0 || state.fuel <= 0) {
      crashed = true; keys.clear();
      openDialog(`<span class="dialog-kicker">Flight terminated</span><h2 id="dialog-title">${state.hull <= 0 ? 'The belt leaves a mark.' : 'Running on empty.'}</h2><p class="dialog-description">${state.hull <= 0 ? 'Your hull could not survive the impact. Keep an eye on your stopping distance and begin braking well before the next obstacle.' : 'Your propellant is exhausted. Coast between burns and visit Wayfarer to refuel on your next flight.'}</p><button class="primary-button" id="restart-button">Launch a new sortie ${icon('reset')}</button>`);
      $('#restart-button').addEventListener('click', () => { resetSortie(); closeDialog(); });
    }
  } else accumulator = 0;
  scene.render(state, cargos, getTarget(), stopped ? 0 : delta, elapsed);
  updateLabels();
  if (now - lastHUD > 85) updateHUD(now);
  sound.update(Math.abs(state.thrustLevel), stopped);
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => { if (button.dataset.view === 'shipyard') void showShipyard(); else setView(button.dataset.view === 'map'); }));
$('#change-ship').addEventListener('click', () => void showShipyard());
$('#objective-button').addEventListener('click', trackNearest);
$('#pause-button').addEventListener('click', () => setPaused(!paused));
$('#resume-button').addEventListener('click', () => setPaused(false));
$('#help-button').addEventListener('click', showHelp); $('#controls-help').addEventListener('click', showHelp);
$('#assist-button').addEventListener('click', toggleAssist);
$('#brake-button').addEventListener('click', () => { brakeLatched = !brakeLatched; if (brakeLatched) toast('Braking thrusters engaged. Velocity hold will stop the ship.'); });
$('#interact-button').addEventListener('click', interact);
$('#camera-button').addEventListener('click', setCinematic);
$('#sound-button').addEventListener('click', async () => {
  try { const enabled = await sound.toggle(); $('#sound-button').innerHTML = icon(enabled ? 'sound' : 'mute'); $('#sound-button').setAttribute('aria-label', enabled ? 'Mute cabin audio' : 'Enable cabin audio'); toast(enabled ? 'Cabin audio enabled.' : 'Cabin audio muted.'); } catch { toast('Audio is unavailable in this browser. Flight controls are ready.'); }
});
function changeZoom(delta: number) { scene.setZoom(delta); $('#zoom-value').textContent = `${scene.zoom.toFixed(1)}×`; }
$('#zoom-in').addEventListener('click', () => changeZoom(0.15)); $('#zoom-out').addEventListener('click', () => changeZoom(-0.15));
$('#space-canvas').addEventListener('wheel', event => { event.preventDefault(); changeZoom(event.deltaY > 0 ? -0.06 : 0.06); }, { passive: false });
$('#throttle').addEventListener('input', event => { const value = Number((event.target as HTMLInputElement).value); burnLimit = value / 100; $('#limiter-value').textContent = `${value}%`; });

const flightKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
window.addEventListener('keydown', event => {
  if (!scene || modalOpen || event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
  // Let focused controls retain their native Space/Enter activation.
  if (event.target instanceof HTMLButtonElement && (event.code === 'Space' || event.code === 'Enter')) return;
  if (flightKeys.includes(event.code) || ['Space', 'KeyF', 'KeyR', 'KeyM', 'KeyV', 'KeyH'].includes(event.code)) event.preventDefault();
  if (flightKeys.includes(event.code) && !paused) keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Space') setPaused(!paused);
  if (event.code === 'KeyF') toggleAssist();
  if (event.code === 'KeyR') interact();
  if (event.code === 'KeyM') setView(!scene.tactical);
  if (event.code === 'KeyV') setCinematic();
  if (event.code === 'KeyH') showHelp();
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { hiddenPaused = document.hidden; keys.clear(); lastFrame = performance.now(); });
document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', event => { event.preventDefault(); if (paused || modalOpen || crashed) return; button.setPointerCapture(event.pointerId); keys.add(button.dataset.key!); button.classList.add('pressed'); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { keys.delete(button.dataset.key!); button.classList.remove('pressed'); });
});

async function boot() {
  try {
    await document.fonts.ready;
    scene = new SpaceScene($('#space-canvas'), obstacles, cargos);
    updateContacts(); updateHUD(0);
    $('.game-shell').removeAttribute('inert');
    $('#loading-state').classList.add('loaded');
    window.setTimeout(() => $('#loading-state').remove(), 600);
    lastFrame = performance.now(); requestAnimationFrame(frame);
    // A read-only snapshot supports repeatable browser diagnostics without exposing mutation hooks.
    Object.defineProperty(window, '__DRIFT__', { value: { snapshot: () => structuredClone({ state, cargos, elapsed, paused, modalOpen, recoveredCount, missionComplete, tactical: scene.tactical }) } });
  } catch (error) {
    console.error('Flight deck initialization failed:', error);
    $('.game-shell').removeAttribute('inert');
    document.querySelectorAll<HTMLButtonElement>('.game-shell button').forEach(button => { button.disabled = true; });
    $('#loading-state').innerHTML = `<span class="brand-loading">DRIFT</span><h2>The viewport couldn’t start.</h2><p>Enable hardware acceleration or use a browser with WebGL 2 support, then reload.</p><button class="primary-button" id="retry-viewport">Reload flight deck</button>`;
    $('#retry-viewport').addEventListener('click', () => location.reload());
  }
}
void boot();
