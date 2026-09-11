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
import { ShipBay } from './hangar';
import { Radar } from './radar';
import { FlightAudio } from './audio';
import { clamp, createCargo, createObstacles, createShip, distance, heading, length, resolveCollision, SHIPS, SECTOR, STATION, RELAY, stepShip } from './physics';
import type { FlightInput, ShipClass, Vec2 } from './physics';
import { CONTRACT, SCAN, completeDock, contactName, createMission, dockable, interactive, isScanned, recoverCargo, scanProgress, scanSpec, suggestTarget, updateMission } from './mission';
import type { MissionSignal } from './mission';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

$('#app').innerHTML = `
  <div class="game-shell flow-title" inert>
    <header class="topbar">
      <a class="brand" href="./" aria-label="DRIFT home"><svg class="brand-mark" viewBox="0 0 38 40" fill="none" aria-hidden="true"><path d="M5 32 18 4l7 17-9-5-4 16Z" fill="currentColor"/><path d="m21 32 8-18 7 18Z" fill="currentColor"/></svg><span>DRIFT</span></a>
      <nav class="main-nav" aria-label="Game views"><button class="nav-button active" data-view="flight" aria-label="Flight deck">${icon('flight')}<span>Flight deck</span></button><button class="nav-button" data-view="map" aria-label="System map">${icon('map')}<span>System map</span><kbd>M</kbd></button><button class="nav-button" data-view="shipyard" aria-label="Shipyard">${icon('ship')}<span>Shipyard</span></button></nav>
      <div class="top-actions"><span class="session-chip"><i></i><span id="session-time">T+ 00:00</span></span><button class="icon-button" id="sound-button" aria-label="Enable cabin audio" title="Cabin audio">${icon('mute')}</button><button class="icon-button" id="pause-button" aria-label="Pause simulation" title="Pause · Space">${icon('pause')}</button><button class="icon-button" id="help-button" aria-label="Open flight manual" title="Flight manual · H">${icon('help')}</button></div>
    </header>

    <main class="flight-deck" aria-label="Flight deck">
      <div id="space-canvas"></div>
      <div class="viewport-shade"></div>

      <aside class="mission-panel" aria-label="Active contract">
        <div class="mission-head"><span class="section-label">Contract ${CONTRACT.id}</span><span class="contract-id" id="stage-chip">Relay download</span></div>
        <h2>${CONTRACT.title}</h2>
        <div class="mission-progress"><div class="progress-track"><span id="mission-bar"></span></div><strong id="cargo-count">0 <span>/ 3</span></strong></div>
        <div class="mission-stages">
          <div class="stage-row" id="stage-relay"><span class="stage-node"></span><strong>Relay telemetry</strong><small id="stage-relay-note">Hold station inside 145 m</small></div>
          <div class="stage-row" id="stage-scan"><span class="stage-node"></span><strong>Resolve and recover archives</strong><small id="stage-scan-note">Three contacts unresolved</small></div>
          <div class="stage-row" id="stage-dock"><span class="stage-node"></span><strong>Dock at Wayfarer</strong><small>Under 8 m/s</small></div>
          <div class="stage-row optional" id="stage-optional"><span class="stage-node"></span><strong>Kite’s End black box</strong><small>Bonus salvage</small></div>
        </div>
        <button class="contract-action" id="objective-button">${icon('target')}<span>Track nearest contact</span></button>
      </aside>

      <div class="right-rail">
      <aside class="vessel-panel" aria-label="Vessel status">
        <div class="vessel-title"><h2 id="ship-name">Kestrel</h2><button id="change-ship" class="text-icon-button" aria-label="Change ship" title="Change ship">${icon('chevron')}</button></div>
        <p id="ship-role">Independent corvette</p>
        <div class="readout"><span>Hull</span><div class="meter"><span id="hull-bar"></span></div><strong id="hull-value">100<small>%</small></strong></div>
        <div class="readout"><span>Propellant</span><div class="meter fuel-meter"><span id="fuel-bar"></span></div><strong id="fuel-value">100<small>%</small></strong></div>
        <div class="readout"><span>Drive heat</span><div class="meter heat-meter"><span id="heat-bar"></span></div><strong id="heat-value">0<small>%</small></strong></div>
        <div class="vessel-foot"><span id="assist-status">Attitude hold</span><span id="mass-value">98.0 t</span></div>
      </aside>

      <div class="nav-console">
        <div class="radar-plate"><canvas id="radar-canvas" aria-label="Sector radar"></canvas></div>
        <div class="navigation-info"><span id="target-summary">Nereid relay</span><strong id="target-range">824 m</strong><small id="target-speed">Target selected</small></div>
        <div class="viewport-tools"><button class="icon-button" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><span id="zoom-value">1.40×</span><button class="icon-button" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><button class="icon-button" id="zoom-reset" aria-label="Reset zoom" title="Reset zoom">${icon('expand')}</button><span class="tool-separator"></span><button class="icon-button" id="camera-button" aria-label="Toggle cinematic view" title="Cinematic view · V">${icon('eye')}</button></div>
      </div>
      </div>

      <div id="world-labels" aria-label="Navigation targets"></div>
      <div class="ship-label" id="player-label"><span class="label-rule"></span><div><strong id="player-name">Kestrel</strong><small id="player-mode">Coasting</small></div></div>
      <div class="map-legend" hidden><h2>Nereid recovery zone</h2><p>5.2 × 4.2 km · grid 500 m</p><span>${icon('flight')}Your vessel</span><span>${icon('beacon')}Relay beacon</span><span>${icon('box')}Salvage archive</span><span>${icon('derelict')}Derelict wreck</span><span>${icon('station')}Wayfarer station</span><small>Choose a contact to set your navigation target.</small></div>
      <div class="action-prompt" id="action-prompt" hidden><span id="flight-tip"></span><button id="interact-button">Recover <kbd>R</kbd></button></div>
      <div class="touch-controls" aria-label="Touch flight controls"><div class="touch-steering"><button data-key="KeyA" aria-label="Rotate left">↶</button><button data-key="KeyD" aria-label="Rotate right">↷</button></div><div class="touch-drive"><button data-key="KeyX" aria-label="Brake">Brake</button><button data-key="KeyW" class="touch-burn" aria-label="Main thrust">${icon('flight')} Burn</button></div></div>
      <div class="paused-indicator" hidden><span>Simulation paused</span><div class="pause-actions"><button id="resume-button">Resume flight ${icon('play')}</button><button id="pause-hangar">Return to hangar</button><button id="pause-manual">Flight manual</button></div></div>
      <div class="stage-banner" id="stage-banner" hidden><span id="stage-banner-kicker">Objective</span><strong id="stage-banner-text"></strong></div>
      <div class="damage-flash" id="damage-flash"></div>
      <div id="toast" role="status" aria-live="polite"></div>
      <div class="loading-state" id="loading-state"><span class="brand-loading">DRIFT</span><p>Bringing flight systems online…</p></div>
    </main>

    <footer class="instrument-deck">
      <div class="instruments-main">
        <div class="velocity-instrument"><div class="instrument-heading"><span>Velocity</span><span id="motion-state">At rest</span></div><div class="velocity-number"><strong id="velocity-value">0.0</strong><span>m/s</span></div><div class="velocity-scale"><span id="velocity-fill"></span></div></div>
        <div class="heading-instrument"><div class="compass"><div class="compass-ticks"></div><span class="compass-n">N</span><span class="compass-e">E</span><span class="compass-s">S</span><span class="compass-w">W</span><div class="compass-needle" id="compass-needle">${icon('flight')}</div></div><div><span class="instrument-heading">Heading</span><strong class="heading-value" id="heading-value">036<small>°</small></strong><span class="turn-rate" id="turn-rate">0.0 °/s</span></div></div>
        <div class="drive-instrument"><div class="instrument-heading"><span>Main drive</span><strong id="drive-state">Standby</strong></div><div class="drive-readout"><strong id="accel-value">0.00 <small>g</small></strong><span>Limiter <b id="limiter-value">100%</b></span></div><input id="throttle" type="range" min="10" max="100" value="100" aria-label="Main engine thrust limit"/></div>
        <div class="flight-buttons"><button id="assist-button" class="assist-button active" aria-pressed="true">${icon('target')}<span>Flight assist <strong>On</strong></span><kbd>F</kbd></button><button id="brake-button" class="brake-button" aria-pressed="false">${icon('reset')}<span>Kill velocity</span><kbd>X</kbd></button></div>
      </div>
      <div class="controls-bar"><div class="keyboard-guide"><span><kbd>W</kbd><kbd>S</kbd> Thrust</span><span><kbd>A</kbd><kbd>D</kbd> Rotate</span><span><kbd>Shift</kbd> Hard burn</span><span><kbd>R</kbd> Interact</span><span><kbd>M</kbd> Chart</span></div><span class="physics-note"><i></i>Newtonian flight · no speed limit</span><button id="controls-help">Flight manual ${icon('help')}</button></div>
    </footer>

    <section class="title-screen" id="title-screen" aria-label="DRIFT title">
      <div class="title-inner">
        <span class="title-kicker">Belt operations · outer ring</span>
        <h1 class="title-mark">DRIFT</h1>
        <p class="title-tag">A working corvette, three lost archives, and five kilometres of rock between them.</p>
        <div class="title-actions">
          <button class="primary-button" id="title-begin">Begin sortie</button>
          <button class="ghost-button" id="title-hangar">Hangar</button>
          <button class="ghost-button" id="title-manual">Flight manual</button>
        </div>
        <div class="title-meta"><span id="title-best">No flight recorded</span><span class="title-dot"></span><span>Build 1.0 · local simulation</span></div>
      </div>
    </section>

    <section class="hangar-screen" id="hangar-screen" hidden aria-label="Hangar bay">
      <div class="hangar-grid">
        <div class="hangar-bay">
          <div class="bay-viewport" id="hangar-viewport"></div>
          <div class="bay-strip" id="hangar-tabs"></div>
        </div>
        <div class="hangar-brief">
          <span class="dialog-kicker">Contract ${CONTRACT.id}</span>
          <h2 id="hangar-title">Ghosts in the belt</h2>
          <p class="brief-copy">A survey crew stopped transmitting in the Nereid recovery zone. Their relay still answers. Fly to it, pull the telemetry, resolve the three archive contacts it left behind and bring them back to Wayfarer station.</p>
          <div class="brief-stages">
            <div><span>1</span><p><strong>Relay download</strong> — hold station inside 145 m at under 22 m/s.</p></div>
            <div><span>2</span><p><strong>Resolve contacts</strong> — scan each archive within 130 m, then recover it inside 75 m.</p></div>
            <div><span>3</span><p><strong>Return and dock</strong> — Wayfarer accepts approach under 8 m/s.</p></div>
            <div><span>4</span><p><strong>Optional</strong> — the wreck of Kite’s End still carries its black box.</p></div>
          </div>
          <div class="brief-ship" id="hangar-ship"></div>
          <label class="callsign-field"><span>Call sign</span><input id="callsign" maxlength="14" autocomplete="off" spellcheck="false" value="Rook"/></label>
          <button class="primary-button" id="launch-sortie">Launch sortie ${icon('flight')}</button>
          <button class="ghost-button" id="hangar-back">Back to title</button>
        </div>
      </div>
    </section>

    <div class="launch-card" id="launch-card" hidden>
      <span id="launch-kicker">Contract ${CONTRACT.id}</span>
      <h2 id="launch-title">Ghosts in the belt</h2>
      <p id="launch-line">First waypoint: the Nereid relay. Hold station to pull its telemetry.</p>
      <small>Press any key to skip</small>
    </div>
  </div>
  <dialog id="game-dialog" aria-labelledby="dialog-title"><div class="dialog-inner"><button class="dialog-close icon-button" aria-label="Close dialog">${icon('cross')}</button><div id="dialog-content"></div></div></dialog>
`;

type Flow = 'title' | 'hangar' | 'launch' | 'flight';

let state = createShip();
let cargos = createCargo();
let mission = createMission();
const obstacles = createObstacles();
const planarRocks = obstacles.filter(rock => rock.z === 0);
let scene: SpaceScene;
let radar: Radar;
const sound = new FlightAudio();
const keys = new Set<string>();
let paused = false;
let modalOpen = false;
let flow: Flow = 'title';
let targetId = 'relay';
let brakeLatched = false;
let elapsed = 0;
let crashed = false;
let burnLimit = 1;
let accumulator = 0;
let lastFrame = performance.now();
let lastHUD = 0;
let lastRadar = 0;
let toastTimeout = 0;
let bannerTimeout = 0;
let lastCollisionNotice = -10;
let hiddenPaused = false;
let launchTimer = 0;
let callsign = 'Rook';
let bay: ShipBay | undefined;
let bayShip: ShipClass = 'kestrel';
const dialog = $<HTMLDialogElement>('#game-dialog');
const markers = new Map<string, HTMLButtonElement>();

type Contact = { id: string; name: string; icon: string; position: Vec2; known: boolean; note: string };

function contacts(): Contact[] {
  const revealed = mission.stage !== 'relay';
  const list: Contact[] = [
    { id: 'station', name: 'Wayfarer station', icon: 'station', position: STATION, known: true, note: 'Anchorage' },
    { id: 'relay', name: 'Nereid relay', icon: 'beacon', position: RELAY, known: true, note: revealed ? 'Telemetry pulled' : 'Awaiting download' },
  ];
  for (const cargo of cargos) {
    if (cargo.kind === 'blackbox') {
      list.push({ id: 'derelict', name: 'Kite’s End', icon: 'derelict', position: cargo.position, known: revealed, note: 'Derelict wreck' });
      continue;
    }
    list.push({ id: cargo.id, name: cargo.name, icon: 'box', position: cargo.position, known: revealed, note: isScanned(mission, cargo.id) ? 'Resolved' : 'Unresolved contact' });
  }
  return list;
}

function targetPosition(id: string): Vec2 | undefined {
  if (id === 'station') return STATION;
  if (id === 'relay') return RELAY;
  if (id === 'derelict') return cargos.find(cargo => cargo.kind === 'blackbox')?.position;
  return cargos.find(cargo => cargo.id === id)?.position;
}

function toast(message: string) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}

function banner(kicker: string, text: string) {
  $('#stage-banner-kicker').textContent = kicker;
  $('#stage-banner-text').textContent = text;
  const element = $('#stage-banner');
  element.hidden = false;
  element.classList.remove('visible');
  void element.offsetWidth;
  element.classList.add('visible');
  clearTimeout(bannerTimeout);
  bannerTimeout = window.setTimeout(() => { element.classList.remove('visible'); window.setTimeout(() => { element.hidden = true; }, 500); }, 4200);
}

function formatDistance(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`; }
function getTarget(): Vec2 | undefined { return targetPosition(targetId); }
function targetName() { return contactName(targetId, cargos); }

function updateContacts() {
  const list = contacts();
  const labels = $('#world-labels'); labels.innerHTML = ''; markers.clear();
  for (const contact of list) {
    if (!contact.known) continue;
    const marker = document.createElement('button');
    marker.className = `world-marker ${contact.id === targetId ? 'selected' : ''} ${contact.id === 'station' ? 'station-marker' : ''} ${contact.known ? '' : 'unresolved'}`;
    marker.innerHTML = `<span class="marker-shape">${icon(contact.icon)}</span><span class="marker-copy"><strong>${contact.known ? contact.name : 'Unresolved'}</strong><small></small></span><span class="scan-ring"><i></i></span>`;
    marker.setAttribute('aria-label', contact.known ? `Track ${contact.name}` : 'Unresolved contact');
    marker.addEventListener('click', () => selectTarget(contact.id));
    labels.appendChild(marker); markers.set(contact.id, marker);
  }
}

function selectTarget(id: string) { targetId = id; updateContacts(); sound.ping(); }

function trackNearest() {
  targetId = suggestTarget(mission, state, cargos);
  updateContacts();
  toast(`Navigation set to ${targetName()}. Burn toward the marker, then hold X to brake.`);
}

function setPaused(value: boolean) {
  paused = value; keys.clear();
  $<HTMLElement>('.paused-indicator').hidden = !paused || modalOpen || flow !== 'flight';
  $('#pause-button').innerHTML = icon(paused ? 'play' : 'pause');
  $('#pause-button').setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
}

function setView(map: boolean) {
  scene.setMode(map ? 'map' : 'flight');
  $('.game-shell').classList.toggle('map-view', map);
  $<HTMLElement>('.map-legend').hidden = !map;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', (el as HTMLElement).dataset.view === (map ? 'map' : 'flight')));
  updateZoomReadout();
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
dialog.addEventListener('close', () => {
  modalOpen = false; keys.clear();
  $('.paused-indicator').hidden = !paused || flow !== 'flight';
  lastFrame = performance.now();
  if (bay) { bay.dispose(); bay = undefined; }
});
$('.dialog-close').addEventListener('click', closeDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });

function statsFor(shipClass: ShipClass) {
  const ship = SHIPS[shipClass];
  const rows = [
    { label: 'Dry mass', value: `${ship.mass / 1000} t`, ratio: ship.mass / 200000 },
    { label: 'Max acceleration', value: `${(ship.thrust / (ship.mass + ship.fuel) / 9.81).toFixed(2)} g`, ratio: ship.thrust / (ship.mass + ship.fuel) / 18 },
    { label: 'Propellant', value: `${ship.fuel / 1000} t`, ratio: ship.fuel / 30000 },
    { label: 'Hull rating', value: String(ship.hull), ratio: ship.hull / 150 },
    { label: 'Attitude authority', value: `${ship.torque.toFixed(2)}`, ratio: ship.torque / 2.05 },
  ];
  return rows;
}

function shipCardHTML(shipClass: ShipClass, active: boolean) {
  const ship = SHIPS[shipClass];
  return `<button class="bay-tab ${active ? 'active' : ''}" data-ship="${shipClass}">
    <span class="bay-tab-name">${ship.name}</span><span class="bay-tab-role">${ship.role}</span></button>`;
}

function shipStatsHTML(shipClass: ShipClass) {
  const ship = SHIPS[shipClass];
  return `<div class="brief-ship-head"><h3>${ship.name}</h3><span>${ship.length} m · ${ship.role}</span></div>
    <dl>${statsFor(shipClass).map(row => `<div><dt>${row.label}</dt><dd><span class="stat-track"><i style="width:${Math.round(clamp(row.ratio, 0.05, 1) * 100)}%"></i></span>${row.value}</dd></div>`).join('')}</dl>`;
}

function hydrateBay(container: HTMLElement, shipClass: ShipClass) {
  bay?.dispose();
  bay = new ShipBay(container);
  bay.setShip(shipClass);
  bayShip = shipClass;
}

function showTitle() {
  flow = 'title';
  setFlowClass();
  bay?.dispose(); bay = undefined;
  $<HTMLElement>('#hangar-screen').hidden = true;
  $<HTMLElement>('#title-screen').hidden = false;
  scene.setMode('title');
  scene.titleFocus = window.innerWidth > 900 ? { x: -430, y: -110 } : { x: 0, y: -30 };
  scene.cinematic = false;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.remove('active'));
  const best = Number(localStorage.getItem('drift-best-time') ?? 0);
  $('#title-best').textContent = best > 0 ? `Best flight ${Math.floor(best / 60)}:${String(Math.floor(best % 60)).padStart(2, '0')}` : 'No flight recorded';
}

function showHangar() {
  flow = 'hangar';
  setFlowClass();
  $<HTMLElement>('#title-screen').hidden = true;
  $<HTMLElement>('#hangar-screen').hidden = false;
  const tabs = $('#hangar-tabs');
  tabs.innerHTML = (Object.keys(SHIPS) as ShipClass[]).map(type => shipCardHTML(type, type === bayShip)).join('');
  tabs.querySelectorAll<HTMLButtonElement>('[data-ship]').forEach(button => button.addEventListener('click', () => {
    const type = button.dataset.ship as ShipClass;
    bayShip = type;
    tabs.querySelectorAll('[data-ship]').forEach(tab => tab.classList.toggle('active', tab === button));
    bay?.setShip(type);
    $('#hangar-ship').innerHTML = shipStatsHTML(type);
    sound.ping();
  }));
  $('#hangar-ship').innerHTML = shipStatsHTML(bayShip);
  const input = $<HTMLInputElement>('#callsign');
  input.value = callsign;
  hydrateBay($('#hangar-viewport'), bayShip);
}

function setFlowClass() {
  const shell = $('.game-shell');
  for (const name of ['flow-title', 'flow-hangar', 'flow-launch', 'flow-flight']) shell.classList.remove(name);
  shell.classList.add(`flow-${flow}`);
  shell.classList.toggle('hud-live', flow === 'flight' || flow === 'launch');
  $<HTMLElement>('.paused-indicator').hidden = !paused || flow !== 'flight';
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => { if (button.dataset.view === 'shipyard') return; button.classList.toggle('active', flow === 'flight' && button.dataset.view === (scene.mode === 'map' ? 'map' : 'flight')); });
}

function innerHangar() {
  return `<div class="shipyard-grid">${(Object.keys(SHIPS) as ShipClass[]).map(type => {
    const ship = SHIPS[type];
    return `<article class="ship-card ${state.shipClass === type ? 'current-ship' : ''}"><div class="ship-card-top"><span>${type === 'kestrel' ? 'All-rounder' : type === 'mule' ? 'Endurance' : 'Agility'}</span>${state.shipClass === type ? '<span class="current-tag">Current vessel</span>' : ''}</div><h3>${ship.name}</h3><p>${ship.role}</p><dl>${statsFor(type).map(row => `<div><dt>${row.label}</dt><dd>${row.value}</dd></div>`).join('')}</dl><button class="${state.shipClass === type ? 'secondary-button' : 'primary-button'}" data-ship="${type}">${state.shipClass === type ? 'Stay aboard' : `Command ${ship.name}`}</button></article>`;
  }).join('')}</div>`;
}

function showHelp() {
  openDialog(`<span class="dialog-kicker">Flight school</span><h2 id="dialog-title">Space doesn’t have brakes.</h2><p class="dialog-description">Your engines change your velocity. Your thrusters change your heading. Learn to use them independently, and the belt is yours.</p><div class="manual-feature"><span class="manual-orbit">${icon('flight')}</span><div><strong>Burn. Coast. Counterburn.</strong><p>Point at your target and hold W to accelerate. Release W to coast. Hold X to fire braking thrusters before you arrive. Rotating alone won’t change where you’re going.</p></div></div><div class="manual-grid"><div><kbd>W</kbd><kbd>S</kbd><span>Main / reverse thrust</span></div><div><kbd>A</kbd><kbd>D</kbd><span>Rotate left / right</span></div><div><kbd>Q</kbd><kbd>E</kbd><span>Strafe left / right</span></div><div><kbd>Shift</kbd><span>Hard burn · more heat</span></div><div><kbd>X</kbd><span>Braking thrusters</span></div><div><kbd>F</kbd><span>Attitude assist</span></div><div><kbd>R</kbd><span>Scan, recover, dock</span></div><div><kbd>M</kbd><span>Sector chart</span></div><div><kbd>V</kbd><span>Cinematic view</span></div><div><kbd>Space</kbd><span>Pause</span></div></div><div class="manual-mission"><strong>Contract ${CONTRACT.id} · ${CONTRACT.title}</strong><p>Pull the relay telemetry first: it resolves the archive contacts. Hold station inside the scan envelope to resolve a contact, then close to 75 m and slow under 12 m/s to bring it aboard. Wayfarer pays on delivery — and pays extra for the black box still aboard the wreck of Kite’s End.</p></div><button class="primary-button" id="manual-close">Understood ${icon('check')}</button>`);
  $('#manual-close').addEventListener('click', closeDialog);
}

function resetSortie(shipClass: ShipClass = state.shipClass) {
  state = createShip(shipClass); cargos = createCargo(); mission = createMission();
  scene.changeShip(shipClass); scene.launch = 1; scene.cinematic = false;
  targetId = 'relay'; elapsed = 0; crashed = false; brakeLatched = false; accumulator = 0; burnLimit = 1; lastCollisionNotice = -10; launchTimer = 0;
  $<HTMLInputElement>('#throttle').value = '100'; $('#limiter-value').textContent = '100%';
  $('#camera-button').classList.remove('active');
  setPaused(false); setView(false); updateContacts(); updateMissionPanel(); updateAssist();
  $('#ship-name').textContent = SHIPS[shipClass].name; $('#player-name').textContent = SHIPS[shipClass].name; $('#ship-role').textContent = SHIPS[shipClass].role;
}

function updateMissionPanel() {
  const recovered = cargos.filter(cargo => cargo.kind === 'archive' && cargo.collected).length;
  const scanned = cargos.filter(cargo => cargo.kind === 'archive' && isScanned(mission, cargo.id)).length;
  $('#cargo-count').innerHTML = `${recovered} <span>/ 3</span>`;
  $('#mission-bar').style.width = `${recovered / 3 * 100}%`;
  $('#stage-relay').classList.toggle('complete', mission.stage !== 'relay');
  $('#stage-relay').classList.toggle('current', mission.stage === 'relay');
  $('#stage-relay-note').textContent = mission.stage === 'relay' ? `Hold station inside ${SCAN.relay.radius} m` : 'Telemetry recovered';
  $('#stage-scan').classList.toggle('complete', recovered === 3);
  $('#stage-scan').classList.toggle('current', mission.stage === 'recover');
  const blackbox = cargos.find(cargo => cargo.kind === 'blackbox')!;
  $('#stage-scan-note').textContent = recovered === 3 ? 'All three archives aboard' : `${scanned}/3 resolved · ${3 - scanned} to scan`;
  $('#stage-dock').classList.toggle('current', mission.stage === 'dock');
  $('#stage-dock').classList.toggle('complete', mission.stage === 'complete');
  $('#stage-optional').classList.toggle('complete', blackbox.collected);
  $('#stage-optional').classList.toggle('current', mission.stage === 'recover' && !blackbox.collected && recovered === 3);
  $('#stage-chip').textContent = mission.stage === 'relay' ? 'Relay download' : mission.stage === 'recover' ? `Archive ${Math.min(recovered + 1, 3)} of 3` : mission.stage === 'dock' ? 'Final approach' : 'Contract complete';
  $('#objective-button span').textContent = mission.stage === 'relay' ? 'Track the Nereid relay' : mission.stage === 'dock' ? 'Track Wayfarer station' : 'Track nearest contact';
}

function applySignals(signals: MissionSignal[]) {
  for (const signal of signals) {
    if (signal.type === 'relay') {
      banner('Telemetry recovered', 'Three archive contacts resolved');
      toast('Relay telemetry pulled. Archival contacts are now on your chart.');
      targetId = suggestTarget(mission, state, cargos);
      updateContacts(); updateMissionPanel(); sound.ping();
    }
    if (signal.type === 'scan') {
      toast(`${signal.cargo.name} resolved. Hold station for recovery.`);
      sound.ping(); updateMissionPanel();
    }
    if (signal.type === 'recovered') {
      scene.recover(signal.cargo);
      toast(`${signal.cargo.name} secured. ${signal.cargo.kind === 'blackbox' ? 'Bonus salvage aboard.' : `${signal.remaining} archives remaining.`}`);
      if (signal.cargo.id === targetId) targetId = suggestTarget(mission, state, cargos);
      sound.ping(); updateContacts(); updateMissionPanel();
    }
    if (signal.type === 'archives') {
      banner('Contract milestone', 'All archives aboard — return to Wayfarer');
      toast('All three archives aboard. Set course for Wayfarer station.');
      targetId = suggestTarget(mission, state, cargos);
      updateContacts(); updateMissionPanel();
    }
  }
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
  $('#mass-value').textContent = `${((spec.mass + state.fuel) / 1000).toFixed(1)} t`;
  $('#session-time').textContent = `T+ ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
  $('#player-mode').textContent = `${callsign} · ${speed < 0.1 ? 'Holding position' : state.thrustLevel > 0 ? 'Main drive active' : state.rcsActive ? 'Maneuvering' : 'Ballistic coast'}`;
  const target = getTarget();
  $('#target-summary').textContent = targetName();
  $('#target-range').textContent = target ? formatDistance(distance(state.position, target)) : '—';
  const maxBrake = spec.thrust / (spec.mass + state.fuel) * 0.65;
  const stoppingDistance = speed * speed / (2 * maxBrake);
  const tooFast = !!target && stoppingDistance > distance(state.position, target) - 40 && speed > 12;
  $('#target-speed').textContent = tooFast ? 'Brake for approach' : speed > 0.5 ? `Stopping distance ${formatDistance(stoppingDistance)}` : 'Target selected';
  $('.navigation-info').classList.toggle('approach-warning', tooFast);
  const recoverable = interactive(mission, state, cargos);
  const canDockNow = dockable(mission, state);
  const interactButton = $<HTMLButtonElement>('#interact-button');
  const scanning = activeScan();
  const prompt = $('#action-prompt');
  const urgent = state.fuel <= 0 || tooFast;
  interactButton.hidden = !(recoverable || canDockNow || scanning);
  interactButton.disabled = !!scanning && !(recoverable || canDockNow);
  interactButton.innerHTML = scanning ? `Scanning ${Math.round(scanning.progress * 100)}%` : recoverable ? `${recoverable.kind === 'blackbox' ? 'Recover black box' : 'Recover archive'} <kbd>R</kbd>` : `Dock at Wayfarer <kbd>R</kbd>`;
  $('#flight-tip').textContent = state.fuel <= 0 ? 'Propellant exhausted — return to the hangar to relaunch.'
    : tooFast ? 'Too fast for approach — hold X to brake.'
    : scanning ? `Hold this vector to resolve ${scanning.name}.`
    : '';
  prompt.hidden = !(recoverable || canDockNow || scanning || urgent);
  if (brakeLatched && speed < 0.04) brakeLatched = false;
  $('#brake-button').classList.toggle('active', brakeLatched || keys.has('KeyX'));
  $('#brake-button').setAttribute('aria-pressed', String(brakeLatched));
  updateZoomReadout();
  lastHUD = now;
}

function updateZoomReadout() {
  $('#zoom-value').textContent = `${(scene.mode === 'map' ? scene.mapZoom : scene.zoom).toFixed(2)}×`;
}

/** The contact currently inside a scan envelope, with its progress, for HUD and world feedback. */
function activeScan() {
  if (mission.stage === 'complete') return undefined;
  const speed = length(state.velocity);
  if (mission.stage === 'relay') {
    if (distance(state.position, RELAY) < SCAN.relay.radius && speed < SCAN.relay.speed) {
      return { id: 'relay', name: 'relay telemetry', position: RELAY, progress: scanProgress(mission, 'relay', SCAN.relay) };
    }
    return undefined;
  }
  for (const cargo of cargos) {
    if (cargo.collected || isScanned(mission, cargo.id)) continue;
    const spec = scanSpec(cargo);
    if (distance(state.position, cargo.position) < spec.radius && speed < spec.speed) {
      return { id: cargo.id, name: cargo.name, position: cargo.position, progress: scanProgress(mission, cargo.id, spec) };
    }
  }
  return undefined;
}

function updateLabels() {
  const bounds = $('#space-canvas').getBoundingClientRect();
  const mobile = bounds.width <= 700;
  const scan = activeScan();
  for (const [id, marker] of markers) {
    const pos = targetPosition(id);
    if (!pos) continue;
    const point = scene.project(pos, 12);
    let x = point.x, y = point.y;
    const left = mobile ? 32 : 286, right = bounds.width - (mobile ? 142 : 296);
    const top = mobile ? 247 : 112, bottom = bounds.height - (mobile ? 175 : 132);
    const offscreen = x < left || x > right || y < top || y > bottom;
    if (offscreen) { x = clamp(x, left, Math.max(left, right)); y = clamp(y, Math.min(top, bottom), bottom); }
    marker.style.transform = `translate(${x}px, ${y}px)`;
    marker.classList.toggle('edge-right', offscreen && x >= right - 1);
    marker.classList.toggle('edge-left', offscreen && x <= left + 1);
    marker.hidden = (!point.visible && !offscreen) || scene.cinematic;
    marker.classList.toggle('offscreen', offscreen);
    const shape = marker.querySelector<HTMLElement>('.marker-shape')!;
    if (offscreen) {
      if (shape.dataset.offscreen !== 'true') shape.innerHTML = icon('arrow');
      shape.style.setProperty('--bearing', `${Math.atan2(point.y - bounds.height / 2, point.x - bounds.width / 2)}rad`);
    } else if (shape.dataset.offscreen === 'true') {
      const contact = contacts().find(item => item.id === id);
      shape.innerHTML = icon(contact?.known ? contact.icon : 'target');
    }
    shape.dataset.offscreen = String(offscreen);
    const contact = contacts().find(item => item.id === id)!;
    const range = formatDistance(distance(state.position, pos));
    marker.querySelector('small')!.textContent = contact.known ? `${range} / ${offscreen ? 'Beyond view' : contact.note}` : 'Unresolved contact';
    const ring = marker.querySelector<HTMLElement>('.scan-ring')!;
    const scanning = scan?.id === id;
    ring.classList.toggle('active', scanning);
    if (scanning) ring.style.setProperty('--scan', `${Math.round(scan!.progress * 100)}%`);
    if (id === targetId) marker.dataset.target = 'true'; else delete marker.dataset.target;
  }
  const point = scene.project(state.position, 0);
  $('#player-label').style.transform = `translate(${point.x + (scene.mode === 'map' ? 24 : 60)}px, ${point.y + (scene.mode === 'map' ? 15 : 44)}px)`;
}

function updateRadar(now: number) {
  if (!radar || now - lastRadar < 55) return;
  lastRadar = now;
  radar.draw({
    time: now / 1000,
    ship: state.position,
    angle: state.angle,
    velocity: state.velocity,
    contacts: contacts().map(contact => ({ id: contact.id, kind: contact.id === 'station' ? 'station' : contact.id === 'relay' ? 'beacon' : contact.id === 'derelict' ? 'derelict' : 'cargo', position: contact.position, known: contact.known, collected: cargos.find(cargo => cargo.id === contact.id)?.collected, selected: contact.id === targetId })),
    rocks: planarRocks,
    bounds: SECTOR,
    view: { halfWidth: (scene.camera.right - scene.camera.left) / 2, halfHeight: (scene.camera.top - scene.camera.bottom) / 2 },
    zoom: scene.mode === 'map' ? scene.mapZoom : 1,
  });
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const delta = Math.min((now - lastFrame) / 1000, 0.25); lastFrame = now;
  const running = flow === 'flight' || flow === 'launch';
  const stopped = !running || paused || modalOpen || hiddenPaused || crashed;
  if (flow === 'launch') {
    launchTimer += delta;
    scene.launch = Math.min(1, launchTimer / 3.6);
    if (launchTimer >= 4.4) finishLaunch();
  }
  if (!stopped) {
    accumulator += delta;
    const scripted = flow === 'launch' ? Math.max(0, 1 - launchTimer / 2.4) * 0.5 : 0;
    const input: FlightInput = {
      thrust: scripted || (keys.has('KeyW') || keys.has('ArrowUp') ? burnLimit : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 0.28 : 0),
      turn: scripted ? 0 : (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0),
      strafe: (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0),
      brake: keys.has('KeyX') || brakeLatched, boost: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    };
    while (accumulator >= 1 / 120) {
      stepSimulation(input, 1 / 120);
      accumulator -= 1 / 120;
    }
  } else accumulator = 0;
  if (flow !== 'hangar') {
    scene.render({ state, cargos, target: getTarget() ? { id: targetId, position: getTarget()! } : undefined, scanning: activeScan(), dt: stopped ? 0 : delta, time: now / 1000 });
  }
  updateLabels();
  if (now - lastHUD > 85) updateHUD(now);
  updateRadar(now);
  sound.update(Math.abs(state.thrustLevel), stopped);
}

function stepSimulation(input: FlightInput, dt: number) {
  const before = state.hull;
  stepShip(state, input, dt);
  elapsed += dt;
  for (const rock of planarRocks) {
    resolveCollision(state, rock);
    if (before - state.hull > 2 && elapsed - lastCollisionNotice > 2) {
      const damage = before - state.hull;
      scene.impact(state.position, clamp(damage / 22, 0.35, 1.4));
      flashDamage(clamp(damage / 30, 0.3, 1));
      toast(`Impact detected. Hull integrity ${Math.ceil(state.hull / SHIPS[state.shipClass].hull * 100)}%.`);
      lastCollisionNotice = elapsed;
    }
  }
  if (mission.stage !== 'complete') applySignals(updateMission(mission, state, cargos, dt));
  if (state.hull <= 0 || state.fuel <= 0) {
    crashed = true; keys.clear();
    openDialog(`<span class="dialog-kicker">Flight terminated</span><h2 id="dialog-title">${state.hull <= 0 ? 'The belt leaves a mark.' : 'Running on empty.'}</h2><p class="dialog-description">${state.hull <= 0 ? 'Your hull could not survive the impact. Watch your stopping distance and begin the counterburn well before the next rock.' : 'Your propellant is exhausted. Coast between burns and visit Wayfarer to refuel.'}</p><button class="primary-button" id="restart-button">Return to hangar ${icon('reset')}</button><button class="ghost-button" id="retry-button">Relaunch same ship</button>`);
    $('#restart-button').addEventListener('click', () => { closeDialog(); showHangar(); });
    $('#retry-button').addEventListener('click', () => { resetSortie(); closeDialog(); launchSequence(); });
  }
}

function flashDamage(strength: number) {
  const element = $('#damage-flash');
  element.style.setProperty('--flash', String(clamp(strength, 0.25, 1)));
  element.classList.remove('visible');
  void element.offsetWidth;
  element.classList.add('visible');
}

function interact() {
  if (paused || modalOpen || crashed || flow !== 'flight') return;
  const recoverable = interactive(mission, state, cargos);
  if (recoverable) {
    applySignals(recoverCargo(mission, recoverable, cargos));
    return;
  }
  if (dockable(mission, state)) {
    state.velocity = { x: 0, y: 0 }; state.angularVelocity = 0;
    state.fuel = SHIPS[state.shipClass].fuel; state.hull = SHIPS[state.shipClass].hull; state.heat = 0;
    scene.dockPulse(); sound.ping();
    const signals = completeDock(mission);
    updateMissionPanel();
    if (signals.length) {
      const minutes = Math.floor(elapsed / 60), seconds = Math.floor(elapsed % 60);
      let best = elapsed;
      try { const saved = Number(localStorage.getItem('drift-best-time')); if (saved > 0) best = Math.min(saved, elapsed); localStorage.setItem('drift-best-time', String(best)); } catch { /* Storage is optional. */ }
      const blackbox = cargos.find(cargo => cargo.kind === 'blackbox')!;
      openDialog(`<span class="dialog-kicker">Contract ${CONTRACT.id} complete</span><div class="success-icon">${icon('check')}</div><h2 id="dialog-title">You brought them home.</h2><p class="dialog-description">Three archives recovered and the survey crew’s last hours are on the record. Wayfarer has transferred your payment.</p><div class="debrief-stats"><div><span>Payment received</span><strong>${mission.payout.toLocaleString()} <small>cr</small></strong></div><div><span>Flight time</span><strong>${minutes}:${String(seconds).padStart(2, '0')}</strong></div><div><span>Best time</span><strong>${Math.floor(best / 60)}:${String(Math.floor(best % 60)).padStart(2, '0')}</strong></div></div>${blackbox.collected ? '' : '<p class="debrief-note">The black box of Kite’s End is still out there — 4,200 credits for whoever brings it in.</p>'}<button class="primary-button" id="next-sortie">Return to hangar ${icon('flight')}</button><button class="ghost-button" id="again-sortie">Relaunch same ship</button>`);
      $('#next-sortie').addEventListener('click', () => { closeDialog(); showHangar(); });
      $('#again-sortie').addEventListener('click', () => { resetSortie(); closeDialog(); launchSequence(); });
    } else toast('Docked at Wayfarer. Hull repaired and propellant replenished.');
    return;
  }
  const scan = activeScan();
  if (scan) { toast(`Hold station and let the sensor mast resolve ${scan.name}.`); return; }
  toast('Fly closer to a contact to scan, recover or dock.');
}

function launchSequence() {
  flow = 'launch'; launchTimer = 0;
  setFlowClass();
  scene.setMode('flight');
  scene.launch = 0;
  $<HTMLElement>('#hangar-screen').hidden = true;
  $<HTMLElement>('#title-screen').hidden = true;
  $<HTMLElement>('#launch-card').hidden = false;
  $('#launch-kicker').textContent = `Contract ${CONTRACT.id} · ${SHIPS[state.shipClass].name}`;
  $('#launch-title').textContent = CONTRACT.title;
  $('#launch-line').textContent = `Pilot ${callsign}, first waypoint is the Nereid relay. Hold station to pull its telemetry.`;
  $('.game-shell').classList.remove('hud-live');
}

function finishLaunch() {
  if (flow !== 'launch') return;
  flow = 'flight';
  scene.launch = 1;
  setFlowClass();
  $<HTMLElement>('#launch-card').hidden = true;
  updateContacts(); updateMissionPanel();
  banner('Sortie launched', `Track the Nereid relay · ${formatDistance(distance(state.position, RELAY))}`);
  toast('Main drive released. Burn toward the relay marker, then hold station to pull its telemetry.');
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
  if (flow !== 'flight') return;
  if (button.dataset.view === 'shipyard') showShipyard(); else setView(button.dataset.view === 'map');
}));
$('#change-ship').addEventListener('click', showShipyard);
$('#objective-button').addEventListener('click', trackNearest);
$('#pause-button').addEventListener('click', () => { if (flow === 'flight') setPaused(!paused); });
$('#resume-button').addEventListener('click', () => setPaused(false));
$('#pause-hangar').addEventListener('click', () => { setPaused(false); showHangar(); });
$('#pause-manual').addEventListener('click', showHelp);
$('#help-button').addEventListener('click', showHelp); $('#controls-help').addEventListener('click', showHelp);
$('#assist-button').addEventListener('click', toggleAssist);
$('#brake-button').addEventListener('click', () => { brakeLatched = !brakeLatched; if (brakeLatched) toast('Braking thrusters engaged. Velocity hold will stop the ship.'); });
$('#interact-button').addEventListener('click', interact);
$('#camera-button').addEventListener('click', setCinematic);
$('#sound-button').addEventListener('click', async () => {
  try { const enabled = await sound.toggle(); $('#sound-button').innerHTML = icon(enabled ? 'sound' : 'mute'); $('#sound-button').setAttribute('aria-label', enabled ? 'Mute cabin audio' : 'Enable cabin audio'); toast(enabled ? 'Cabin audio enabled.' : 'Cabin audio muted.'); } catch { toast('Audio is unavailable in this browser. Flight controls are ready.'); }
});
$('#title-begin').addEventListener('click', () => { sound.ping(); showHangar(); });
$('#title-hangar').addEventListener('click', () => { sound.ping(); showHangar(); });
$('#title-manual').addEventListener('click', showHelp);
$('#hangar-back').addEventListener('click', showTitle);
$('#launch-sortie').addEventListener('click', () => {
  callsign = ($<HTMLInputElement>('#callsign').value.trim() || 'Rook').slice(0, 14);
  try { localStorage.setItem('drift-callsign', callsign); } catch { /* Storage is optional. */ }
  resetSortie(bayShip);
  setFlowClass();
  launchSequence();
});

function changeZoom(delta: number) { scene.setZoom(delta); updateZoomReadout(); }
$('#zoom-in').addEventListener('click', () => changeZoom(0.2));
$('#zoom-out').addEventListener('click', () => changeZoom(-0.2));
$('#zoom-reset').addEventListener('click', () => { scene.resetZoom(); updateZoomReadout(); });
$('#space-canvas').addEventListener('wheel', event => { event.preventDefault(); changeZoom(event.deltaY > 0 ? -0.08 : 0.08); }, { passive: false });
$('#throttle').addEventListener('input', event => { const value = Number((event.target as HTMLInputElement).value); burnLimit = value / 100; $('#limiter-value').textContent = `${value}%`; });

const flightKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
window.addEventListener('keydown', event => {
  if (!scene || event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
  if (flow === 'launch') { if (event.code !== 'Escape') { finishLaunch(); } return; }
  if (flow !== 'flight') {
    if (event.code === 'Escape' && flow === 'hangar') showTitle();
    if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); showHangar(); }
    return;
  }
  if (modalOpen) return;
  if (event.target instanceof HTMLButtonElement && (event.code === 'Space' || event.code === 'Enter')) return;
  if (flightKeys.includes(event.code) || ['Space', 'KeyF', 'KeyR', 'KeyM', 'KeyV', 'KeyH'].includes(event.code)) event.preventDefault();
  if (flightKeys.includes(event.code) && !paused) keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Space') setPaused(!paused);
  if (event.code === 'KeyF') toggleAssist();
  if (event.code === 'KeyR') interact();
  if (event.code === 'KeyM') setView(scene.mode !== 'map');
  if (event.code === 'KeyV') setCinematic();
  if (event.code === 'KeyH') showHelp();
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { hiddenPaused = document.hidden; keys.clear(); lastFrame = performance.now(); });
document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', event => { event.preventDefault(); if (paused || modalOpen || crashed || flow !== 'flight') return; button.setPointerCapture(event.pointerId); keys.add(button.dataset.key!); button.classList.add('pressed'); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { keys.delete(button.dataset.key!); button.classList.remove('pressed'); });
});
window.addEventListener('pointerdown', event => { if (flow === 'launch' && !(event.target instanceof HTMLButtonElement)) finishLaunch(); });

function showShipyard() {
  openDialog(`<span class="dialog-kicker">Independent fleet</span><h2 id="dialog-title">Find your kind of trouble.</h2><p class="dialog-description">Three ships. Three ways through the belt. Switching vessels starts a fresh sortie with the contract reset.</p><div class="shipyard-bay" id="shipyard-bay"></div>${innerHangar()}`, true);
  hydrateBay($('#shipyard-bay'), state.shipClass);
  document.querySelectorAll<HTMLButtonElement>('#dialog-content [data-ship]').forEach(button => button.addEventListener('click', () => {
    const type = button.dataset.ship as ShipClass;
    if (type === state.shipClass) { toast(`${SHIPS[type].name} stays your vessel.`); return; }
    resetSortie(type);
    closeDialog();
    launchSequence();
    toast(`${SHIPS[type].name} is ready. Your new sortie has begun.`);
  }));
}

async function boot() {
  try {
    await document.fonts.ready;
    scene = new SpaceScene($('#space-canvas'), obstacles, cargos);
    radar = new Radar($<HTMLCanvasElement>('#radar-canvas'));
    try { callsign = localStorage.getItem('drift-callsign')?.slice(0, 14) || 'Rook'; } catch { /* Storage is optional. */ }
    updateContacts(); updateHUD(0); updateMissionPanel(); showTitle();
    $('.game-shell').removeAttribute('inert');
    $('#loading-state').classList.add('loaded');
    window.setTimeout(() => $('#loading-state').remove(), 600);
    lastFrame = performance.now(); requestAnimationFrame(frame);
    // A read-only snapshot supports repeatable browser diagnostics without exposing mutation hooks.
    Object.defineProperty(window, '__DRIFT__', {
      value: {
        snapshot: () => structuredClone({
          state, cargos, mission, elapsed, paused, modalOpen, flow, crashed,
          tactical: scene.mode === 'map', zoom: scene.zoom, mapZoom: scene.mapZoom,
          recoveredCount: cargos.filter(cargo => cargo.kind === 'archive' && cargo.collected).length,
          missionComplete: mission.stage === 'complete', callsign,
        }),
      },
    });
  } catch (error) {
    console.error('Flight deck initialization failed:', error);
    $('.game-shell').removeAttribute('inert');
    document.querySelectorAll<HTMLButtonElement>('.game-shell button').forEach(button => { button.disabled = true; });
    $('#loading-state').innerHTML = `<span class="brand-loading">DRIFT</span><h2>The viewport couldn’t start.</h2><p>Enable hardware acceleration or use a browser with WebGL 2 support, then reload.</p><button class="primary-button" id="retry-viewport">Reload flight deck</button>`;
    $('#retry-viewport').addEventListener('click', () => location.reload());
  }
}
void boot();
