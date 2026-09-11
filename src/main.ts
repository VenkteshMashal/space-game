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
import { Collar } from './collar';
import type { CollarMark } from './collar';
import { buildShip, disposeObject } from './models';
import type { ShipModel } from './models';
import { ShipBay } from './hangar';
import { Radar } from './radar';
import { FlightAudio } from './audio';
import { combatTargets, sortieEarnings } from './sortie';
import { resolveShipCollision } from './physics';
import { clamp, createCargo, createObstacles, createShip, distance, fractureRock, heading, length, ORE_PICKUP_RADIUS, ORE_PRICE, resolveBodies, resolveCollision, setStationSpin, shipBox, SHIPS, SECTOR, SOLID_BODIES, SpatialGrid, STATION, RELAY, stepFragments, stepOre, stepShip } from './physics';
import type { FlightInput, Obstacle, Ore, ShipClass, ShipState, Vec2 } from './physics';
import { createHostile, fireMounts, HOSTILES, MAX_ROUNDS, Rounds, stepBeams, stepHostile, stepRounds, STOCK_MOUNTS, WEAPONS, wrapAngle } from './combat';
import type { BeamHit, Hit, Hostile, HostileKind, Mount } from './combat';
import { SHIP_SCALE } from './scene';
import type { BeamVisual } from './scene';
import { obbCircleOut } from './collision';
import { activeCargoIds, available, completeDock, createRun, dockable, interactive, isScanned, lockedBy, objectiveSummary, progressOf, recoverCargo, resolveTarget, scanProgress, scanSpec, stage, suggestTarget, updateRun, CONTRACTS } from './contracts';
import type { Contract, EscortSpec, NavTarget, Run, RunSignal, SpawnSpec, World } from './contracts';
import { createAlly, stepAlly } from './ally';
import type { Ally } from './ally';
import { Builder } from './builder';
import { buildFromParts, buildSpec, createBuild, derive, purchaseQuoteForBuild } from './build';
import type { Build, BuiltShip } from './build';
import { CORES, PARTS } from './parts';
import { bestTime, earn, fresh, load, own, recordTime, save, spend } from './save';
import type { Profile } from './save';
import { Box3, Color, Mesh, Vector3 } from 'three';
import type * as THREE from 'three';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

$('#app').innerHTML = `
  <div class="game-shell flow-title" inert>
    <main class="flight-deck" aria-label="Flight deck">
      <div id="space-canvas"></div>
      <div class="viewport-shade"></div>
      <canvas id="collar-canvas" aria-label="Bearing ring" role="img"></canvas>

      <div class="hud hud-top-left">
        <a class="brand hud-mark" href="./" aria-label="DRIFT home"><svg class="brand-mark" viewBox="0 0 38 40" fill="none" aria-hidden="true"><path d="M5 32 18 4l7 17-9-5-4 16Z" fill="currentColor"/><path d="m21 32 8-18 7 18Z" fill="currentColor"/></svg><span>DRIFT</span></a>
        <button class="contract-line hud-mark is-live" id="objective-button" aria-label="Track the nearest objective">
          <span class="contract-id" id="contract-id">SR-084</span>
          <strong id="mission-title">Ghosts in the belt</strong>
        </button>
        <div class="contract-rule hud-mark is-live"><span id="mission-bar"></span></div>
        <p class="contract-count hud-mark is-live"><span id="stage-chip">Stage 1</span><span id="cargo-count">0 <span>/ 3</span></span></p>
        <div class="target-telemetry" id="target-telemetry" hidden><span id="combat-target-name"></span><strong id="combat-target-hull"></strong><i><b id="combat-target-bar"></b></i><small id="combat-target-range"></small></div>
      </div>

      <div class="hud hud-top-right">
        <nav class="nav-icons" aria-label="Game views"><button class="nav-button active" data-view="flight" aria-label="Flight deck">${icon('flight')}</button><button class="nav-button" data-view="map" aria-label="System map">${icon('map')}</button><button class="nav-button" data-view="shipyard" aria-label="Shipyard">${icon('ship')}</button></nav>
        <span class="session hud-mark is-live"><i id="session-dot"></i><span id="session-time">T+ 00:00</span></span>
        <button class="icon-button" id="sound-button" aria-label="Enable cabin audio" title="Cabin audio">${icon('mute')}</button><button class="icon-button" id="pause-button" aria-label="Pause simulation" title="Pause · Esc">${icon('pause')}</button><button class="icon-button" id="help-button" aria-label="Open flight manual" title="Flight manual · H">${icon('help')}</button>
      </div>

      <div class="hud hud-bottom-left">
        <div class="bars">
          <div class="bar" id="readout-hull"><span class="bar-label">hull</span><i class="bar-track"><b id="hull-bar"></b></i><em class="bar-value" id="hull-value">100<small>%</small></em></div>
          <div class="bar" id="readout-prop"><span class="bar-label">prop</span><i class="bar-track"><b id="fuel-bar"></b></i><em class="bar-value" id="fuel-value">100<small>%</small></em></div>
          <div class="bar" id="readout-heat"><span class="bar-label">heat</span><i class="bar-track"><b id="heat-bar"></b></i><em class="bar-value" id="heat-value">0<small>%</small></em></div>
          <div class="bar" id="readout-hold"><span class="bar-label">hold</span><i class="bar-track"><b id="hold-bar"></b></i><em class="bar-value" id="hold-value">0<small>/120</small></em></div>
        </div>
        <div class="vessel-id hud-mark is-live"><strong id="ship-name">Kestrel</strong><button id="change-ship" class="text-icon-button" aria-label="Change ship" title="Change ship">${icon('chevron')}</button></div>
        <div class="toggles">
          <button class="toggle is-live" id="assist-button" aria-pressed="true">flight assist <b id="assist-status">on</b><kbd>F</kbd></button>
          <button class="toggle" id="brake-button" aria-pressed="false">kill velocity<kbd>X</kbd></button>
        </div>
      </div>

      <div class="hud hud-bottom-right">
        <div class="viewport-tools"><button class="icon-button" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><span id="zoom-value" class="hud-mark is-live">1.40×</span><button class="icon-button" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><button class="icon-button" id="zoom-reset" aria-label="Reset zoom" title="Reset zoom">${icon('expand')}</button><button class="icon-button" id="camera-button" aria-label="Toggle cinematic view" title="Cinematic view · V">${icon('eye')}</button></div>
        <div class="guns hud-mark is-live" id="weapons-strip"></div>
        <div class="numerals hud-mark is-live"><span id="accel-value">0.00<small> g</small></span><span id="heading-value">036<small>°</small></span><span id="turn-rate">0.0<small> °/s</small></span></div>
      </div>

      <div class="hud hud-centre">
        <div class="velocity hud-mark is-live"><strong id="velocity-value">0.0</strong><span>m/s<b id="motion-state">At rest</b></span></div>
        <i class="velocity-rule"><b id="velocity-fill"></b></i>
        <div class="context" id="action-prompt" hidden><span id="flight-tip"></span><button id="interact-button">Recover <kbd>R</kbd></button></div>
      </div>

      <div id="world-labels" aria-label="Navigation targets"></div>
      <span id="hit-confirm" class="hit-confirm" aria-hidden="true">×</span>
      <div class="ship-label" id="player-label"><span class="label-rule"></span><div><strong id="player-name">Kestrel</strong><small id="player-mode">Coasting</small></div></div>
      <div class="map-legend" hidden><h2>Nereid recovery zone</h2><p>5.2 × 4.2 km across, 500 m grid squares</p><span>${icon('flight')}Your vessel</span><span>${icon('beacon')}Relay beacon</span><span>${icon('box')}Salvage archive</span><span>${icon('derelict')}Derelict wreck</span><span>${icon('station')}Wayfarer station</span><span>${icon('raider')}Hostile contact</span><small>Choose a contact to set your navigation target. Tab cycles hostiles.</small></div>
      <div class="radar-plate" id="radar-plate"><canvas id="radar-canvas" aria-label="Sector chart"></canvas><div class="navigation-info"><span id="target-summary">No target</span><strong id="target-range">—</strong><small id="target-speed">Target selected</small></div></div>
      <div class="touch-controls" aria-label="Touch flight controls"><div class="touch-steering"><button data-key="KeyA" aria-label="Rotate left">↶</button><button data-key="KeyD" aria-label="Rotate right">↷</button></div><div class="touch-drive"><button data-key="KeyX" aria-label="Brake">Brake</button><button data-key="KeyW" class="touch-burn" aria-label="Main thrust">${icon('flight')} Burn</button><button data-trigger="fire" class="touch-fire" aria-label="Fire weapons">${icon('target')} Fire</button><button data-trigger="mine" aria-label="Mining cutter">${icon('bolt')} Cut</button></div></div>
      <div class="paused-indicator" hidden>
        <span>Simulation paused</span>
        <div class="pause-actions"><button id="resume-button">Resume flight ${icon('play')}</button><button id="pause-hangar">Return to hangar</button><button id="pause-manual">Flight manual</button></div>
        <div class="mission-stages" id="stage-rows"></div>
        <div class="pause-specs"><label class="limiter"><span>Thrust limiter <b id="limiter-value">100%</b></span><input id="throttle" type="range" min="10" max="100" value="100" aria-label="Main engine thrust limit"/></label><p><span id="ship-role">Independent corvette</span><span id="mass-value">98.0 t</span><span id="drive-state">Standby</span></p></div>
        <div class="keyboard-guide"><span><kbd>W</kbd><kbd>S</kbd> thrust</span><span><kbd>A</kbd><kbd>D</kbd> rotate</span><span><kbd>Space</kbd> fire</span><span><kbd>C</kbd> cutter</span><span><kbd>R</kbd> interact</span><span><kbd>M</kbd> chart</span><span>no drag, no speed limit</span></div>
      </div>
      <div class="stage-banner" id="stage-banner" hidden><span id="stage-banner-kicker">Objective</span><strong id="stage-banner-text"></strong></div>
      <div class="damage-flash" id="damage-flash"></div>
      <div id="toast" role="status" aria-live="polite"></div>
      <p class="sr-only" id="hud-status" role="status" aria-live="polite"></p>
      <div class="loading-state" id="loading-state"><span class="brand-loading">DRIFT</span><p>Bringing flight systems online…</p></div>
    </main>

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
        <div class="title-meta"><span id="title-best">No flight recorded</span><span class="title-dot"></span><span id="title-credits">6,000 cr</span><span class="title-dot"></span><span>Build 1.0 · local simulation</span></div>
      </div>
    </section>

    <section class="hangar-screen" id="hangar-screen" hidden aria-label="Hangar bay">
      <div class="hangar-grid">
        <div class="hangar-bay">
          <div class="bay-viewport" id="hangar-viewport"></div>
          <div class="bay-strip-head"><span class="section-label">Vessel</span><span class="section-hint">Switch hull · next sortie starts fresh</span></div>
          <div class="bay-strip" id="hangar-tabs"></div>
          <div class="bay-strip-head"><span class="section-label">Contracts</span><span class="section-hint">Locked work opens as you finish jobs</span></div>
          <div class="contract-strip" id="contract-board"></div>
        </div>
        <div class="hangar-brief">
          <span class="dialog-kicker">Contract board · Wayfarer</span>
          <h2 id="hangar-title">Ghosts in the belt</h2>
          <p class="brief-copy" id="hangar-brief">A survey crew stopped transmitting in the Nereid recovery zone.</p>
          <div class="brief-stages" id="hangar-stages"></div>
          <div class="brief-ship" id="hangar-ship"></div>
          <label class="callsign-field"><span>Call sign</span><input id="callsign" maxlength="14" autocomplete="off" spellcheck="false" value="Rook"/></label>
          <button class="primary-button" id="launch-sortie">Launch sortie ${icon('flight')}</button>
          <button class="ghost-button" id="hangar-shipyard">Open shipyard</button>
          <button class="ghost-button" id="hangar-back">Back to title</button>
        </div>
      </div>
    </section>

    <section class="build-screen" id="build-screen" hidden aria-label="Shipyard">
      <div class="build-grid">
        <div class="build-bay">
          <div class="bay-viewport" id="build-viewport"></div>
          <div class="builder-caption">Drag to spin · scroll to zoom · click a socket to fit a part</div>
        </div>
        <div class="builder-panel" id="builder-panel"></div>
      </div>
    </section>

    <div class="launch-card" id="launch-card" hidden>
      <span id="launch-kicker">Contract SR-084</span>
      <h2 id="launch-title">Ghosts in the belt</h2>
      <p id="launch-line">First waypoint is on your chart. Hold station inside the envelope to make it count.</p>
      <small>Press any key to skip</small>
    </div>
  </div>
  <dialog id="game-dialog" aria-labelledby="dialog-title"><div class="dialog-inner"><button class="dialog-close icon-button" aria-label="Close dialog">${icon('cross')}</button><div id="dialog-content"></div></div></dialog>
`;

type Flow = 'title' | 'hangar' | 'builder' | 'launch' | 'flight';

let state = createShip();
let cargos = createCargo();
let run: Run = createRun(CONTRACTS[0]);
/** The contract the hangar board has selected, which the next launch starts. */
let selectedContract: Contract = CONTRACTS[0];
/** Where the navigation computer is pointing, including waypoints that are not world contacts. */
let navTarget: NavTarget | undefined;
const obstacles = createObstacles();
const grid = new SpatialGrid(obstacles);
const nearby: Obstacle[] = [];
const spawnPush = { x: 0, y: 0 };
const planarRocks = obstacles.filter(rock => rock.z === 0);
const rounds = new Rounds();
const ore: Ore[] = [];
const fragments: Obstacle[] = [];
const counters = { hostilesKilled: 0, rocksBroken: 0, oreHeld: 0, brokenRadii: [] as number[] };

/** The slice of the world a contract can see. */
function world(): World {
  return {
    ship: state,
    cargos,
    rocks: planarRocks,
    hostiles: hostiles.map(hostile => hostile.state.position),
    allies: allies.map(ally => ({ id: ally.id, name: ally.name, position: ally.state.position, hull: ally.state.hull, maxHull: ally.maxHull })),
    counters,
  };
}
const aimTargets: { state: ShipState; faction: 0 | 1 }[] = [];
const beamVisuals: BeamVisual[] = [
  { x: 0, y: 0, ex: 0, ey: 0, hot: false }, { x: 0, y: 0, ex: 0, ey: 0, hot: false },
  { x: 0, y: 0, ex: 0, ey: 0, hot: false }, { x: 0, y: 0, ex: 0, ey: 0, hot: false },
];
let mounts: Mount[] = [];
let hostiles: Hostile[] = [];
let allies: Ally[] = [];
const allyModels = new Map<string, ShipModel>();
let nextHostileId = 1;
let pendingBounty = 0;
let nextRockId = 100000;
let oreHeld = 0;
let aim: Vec2 = { x: 0, y: 0 };
let aimFromPointer = false;
const pointerAim = { x: 0, y: 0 };
let lastHitTime = -1;
let firing = false;
let mining = false;
let scene: SpaceScene;
let radar: Radar;
let collar: Collar | undefined;
const collarMarks: CollarMark[] = [];
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const prefersReducedMotion = () => reducedMotionQuery.matches;
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
let builder: Builder | undefined;
let profile: Profile = fresh();
/** The custom build currently in flight, if the sortie was launched from the shipyard. */
let sortieBuild: Build | undefined;
let lastEarnings: { payout: number; bonus: number; ore: number; bounty: number } | undefined;
const dialog = $<HTMLDialogElement>('#game-dialog');
const markers = new Map<string, HTMLButtonElement>();

type Contact = { id: string; name: string; icon: string; position: Vec2; known: boolean; note: string; hostile?: Hostile };

function contacts(): Contact[] {
  const wanted = new Set(activeCargoIds(run, world()));
  const list: Contact[] = [
    { id: 'station', name: 'Wayfarer station', icon: 'station', position: STATION, known: true, note: 'Anchorage' },
    { id: 'relay', name: 'Nereid relay', icon: 'beacon', position: RELAY, known: true, note: run.stageIndex > 0 ? 'Telemetry pulled' : 'Awaiting download' },
  ];
  for (const cargo of cargos) {
    if (cargo.kind === 'blackbox') {
      list.push({ id: 'derelict', name: 'Kite’s End', icon: 'derelict', position: cargo.position, known: wanted.has(cargo.id), note: 'Derelict wreck' });
      continue;
    }
    list.push({ id: cargo.id, name: cargo.name, icon: 'box', position: cargo.position, known: wanted.has(cargo.id), note: isScanned(run, cargo.id) ? 'Resolved' : 'Unresolved contact' });
  }
  // Hostiles are contacts like any other: they mark, they track and Tab cycles through them.
  for (const hostile of hostiles) {
    list.push({ id: `hostile-${hostile.id}`, name: hostileLabel(hostile), icon: 'raider', position: hostile.state.position, known: true, note: hostile.mode === 'attack' ? 'Engaging' : hostile.mode === 'flee' ? 'Running' : 'Patrolling', hostile });
  }
  for (const ally of allies) {
    list.push({ id: ally.id, name: ally.name, icon: 'ship', position: ally.state.position, known: true, note: ally.lost ? 'Lost with all hands' : `Escort · hull ${Math.round(ally.state.hull)}%` });
  }
  return list;
}

function targetPosition(id: string): Vec2 | undefined {
  const ally = allies.find(entry => entry.id === id);
  if (ally) return ally.state.position;
  if (navTarget?.id === id) return navTarget.position;
  if (id === 'station') return STATION;
  if (id === 'relay') return RELAY;
  if (id === 'derelict') return cargos.find(cargo => cargo.kind === 'blackbox')?.position;
  if (id.startsWith('hostile-')) return hostiles.find(hostile => `hostile-${hostile.id}` === id)?.state.position;
  return cargos.find(cargo => cargo.id === id)?.position;
}

/** Names for the navigation readouts, including waypoints that are not contacts in the world. */
function contactName(id: string): string {
  const ally = allies.find(entry => entry.id === id);
  if (ally) return ally.name;
  if (navTarget?.id === id) return navTarget.name;
  if (id === 'station') return 'Wayfarer station';
  if (id === 'relay') return 'Nereid relay';
  if (id === 'derelict') return 'Kite’s End';
  return cargos.find(cargo => cargo.id === id)?.name ?? 'No target';
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
function targetName() {
  if (targetId.startsWith('hostile-')) {
    const hostile = hostiles.find(entry => `hostile-${entry.id}` === targetId);
    return hostile ? hostileLabel(hostile) : 'No target';
  }
  return contactName(targetId);
}

function updateContacts() {
  const list = contacts();
  const labels = $('#world-labels'); labels.innerHTML = ''; markers.clear();
  for (const contact of list) {
    if (!contact.known) continue;
    const marker = document.createElement('button');
    marker.className = `world-marker ${contact.id === targetId ? 'selected' : ''} ${contact.id === 'station' ? 'station-marker' : ''} ${contact.hostile ? 'hostile-marker' : ''} ${contact.known ? '' : 'unresolved'}`;
    marker.innerHTML = `<span class="marker-shape">${icon(contact.icon)}</span><span class="marker-copy"><strong>${contact.known ? contact.name : 'Unresolved'}</strong><small></small></span><span class="scan-ring"><i></i></span>`;
    marker.setAttribute('aria-label', contact.known ? `Track ${contact.name}` : 'Unresolved contact');
    marker.addEventListener('click', () => selectTarget(contact.id));
    labels.appendChild(marker); markers.set(contact.id, marker);
  }
}

function selectTarget(id: string) { targetId = id; updateContacts(); sound.ping(); }

function trackNearest() {
  navTarget = suggestTarget(run, world());
  if (navTarget) targetId = navTarget.id;
  updateContacts();
  toast(`Navigation set to ${targetName()}. Burn toward the marker, then hold X to brake.`);
}

function setPaused(value: boolean) {
  paused = value; keys.clear(); firing = false; mining = false;
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
    <dl>${statsFor(shipClass).map(row => `<div class="spec-row"><dt>${row.label}</dt><i></i><dd>${row.value}</dd></div>`).join('')}</dl>`;
}

function hydrateBay(container: HTMLElement, shipClass: ShipClass) {
  bay?.dispose();
  bay = new ShipBay(container);
  bay.setShip(shipClass);
  bayShip = shipClass;
}

function buildStatsHTML(build: Build) {
  const stats = derive(build);
  const core = CORES[build.core];
  const rows = [
    { label: 'Dry mass', value: `${(stats.dryMass / 1000).toFixed(1)} t`, ratio: stats.dryMass / 200000 },
    { label: 'Max acceleration', value: `${stats.gees.toFixed(2)} g`, ratio: stats.gees / 18 },
    { label: 'Propellant', value: `${(stats.fuel / 1000).toFixed(1)} t`, ratio: stats.fuel / 30000 },
    { label: 'Hull rating', value: String(Math.round(stats.hull)), ratio: stats.hull / 150 },
    { label: 'Attitude authority', value: stats.torque.toFixed(2), ratio: stats.torque / 2.05 },
  ];
  return `<div class="brief-ship-head"><h3>${escapeHtml(build.name)}</h3><span>${core ? core.name : build.core} · custom build</span></div>
    <dl>${rows.map(row => `<div class="spec-row"><dt>${row.label}</dt><i></i><dd>${row.value}</dd></div>`).join('')}</dl>`;
}

/** Measures the assembled hull so a custom ship collides as what is drawn, like the stock classes. */
function colliderFor(model: { group: THREE.Group }, scale = SHIP_SCALE) {
  const bounds = new Box3();
  model.group.updateMatrixWorld(true);
  model.group.traverse(child => {
    if (!(child instanceof Mesh) || child.userData.effect || child.name === 'flame' || child.name === 'rcs-jet') return;
    child.geometry.computeBoundingBox();
    bounds.union(child.geometry.boundingBox!.clone().applyMatrix4(child.matrixWorld));
  });
  return { halfLength: clamp(Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)) * scale, 18, 120),
    halfWidth: clamp(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) * scale, 12, 80) };
}

function activeBuild(): Build | undefined {
  const active = profile.activeShip;
  return active.kind === 'build' ? profile.builds.find(build => build.id === active.id) : undefined;
}

function closeBuilder() {
  builder?.dispose();
  builder = undefined;
  // A launch leaves the bay behind: keeping a second WebGL context alive while flying is wasted work.
  if (flow === 'builder') { bay?.dispose(); bay = undefined; }
  $<HTMLElement>('#build-screen').hidden = true;
}

function showBuilder(build?: Build) {
  flow = 'builder';
  setFlowClass();
  $<HTMLElement>('#title-screen').hidden = true;
  $<HTMLElement>('#hangar-screen').hidden = true;
  $<HTMLElement>('#build-screen').hidden = false;
  hydrateBay($('#build-viewport'), bayShip);
  builder = new Builder(bay!, $('#builder-panel'), {
    credits: () => profile.credits,
    owns: id => own(profile, id),
    buy: id => {
      const item = (PARTS as Record<string, { cost: number } | undefined>)[id] ?? (CORES as Record<string, { cost: number } | undefined>)[id];
      if (!item) return false;
      if (!spend(profile, item.cost)) { toast(`Not enough credits for that — ${item.cost.toLocaleString()} cr needed.`); return false; }
      profile.owned.push(id);
      save(profile);
      toast('Purchased and installed.');
      return true;
    },
    save: build => {
      const existing = profile.builds.find(entry => entry.id === build.id);
      if (existing) Object.assign(existing, structuredClone(build));
      else profile.builds.push(structuredClone(build));
      save(profile);
      toast(`${build.name} saved to the yard.`);
    },
    launch: build => launchBuild(build),
    close: () => showHangar(),
  }, structuredClone(build ?? activeBuild() ?? createBuild('spar', 'New frame', `b${Date.now().toString(36)}`)));
}

function launchBuild(build: Build) {
  const stats = derive(build);
  const quote = purchaseQuoteForBuild(build, profile.owned);
  if (!stats.valid || quote.items.length || (selectedContract.kind === 'mining' && (!stats.cargo || !stats.mounts.length)) || (selectedContract.kind === 'bounty' && !stats.mounts.length)) {
    showBuilder(build);
    toast(stats.problems[0] ?? (quote.items.length ? `Purchase the remaining systems: ${quote.total.toLocaleString()} cr.` : 'Fit weapons and mission equipment before launching this contract.'));
    return;
  }
  const savedBuild = profile.builds.find(entry => entry.id === build.id);
  if (savedBuild) Object.assign(savedBuild, structuredClone(build));
  else profile.builds.push(structuredClone(build));
  callsign = ($<HTMLInputElement>('#callsign').value.trim() || profile.callsign).slice(0, 14);
  profile.callsign = callsign;
  profile.activeShip = { kind: 'build', id: build.id };
  save(profile);
  closeBuilder();
  resetSortie('kestrel', build);
  setFlowClass();
  launchSequence();
}

function launchStock(shipClass: ShipClass) {
  profile.activeShip = { kind: 'stock', id: shipClass };
  profile.callsign = callsign;
  save(profile);
  resetSortie(shipClass);
  setFlowClass();
  launchSequence();
}

function showTitle() {
  flow = 'title';
  setFlowClass();
  closeBuilder();
  bay?.dispose(); bay = undefined;
  $<HTMLElement>('#hangar-screen').hidden = true;
  $<HTMLElement>('#build-screen').hidden = true;
  $<HTMLElement>('#title-screen').hidden = false;
  scene.setMode('title');
  scene.titleFocus = window.innerWidth > 900 ? { x: -430, y: -110 } : { x: 0, y: -30 };
  scene.cinematic = false;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.remove('active'));
  const best = bestTime(profile, selectedContract.id);
  $('#title-best').textContent = best > 0 ? `Best flight ${Math.floor(best / 60)}:${String(Math.floor(best % 60)).padStart(2, '0')}` : 'No flight recorded';
  $('#title-credits').textContent = `${profile.credits.toLocaleString()} cr`;
}

function showHangar() {
  flow = 'hangar';
  setFlowClass();
  closeBuilder();
  $<HTMLElement>('#title-screen').hidden = true;
  $<HTMLElement>('#build-screen').hidden = true;
  $<HTMLElement>('#hangar-screen').hidden = false;
  renderHangarTabs();
  renderContractBoard();
  renderContractBrief();
  $<HTMLInputElement>('#callsign').value = profile.callsign;
  hydrateBay($('#hangar-viewport'), bayShip);
  setHangarShip(profile.activeShip);
}

/** Draws the tab strip: the three stock hulls, then every saved build, then the shipyard door. */
function renderHangarTabs() {
  const tabs = $('#hangar-tabs');
  const active = profile.activeShip;
  const stock = (Object.keys(SHIPS) as ShipClass[]).map(type => shipCardHTML(type, active.kind === 'stock' && active.id === type)).join('');
  const builds = profile.builds.map(build => `<button class="bay-tab ${active.kind === 'build' && active.id === build.id ? 'active' : ''}" data-build="${build.id}">
    <span class="bay-tab-name">${escapeHtml(build.name)}</span><span class="bay-tab-role">${CORES[build.core]?.name ?? 'Custom'} · ${derive(build).gees.toFixed(2)} g</span></button>`).join('');
  tabs.innerHTML = `${stock}${builds}<button class="bay-tab bay-tab-new" id="hangar-new-build"><span class="bay-tab-name">+ New build</span><span class="bay-tab-role">Open the shipyard</span></button>`;
  tabs.querySelectorAll<HTMLButtonElement>('[data-ship]').forEach(button => button.addEventListener('click', () => {
    setHangarShip({ kind: 'stock', id: button.dataset.ship as ShipClass });
    sound.ping();
  }));
  tabs.querySelectorAll<HTMLButtonElement>('[data-build]').forEach(button => button.addEventListener('click', () => {
    setHangarShip({ kind: 'build', id: button.dataset.build! });
    sound.ping();
  }));
  $('#hangar-new-build').addEventListener('click', () => { sound.ping(); showBuilder(); });
}

/** Shows a vessel in the bay and remembers it as the one the next sortie launches in. */
function setHangarShip(active: Profile['activeShip']) {
  const tabs = $('#hangar-tabs');
  tabs.querySelectorAll<HTMLButtonElement>('.bay-tab').forEach(tab => {
    const isActive = active.kind === 'stock' ? tab.dataset.ship === active.id : tab.dataset.build === active.id;
    tab.classList.toggle('active', isActive);
  });
  if (active.kind === 'stock') {
    profile.activeShip = active;
    bayShip = active.id;
    bay?.setShip(active.id);
    $('#hangar-ship').innerHTML = shipStatsHTML(active.id);
  } else {
    const build = profile.builds.find(entry => entry.id === active.id);
    if (!build) { setHangarShip({ kind: 'stock', id: bayShip }); return; }
    profile.activeShip = active;
    bay?.setCustom(buildFromParts(build));
    $('#hangar-ship').innerHTML = buildStatsHTML(build);
  }
  save(profile);
}

/** The hangar's contract board: every job, its danger, its pay, and what is still locked. */
function renderContractBoard() {
  const board = $('#contract-board');
  board.innerHTML = CONTRACTS.map(contract => {
    const lock = lockedBy(contract, profile);
    const done = profile.completed.includes(contract.id);
    return `<button class="contract-card ${contract.id === selectedContract.id ? 'active' : ''} ${lock ? 'locked' : ''}" data-contract="${contract.id}">
      <span class="contract-card-top"><span class="contract-kind">${contract.kicker}</span><span class="danger-pips" title="Danger ${contract.danger} of 3">${[0, 1, 2].map(step => `<i class="${step < contract.danger ? 'hot' : ''}"></i>`).join('')}</span></span>
      <b>${contract.title}</b>
      <small>${contract.kind === 'salvage' ? 'Salvage' : contract.kind === 'mining' ? 'Mining' : contract.kind === 'bounty' ? 'Combat' : contract.kind === 'escort' ? 'Escort' : 'Survey'} · ${contract.payout.toLocaleString()} cr${contract.bonus ? ` + ${contract.bonus.credits.toLocaleString()} bonus` : ''}</small>
      ${lock ? `<span class="contract-lock">Locked · finish ${lock.title}</span>` : done ? '<span class="contract-done">Completed</span>' : ''}
    </button>`;
  }).join('');
  board.querySelectorAll<HTMLButtonElement>('[data-contract]').forEach(button => button.addEventListener('click', () => {
    const contract = CONTRACTS.find(entry => entry.id === button.dataset.contract);
    if (!contract) return;
    const lock = lockedBy(contract, profile);
    if (lock) { toast(`${contract.title} is locked until ${lock.title} is complete.`); sound.ping(); return; }
    selectedContract = contract;
    renderContractBoard();
    renderContractBrief();
    sound.ping();
  }));
}

/** The selected contract's stages, read straight off the contract data. */
function renderContractBrief() {
  $('#hangar-title').textContent = selectedContract.title;
  $('#hangar-brief').textContent = selectedContract.brief;
  const timeLimit = selectedContract.timeLimit ? `<div><span>⏱</span><p><strong>Window</strong> — ${Math.round(selectedContract.timeLimit / 60)} minutes from launch.</p></div>` : '';
  $('#hangar-stages').innerHTML = selectedContract.stages.map((entry, index) =>
    `<div><span>${index + 1}</span><p><strong>${entry.title}</strong> — ${entry.objectives.map(objective => objective.label).join('; ')}.</p></div>`).join('') + timeLimit
    + (selectedContract.bonus ? `<div><span>★</span><p><strong>Bonus</strong> — ${selectedContract.bonus.label}, ${selectedContract.bonus.credits.toLocaleString()} cr.</p></div>` : '');
}

function setFlowClass() {
  const shell = $('.game-shell');
  for (const name of ['flow-title', 'flow-hangar', 'flow-builder', 'flow-launch', 'flow-flight']) shell.classList.remove(name);
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
  openDialog(`<span class="dialog-kicker">Flight school</span><h2 id="dialog-title">Space doesn’t have brakes.</h2><p class="dialog-description">Your engines change your velocity. Your thrusters change your heading. Learn to use them independently, and the belt is yours.</p><div class="manual-feature"><span class="manual-orbit">${icon('flight')}</span><div><strong>Burn. Coast. Counterburn.</strong><p>Point at your target and hold W to accelerate. Release W to coast. Hold X to fire braking thrusters before you arrive. Rotating alone won’t change where you’re going.</p></div></div><div class="manual-feature"><span class="manual-orbit">${icon('target')}</span><div><strong>Guns and rock.</strong><p>Move the mouse to aim: turrets traverse inside their arc and rounds inherit your velocity. Space fires the primary mounts, C runs the mining cutter — short, thirsty, and four times as fast through asteroid. Every shot adds drive heat, so the limiter is your rate of fire.</p></div></div><div class="manual-grid"><div><kbd>W</kbd><kbd>S</kbd><span>Main / reverse thrust</span></div><div><kbd>A</kbd><kbd>D</kbd><span>Rotate left / right</span></div><div><kbd>Q</kbd><kbd>E</kbd><span>Strafe left / right</span></div><div><kbd>Shift</kbd><span>Hard burn · more heat</span></div><div><kbd>Space</kbd><span>Fire primary mounts</span></div><div><kbd>C</kbd><span>Mining cutter</span></div><div><kbd>Mouse</kbd><span>Aim the turrets</span></div><div><kbd>X</kbd><span>Braking thrusters</span></div><div><kbd>F</kbd><span>Attitude assist</span></div><div><kbd>R</kbd><span>Scan, recover, dock</span></div><div><kbd>M</kbd><span>Sector chart</span></div><div><kbd>Esc</kbd><span>Pause</span></div></div><div class="manual-mission"><strong>Contract ${CONTRACTS[0].id} · ${CONTRACTS[0].title}</strong><p>Pull the relay telemetry first: it resolves the archive contacts. Hold station inside the scan envelope to resolve a contact, then close to 75 m and slow under 12 m/s to bring it aboard. Wayfarer pays on delivery — and pays extra for the black box still aboard the wreck of Kite’s End.</p></div><button class="primary-button" id="manual-close">Understood ${icon('check')}</button>`);
  $('#manual-close').addEventListener('click', closeDialog);
}

function resetSortie(shipClass: ShipClass = state.shipClass, build?: Build) {
  if (build) {
    const spec = buildSpec(build);
    const model = buildFromParts(build);
    const stats = derive(build);
    state = createShip(shipClass, spec, colliderFor(model));
    scene.setShip(model);
    mounts = stats.mounts.map(mount => ({ spec: WEAPONS[mount.weapon], lx: mount.lx, ly: mount.ly, cooldown: 0, bearing: 0 }));
    sortieBuild = build;
    $('#ship-name').textContent = build.name;
    $('#player-name').textContent = build.name;
    $('#ship-role').textContent = CORES[build.core]?.name ?? 'Custom build';
  } else {
    state = createShip(shipClass);
    scene.changeShip(shipClass);
    buildMounts(shipClass);
    state.collider = colliderFor(scene.ship, 1);
    sortieBuild = undefined;
    $('#ship-name').textContent = SHIPS[shipClass].name;
    $('#player-name').textContent = SHIPS[shipClass].name;
    $('#ship-role').textContent = SHIPS[shipClass].role;
  }
  cargos = createCargo();
  scene.resetCargo(cargos);
  run = createRun(selectedContract);
  navTarget = undefined;
  scene.launch = 1; scene.cinematic = false;
  for (const hostile of hostiles) scene.removeHostile(hostile.id);
  for (const ally of [...allies]) removeAlly(ally.id);
  hostiles = []; pendingBounty = 0;
  for (const rock of [...fragments]) { grid.remove(rock); scene.removeRock(rock.id); }
  fragments.length = 0; ore.length = 0; oreHeld = 0; firing = false; mining = false; aimFromPointer = false;
  for (const rock of obstacles) {
    grid.remove(rock); rock.hp = rock.maxHp; grid.add(rock);
    scene.removeRock(rock.id); scene.spawnRock(rock);
  }
  scene.setDamage(1);
  lastHitTime = -1;
  counters.hostilesKilled = 0; counters.rocksBroken = 0; counters.oreHeld = 0; counters.brokenRadii.length = 0;
  lastPodFill = -1;
  for (let i = 0; i < MAX_ROUNDS; i++) rounds.life[i] = 0;
  targetId = 'relay'; elapsed = 0; crashed = false; brakeLatched = false; accumulator = 0; burnLimit = 1; lastCollisionNotice = -10; launchTimer = 0;
  lastEarnings = undefined;
  $<HTMLInputElement>('#throttle').value = '100'; $('#limiter-value').textContent = '100%';
  $('#camera-button').classList.remove('active');
  // The first stage's banner and spawns are delivered by the first updateRun step.
  applySignals(updateRun(run, world(), 0));
  setPaused(false); setView(false); updateContacts(); updateMissionPanel(); updateAssist();
}

const POD_EMPTY = new Color('#2d4a5c');
const POD_FULL = new Color('#9fe0b6');
let lastPodFill = -1;

/** Custom builds carry ore pods; their fill strip brightens with the hold. Stock hulls have none. */
function applyPodFill(fill: number) {
  const stepped = Math.round(fill * 16) / 16;
  if (stepped === lastPodFill) return;
  lastPodFill = stepped;
  const ship = scene.ship;
  if (!('pods' in ship)) return;
  for (const pod of ship.pods) {
    const material = pod.material as THREE.MeshStandardMaterial;
    if (Array.isArray(material) || !material.color) continue;
    material.color.lerpColors(POD_EMPTY, POD_FULL, stepped);
    material.emissive?.copy(POD_FULL).multiplyScalar(stepped * 0.35);
  }
}

/** The head chip: remaining time on a timed contract, otherwise the stage position. */
function runChipText(): string {
  if (run.failed) return 'Failed';
  if (run.complete) return 'Contract complete';
  const limit = run.contract.timeLimit;
  if (limit) {
    const left = Math.max(0, limit - run.elapsed);
    return `Window ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  }
  return `Stage ${run.stageIndex + 1} of ${run.contract.stages.length}`;
}

/** The one number a stage lives or dies by, shown beside the progress track. */
function runCounter(): string {
  const objectives = stage(run).objectives;
  const recover = objectives.find(objective => objective.kind === 'recover');
  if (recover && recover.kind === 'recover') {
    const wanted = new Set(run.contract.stages.flatMap(entry => entry.objectives).filter(objective => objective.kind === 'recover').map(objective => objective.kind === 'recover' ? objective.cargo : ''));
    const collected = cargos.filter(cargo => wanted.has(cargo.id) && cargo.collected).length;
    return `${collected} <span>/ ${wanted.size}</span>`;
  }
  const collect = objectives.find(objective => objective.kind === 'collect');
  if (collect && collect.kind === 'collect') return `${Math.round(counters.oreHeld)} <span>/ ${collect.amount}</span>`;
  const destroy = objectives.find(objective => objective.kind === 'destroy');
  if (destroy && destroy.kind === 'destroy') {
    const since = destroy.what === 'hostile'
      ? counters.hostilesKilled
      : counters.brokenRadii.filter(radius => radius >= (destroy.minRadius ?? 0)).length;
    return `${since} <span>/ ${destroy.count}</span>`;
  }
  return `${Math.min(run.stageIndex + 1, run.contract.stages.length)} <span>/ ${run.contract.stages.length}</span>`;
}

function updateMissionPanel() {
  $('#contract-id').textContent = `Contract ${run.contract.id}`;
  $('#mission-title').textContent = run.contract.title;
  $('#cargo-count').innerHTML = runCounter();
  const summary = objectiveSummary(run);
  const stageShare = summary.length ? summary.reduce((total, row) => total + row.progress, 0) / summary.length : 0;
  const overall = (run.stageIndex + stageShare) / run.contract.stages.length;
  $('#mission-bar').style.width = `${clamp(run.complete ? 1 : overall, 0, 1) * 100}%`;
  $('#stage-rows').innerHTML = run.contract.stages.map((entry, index) => {
    const current = index === run.stageIndex && !run.complete;
    const done = run.complete || index < run.stageIndex;
    const detail = current
      ? summary.filter(row => entry.objectives.some(objective => row.label === objective.label))
        .map(row => `${row.done ? '✓ ' : ''}${row.label}${row.progress > 0 && row.progress < 1 ? ` (${Math.round(row.progress * 100)}%)` : ''}`).join(' · ')
      : done ? 'Complete' : entry.objectives.map(objective => objective.label).join(' · ');
    return `<div class="stage-row ${done ? 'complete' : ''} ${current ? 'current' : ''}"><span class="stage-node"></span><strong>${entry.title}</strong><small>${detail}</small></div>`;
  }).join('') + (run.contract.bonus ? (() => {
    const bonusRow = summary[summary.length - 1];
    return `<div class="stage-row optional ${bonusRow.done ? 'complete' : ''}"><span class="stage-node"></span><strong>${run.contract.bonus.label}</strong><small>${bonusRow.done ? 'Secured' : `Bonus · ${run.contract.bonus.credits.toLocaleString()} cr`}</small></div>`;
  })() : '');
  $('#stage-chip').textContent = runChipText();
  const name = navTarget ? navTarget.name : contactName(targetId);
  $('#objective-button').setAttribute('aria-label', run.complete ? 'Contract complete' : `Track ${name}`);
  $<HTMLButtonElement>('#objective-button').disabled = run.complete || Boolean(run.failed);
}

function applySignals(signals: RunSignal[]) {
  if (!signals.length) return;
  // Navigation must see entities spawned by this stage before choosing a destination.
  for (const signal of signals) {
    if (signal.type === 'spawn') spawnFromSpec(signal.spec);
    if (signal.type === 'escort') spawnEscort(signal.spec);
  }
  for (const signal of signals) {
    if (signal.type === 'stage') {
      banner(signal.stage.title, signal.stage.banner ?? signal.stage.objectives.map(objective => objective.label).join(' · '));
      toast(`${run.contract.title} — ${signal.stage.title}.`);
      navTarget = suggestTarget(run, world());
      if (navTarget) targetId = navTarget.id;
      sound.ping();
    }
    if (signal.type === 'scan') {
      toast(`${signal.cargo.name} resolved. Hold station for recovery.`);
      sound.ping();
    }
    if (signal.type === 'objective') {
      toast(`${signal.objective.label} — complete.`);
      sound.ping();
    }
    if (signal.type === 'recovered') {
      scene.recover(signal.cargo);
      toast(`${signal.cargo.name} secured. ${signal.remaining > 0 ? `${signal.remaining} left to recover.` : 'That is the last of them.'}`);
      sound.ping();
    }
    if (signal.type === 'complete') finishContract(signal.payout);
    if (signal.type === 'failed') failContract(signal.reason);
  }
  updateContacts(); updateMissionPanel();
}

/** A contract's scripted ambush, placed around whatever the objective points at. */
function spawnFromSpec(spec: SpawnSpec) {
  const at = resolveTarget(world(), spec.near);
  if (!at) return;
  spawnHostiles(spec.kind, at, spec.count, spec.spread, spec.reaction);
}

/** An escort stage hands over a barge and the route it will fly, with or without the player. */
function spawnEscort(spec: EscortSpec) {
  const at = resolveTarget(world(), spec.at);
  if (!at) return;
  for (const ally of [...allies]) removeAlly(ally.id);
  const route = spec.route.map(ref => resolveTarget(world(), ref)).filter((point): point is Vec2 => Boolean(point));
  const ally = createAlly(spec.id, spec.name, at, route, spec.hull);
  allies.push(ally);
  const model = buildShip('mule');
  for (const child of [...model.group.children]) if (child.name === 'stock-weapon') disposeObject(child);
  model.group.position.set(at.x, at.y, 0);
  model.group.scale.setScalar(SHIP_SCALE);
  model.group.updateMatrixWorld(true);
  allyModels.set(ally.id, model);
  scene.scene.add(model.group);
  updateContacts();
  toast(`${ally.name} is under way. Stay with her — she cannot fight.`);
  sound.ping();
}

function removeAlly(id: string) {
  const index = allies.findIndex(ally => ally.id === id);
  if (index >= 0) allies.splice(index, 1);
  const model = allyModels.get(id);
  if (model) { disposeObject(model.group); allyModels.delete(id); }
}

function stepAllies(dt: number) {
  for (const ally of allies) {
    const before = ally.state.hull;
    grid.near(ally.state.position.x, ally.state.position.y, nearby);
    stepAlly(ally, dt, nearby.filter(rock => rock.z === 0));
    grid.near(ally.state.position.x, ally.state.position.y, nearby);
    for (const rock of nearby) resolveCollision(ally.state, rock);
    const model = allyModels.get(ally.id);
    if (model) {
      model.group.position.set(ally.state.position.x, ally.state.position.y, 0);
      model.group.rotation.z = ally.state.angle;
      for (const flame of model.flames) flame.visible = ally.state.acceleration > 0.05;
    }
    if (before > ally.state.hull && ally.state.hull > 0) {
      toast(`${ally.name} is taking fire — hull ${Math.round(ally.state.hull / ally.maxHull * 100)}%.`);
      sound.ping();
    }
    if (ally.lost && model) model.group.visible = false;
  }
}

/** Everything hostile fire may hit on the player's side. */
function friendlyTargets(): ShipState[] {
  return [state, ...allies.filter(ally => !ally.lost).map(ally => ally.state)];
}

function updateAssist() {
  $('#assist-button').classList.toggle('active', state.assist); $('#assist-button').setAttribute('aria-pressed', String(state.assist));
  $('#assist-button').classList.toggle('is-live', state.assist);
  $('#assist-status').textContent = state.assist ? 'on' : 'off';
}
function toggleAssist() { state.assist = !state.assist; updateAssist(); toast(state.assist ? 'Attitude assist on. Thrusters stop rotation when released.' : 'Attitude assist off. Angular momentum is conserved.'); }

function updateHUD(now: number) {
  updateMissionPanel();
  const speed = length(state.velocity);
  const spec = state.spec;
  const hull = state.hull / spec.hull * 100, fuel = state.fuel / spec.fuel * 100, heat = state.heat * 100;
  $('#velocity-value').textContent = speed.toFixed(1); $('#motion-state').textContent = speed < 0.1 ? 'At rest' : state.acceleration > 0.1 ? 'Under thrust' : 'Coasting';
  weigh($('.velocity'), speed > 0.5 ? 'live' : 'dormant', false);
  $('#velocity-fill').style.width = `${Math.min(100, speed / 200 * 100)}%`;
  $('#heading-value').innerHTML = `${String(Math.round(heading(state.angle)) % 360).padStart(3, '0')}<small>°</small>`;
  $('#turn-rate').innerHTML = `${(-state.angularVelocity * 180 / Math.PI).toFixed(1)}<small> °/s</small>`;
  $('#accel-value').innerHTML = `${(state.acceleration / 9.81).toFixed(2)}<small> g</small>`;
  $('#drive-state').textContent = state.thrustLevel > 1 ? 'Hard burn' : state.thrustLevel > 0 ? 'Burning' : state.rcsActive || state.thrustLevel < 0 ? 'RCS active' : 'Standby';
  $('#hull-value').innerHTML = `${Math.ceil(hull)}<small>%</small>`; $('#hull-bar').style.width = `${hull}%`;
  scene.setDamage(clamp(hull / 100, 0, 1));
  weighBar($('#readout-hull'), hull < 60, hull < 25);
  $('#fuel-value').innerHTML = `${fuel.toFixed(0)}<small>%</small>`; $('#fuel-bar').style.width = `${fuel}%`;
  weighBar($('#readout-prop'), fuel < 35, fuel < 12);
  $('#heat-value').innerHTML = `${heat.toFixed(0)}<small>%</small>`; $('#heat-bar').style.width = `${heat}%`;
  weighBar($('#readout-heat'), heat > 55, heat > 92);
  $('#mass-value').textContent = `${((spec.mass + state.fuel) / 1000).toFixed(1)} t`;
  const capacity = spec.cargo;
  const fill = clamp(oreHeld / Math.max(1, capacity), 0, 1);
  $('#hold-value').innerHTML = `${Math.round(oreHeld)}<small>/${capacity}</small>`;
  weighBar($('#readout-hold'), oreHeld > 0, capacity > 0 && oreHeld >= capacity);
  $('#hold-bar').style.width = `${fill * 100}%`;
  applyPodFill(fill);
  $('#weapons-strip').innerHTML = mounts.length
    ? mounts.map(mount => `<span class="${mount.cooldown > 0.05 ? 'cooling' : ''}">${mount.spec.name.replace(/^(AC-\d+|Gauss lance|Mining cutter|Swarm rack).*/, '$1')}</span>`).join('')
    : '<span>unarmed</span>';
  $('#weapons-strip').classList.toggle('hot', heat > 92);
  $('#weapons-strip').classList.toggle('is-critical', heat > 92);
  const engaging = hostiles.some(hostile => hostile.mode === 'attack');
  announceState(hull, fuel, heat, engaging);
  const session = $('.session');
  session.classList.toggle('under-fire', engaging);
  session.classList.toggle('is-critical', engaging);
  session.classList.toggle('is-paused', paused);
  $('#stage-chip').classList.toggle('under-fire', engaging);
  $('#stage-chip').textContent = engaging ? 'Under fire' : runChipText();
  $('#session-time').textContent = `T+ ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
  $('#player-mode').textContent = `${callsign} · ${speed < 0.1 ? 'Holding position' : state.thrustLevel > 0 ? 'Main drive active' : state.rcsActive ? 'Maneuvering' : 'Ballistic coast'}`;
  const target = getTarget();
  const enemy = hostiles.find(hostile => `hostile-${hostile.id}` === targetId);
  $('#target-telemetry').hidden = !enemy || scene.cinematic || flow !== 'flight';
  if (enemy) {
    const hull = clamp(enemy.state.hull / HOSTILES[enemy.kind].hull, 0, 1);
    $('#combat-target-name').textContent = hostileLabel(enemy);
    $('#combat-target-hull').textContent = `${Math.ceil(hull * 100)}%`;
    $('#combat-target-bar').style.width = `${hull * 100}%`;
    const range = distance(state.position, enemy.state.position);
    const reachable = mounts.some(mount => mount.spec.kind !== 'beam' && mount.spec.range >= range);
    $('#combat-target-range').textContent = `${formatDistance(range)} · ${reachable ? 'Weapons in range' : 'Close to weapons range'} · Tab cycles`;
  }
  $('#target-summary').textContent = targetName();
  $('#target-range').textContent = target ? formatDistance(distance(state.position, target)) : '—';
  const maxBrake = spec.thrust / (spec.mass + state.fuel) * 0.65;
  const stoppingDistance = speed * speed / (2 * maxBrake);
  const tooFast = !!target && stoppingDistance > distance(state.position, target) - 40 && speed > 12;
  $('#target-speed').textContent = tooFast ? 'Brake for approach' : speed > 0.5 ? `Stopping distance ${formatDistance(stoppingDistance)}` : 'Target selected';
  $('.navigation-info').classList.toggle('approach-warning', tooFast);
  const recoverable = interactive(run, world());
  const canDockNow = dockable(run, world());
  const interactButton = $<HTMLButtonElement>('#interact-button');
  const scanning = activeScan();
  const prompt = $('#action-prompt');
  const fullHold = capacity > 0 && oreHeld >= capacity;
  const urgent = state.fuel <= 0 || tooFast || fullHold;
  interactButton.hidden = !(recoverable || canDockNow || scanning);
  interactButton.disabled = !!scanning && !(recoverable || canDockNow);
  interactButton.innerHTML = scanning ? `Scanning ${Math.round(scanning.progress * 100)}%` : recoverable ? `${recoverable.kind === 'blackbox' ? 'Recover black box' : 'Recover archive'} <kbd>R</kbd>` : `Dock at Wayfarer <kbd>R</kbd>`;
  $('#flight-tip').textContent = state.fuel <= 0 ? 'Propellant exhausted — return to the hangar to relaunch.'
    : tooFast ? 'Too fast for approach — hold X to brake.'
    : fullHold ? 'Hold full. Dock at Wayfarer to sell ore, repair and refuel.'
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

type Weight = 'dormant' | 'live' | 'critical';

/** The canvas ring is invisible to assistive technology, so the same state is announced in words. */
const announced = { hull: 'nominal', prop: 'nominal', heat: 'nominal', threat: false };

function announce(message: string) {
  const region = $('#hud-status');
  if (region.textContent === message) return;
  region.textContent = message;
}

function announceState(hull: number, prop: number, heat: number, engaged: boolean) {
  const hullState = hull < 25 ? 'critical' : hull < 60 ? 'low' : 'nominal';
  if (hullState !== announced.hull) {
    announced.hull = hullState;
    if (hullState !== 'nominal') announce(`Hull ${hullState}, ${Math.ceil(hull)} percent.`);
  }
  const propState = prop < 12 ? 'critical' : prop < 35 ? 'low' : 'nominal';
  if (propState !== announced.prop) {
    announced.prop = propState;
    if (propState !== 'nominal') announce(`Propellant ${propState}, ${Math.round(prop)} percent.`);
  }
  const heatState = heat > 92 ? 'critical' : heat > 55 ? 'high' : 'nominal';
  if (heatState !== announced.heat) {
    announced.heat = heatState;
    if (heatState !== 'nominal') announce(`Drive heat ${heatState}, ${Math.round(heat)} percent.`);
  }
  if (engaged !== announced.threat) {
    announced.threat = engaged;
    announce(engaged ? 'Under fire.' : 'No hostiles engaging.');
  }
}

/** Every readout gets its weight from the value, not from where it sits on the glass. */
function weigh(element: HTMLElement, weight: Weight, critical = false) {
  const state = critical ? 'critical' : weight;
  element.classList.toggle('is-live', state === 'live');
  element.classList.toggle('is-critical', state === 'critical');
}

function weighBar(element: HTMLElement, live: boolean, critical: boolean) {
  weigh(element, live ? 'live' : 'dormant', critical);
}

/** The bearing ring: one instrument carrying velocity, the target, threats, contacts and the drive. */
function updateCollar(now: number) {
  if (!collar) return;
  const bounds = $('#space-canvas').getBoundingClientRect();
  const short = Math.min(bounds.width, bounds.height);
  const small = bounds.width <= 720;
  const marks = collarMarks;
  marks.length = 0;
  const speed = length(state.velocity);
  if (speed > 0.05) marks.push({ bearing: Math.atan2(state.velocity.y, state.velocity.x), range: 0, kind: 'velocity', strength: 1 });
  const target = getTarget();
  if (target) {
    marks.push({
      bearing: Math.atan2(target.y - state.position.y, target.x - state.position.x),
      range: distance(state.position, target), kind: 'target', strength: 1,
    });
  }
  for (const hostile of hostiles) {
    const range = distance(state.position, hostile.state.position);
    marks.push({
      bearing: Math.atan2(hostile.state.position.y - state.position.y, hostile.state.position.x - state.position.x),
      range, kind: 'hostile', strength: clamp(1 - range / 1800, 0.15, 1),
    });
  }
  const listed = contacts();
  for (const contact of listed) {
    if (contact.hostile || !contact.known) continue;
    if (allies.some(ally => ally.id === contact.id)) continue;
    const range = distance(state.position, contact.position);
    if (range > 900) continue;
    marks.push({
      bearing: Math.atan2(contact.position.y - state.position.y, contact.position.x - state.position.x),
      range, kind: 'contact', strength: clamp(1 - range / 900, 0.2, 1),
    });
  }
  for (const ally of allies) {
    const range = distance(state.position, ally.state.position);
    if (range > 2400) continue;
    marks.push({
      bearing: Math.atan2(ally.state.position.y - state.position.y, ally.state.position.x - state.position.x),
      range, kind: 'contact', strength: clamp(1 - range / 2400, 0.25, 1),
    });
  }
  for (const chunk of ore) {
    const range = distance(state.position, chunk);
    if (range > 900) continue;
    marks.push({
      bearing: Math.atan2(chunk.y - state.position.y, chunk.x - state.position.x),
      range, kind: 'ore', strength: 0.5,
    });
  }
  collar.draw({
    marks,
    thrust: state.thrustLevel * (state.thrustLevel > 0 ? 1 : 1),
    heat: state.heat,
    radius: clamp(short * (small ? 0.33 : 0.29), small ? 96 : 150, small ? 180 : 260),
    reducedMotion: prefersReducedMotion(),
    time: now / 1000,
  });
}

/** The contact currently inside a scan envelope, with its progress, for HUD and world feedback. */
function activeScan() {
  if (run.complete || run.failed) return undefined;
  const speed = length(state.velocity);
  for (const id of activeCargoIds(run, world())) {
    const cargo = cargos.find(entry => entry.id === id);
    if (!cargo || cargo.collected || isScanned(run, cargo.id)) continue;
    const spec = scanSpec(cargo, state.spec.scanScale ?? 1);
    if (distance(state.position, cargo.position) < spec.radius && speed < spec.speed) {
      return { id: cargo.id, name: cargo.name, position: cargo.position, progress: scanProgress(run, cargo.id, spec) };
    }
  }
  // A hold objective shows the same ring: the pilot is inside the envelope and must stay there.
  for (const objective of stage(run).objectives) {
    if (objective.kind !== 'hold') continue;
    const at = resolveTarget(world(), objective.target);
    if (!at || progressOf(run, objective) >= 1) continue;
    if (distance(state.position, at) < objective.radius && speed < objective.speed) {
      return { id: `hold:${objective.label}`, name: objective.label, position: at, progress: progressOf(run, objective) };
    }
  }
  return undefined;
}

function updateLabels() {
  const bounds = $('#space-canvas').getBoundingClientRect();
  const mobile = bounds.width <= 700;
  const scan = activeScan();
  const listed = contacts();
  // Labels are placed in two passes: where the contact is, then pushed apart so a cluster of
  // raiders reads as four labels rather than one smudge of overlapping text.
  const placed: { id: string; marker: HTMLButtonElement; x: number; y: number; offscreen: boolean; point: { x: number; y: number; visible: boolean } }[] = [];
  for (const [id, marker] of markers) {
    const pos = targetPosition(id);
    if (!pos) continue;
    const point = scene.project(pos, 12);
    let x = point.x, y = point.y;
    // Markers live in the space the four corner clusters leave free.
    const left = mobile ? 24 : 46, right = bounds.width - (mobile ? 24 : 46);
    const top = mobile ? 156 : 140, bottom = bounds.height - (mobile ? 224 : 205);
    const offscreen = x < left || x > right || y < top || y > bottom;
    if (offscreen) { x = clamp(x, left, Math.max(left, right)); y = clamp(y, Math.min(top, bottom), bottom); }
    y = clamp(y, 34, bounds.height - 32);
    placed.push({ id, marker, x, y, offscreen, point });
  }
  placed.sort((a, b) => a.y - b.y || a.x - b.x);
  const settled: { x: number; y: number }[] = [];
  for (const entry of placed) {
    const near = settled.filter(other => Math.abs(other.x - entry.x) < 190);
    for (let guard = 0; guard < 8; guard++) {
      const clash = near.find(other => Math.abs(other.y - entry.y) < 34);
      if (!clash) break;
      entry.y = clash.y > entry.y ? clash.y - 34 : clash.y + 34;
      entry.y = clamp(entry.y, 34, bounds.height - 32);
    }
    settled.push({ x: entry.x, y: entry.y });
  }
  for (const { id, marker, x, y, offscreen, point } of placed) {
    marker.style.transform = `translate(${x}px, ${y}px)`;
    const left = mobile ? 24 : 40, right = bounds.width - (mobile ? 24 : 40);
    marker.classList.toggle('edge-right', offscreen && x >= right - 1);
    marker.classList.toggle('edge-left', offscreen && x <= left + 1);
    marker.hidden = (!point.visible && !offscreen) || scene.cinematic;
    marker.classList.toggle('offscreen', offscreen);
    marker.style.setProperty('--bearing', `${Math.atan2(point.y - bounds.height / 2, point.x - bounds.width / 2) + Math.PI / 2}rad`);
    const shape = marker.querySelector<HTMLElement>('.marker-shape')!;
    shape.dataset.offscreen = String(offscreen);
    const contact = listed.find(item => item.id === id)!;
    const range = formatDistance(distance(state.position, targetPosition(id) ?? state.position));
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
    contacts: [
      ...contacts().map(contact => ({
        id: contact.id,
        kind: contact.hostile ? 'hostile' as const : allies.some(ally => ally.id === contact.id) ? 'ally' as const : contact.id === 'station' ? 'station' as const : contact.id === 'relay' ? 'beacon' as const : contact.id === 'derelict' ? 'derelict' as const : 'cargo' as const,
        position: contact.position,
        known: contact.known,
        collected: cargos.find(cargo => cargo.id === contact.id)?.collected,
        selected: contact.id === targetId,
        angle: contact.hostile?.state.angle ?? allies.find(ally => ally.id === contact.id)?.state.angle,
      })),
      ...ore.slice(0, 40).map(chunk => ({ id: `ore-${chunk.id}`, kind: 'ore' as const, position: { x: chunk.x, y: chunk.y }, known: true, selected: false })),
    ],
    rocks: planarRocks.filter(rock => rock.hp > 0),
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
      if (paused || modalOpen || crashed || run.complete || run.failed) { accumulator = 0; break; }
    }
  } else accumulator = 0;
  if (aimFromPointer) aim = scene.unproject(pointerAim.x, pointerAim.y);
  else {
    const tracked = hostiles.find(hostile => `hostile-${hostile.id}` === targetId);
    const lead = tracked ? distance(state.position, tracked.state.position) / (mounts[0]?.spec.speed || 620) : 0;
    aim = tracked ? { x: tracked.state.position.x + (tracked.state.velocity.x - state.velocity.x) * lead, y: tracked.state.position.y + (tracked.state.velocity.y - state.velocity.y) * lead }
      : { x: state.position.x - Math.sin(state.angle) * 600, y: state.position.y + Math.cos(state.angle) * 600 };
  }
  if (flow !== 'hangar' && flow !== 'builder' && !(modalOpen && bay)) {
    scene.render({
      state, cargos, target: getTarget() ? { id: targetId, position: getTarget()! } : undefined,
      scanning: activeScan(), rounds, beams: beamVisuals, ore, aim, mounts, hostiles,
      dt: stopped ? 0 : delta, time: now / 1000,
    });
  }
  $('#hit-confirm').classList.toggle('active', elapsed - lastHitTime < 0.14);
  updateLabels();
  if (now - lastHUD > 85) { updateHUD(now); updateCollar(now); }
  updateRadar(now);
  sound.update(Math.abs(state.thrustLevel), stopped);
}

function stepSimulation(input: FlightInput, dt: number) {
  const before = state.hull;
  setStationSpin(scene.stationAngle);
  stepShip(state, input, dt);
  elapsed += dt;
  grid.near(state.position.x, state.position.y, nearby);
  for (const rock of nearby) resolveCollision(state, rock);
  resolveBodies(state, dockable(run, world()));
  if (before - state.hull > 2 && elapsed - lastCollisionNotice > 2) {
    const damage = before - state.hull;
    scene.impact(state.position, clamp(damage / 22, 0.35, 1.4));
    scene.hitFlashShip(Math.atan2(-state.velocity.y, -state.velocity.x));
    flashDamage(clamp(damage / 30, 0.3, 1));
    toast(`Impact detected. Hull integrity ${Math.ceil(state.hull / state.spec.hull * 100)}%.`);
    lastCollisionNotice = elapsed;
  }
  stepAllies(dt);
  stepHostiles(dt);
  const ships = [state, ...allies.filter(ally => !ally.lost).map(ally => ally.state), ...hostiles.filter(hostile => hostile.kind !== 'mine').map(hostile => hostile.state)];
  for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) {
    const impact = resolveShipCollision(ships[i], ships[j]);
    if (impact.damageA > 2 || impact.damageB > 2) scene.impact(ships[i].position, Math.min(1, impact.relativeSpeed / 60));
  }
  stepWeapons(dt);
  for (let i = hostiles.length - 1; i >= 0; i--) if (hostiles[i].state.hull <= 0) {
    const hostile = hostiles.splice(i, 1)[0];
    killHostile(hostile);
  }
  for (const ally of allies) if (ally.state.hull <= 0) ally.lost = true;
  applySignals(updateRun(run, world(), dt));
  if (state.hull <= 0 || state.fuel <= 0) {
    crashed = true; keys.clear();
    openDialog(`<span class="dialog-kicker">Flight terminated</span><h2 id="dialog-title">${state.hull <= 0 ? 'The belt leaves a mark.' : 'Running on empty.'}</h2><p class="dialog-description">${state.hull <= 0 ? 'Your hull could not survive the impact. Watch your stopping distance and begin the counterburn well before the next rock.' : 'Your propellant is exhausted. Coast between burns and visit Wayfarer to refuel.'}</p><button class="primary-button" id="restart-button">Return to hangar ${icon('reset')}</button><button class="ghost-button" id="retry-button">Relaunch same ship</button>`);
    $('#restart-button').addEventListener('click', () => { closeDialog(); showHangar(); });
    $('#retry-button').addEventListener('click', () => { resetSortie(state.shipClass, sortieBuild); closeDialog(); launchSequence(); });
  }
}

function flashDamage(strength: number) {
  const element = $('#damage-flash');
  element.style.setProperty('--flash', String(clamp(strength, 0.25, 1)));
  element.classList.remove('visible');
  void element.offsetWidth;
  element.classList.add('visible');
}

function collapseBeams() {
  for (const entry of beamVisuals) { entry.x = 0; entry.y = 0; entry.ex = 0; entry.ey = 0; entry.hot = false; }
}

/** Guns, beams, ore and fragments all step inside the fixed 120 Hz step, never in `frame`. */
function stepWeapons(dt: number) {
  if (flow === 'flight' && !paused && !modalOpen) {
    fireMounts(mounts, state, aim, firing, rounds, 0, SHIP_SCALE, dt, (mx, my) => { scene.hitFlash(mx, my); sound.shot('kinetic'); });
    const beams = stepBeams(mounts, state, grid, mining, SHIP_SCALE, dt);
    // The pool is preallocated: fill it and collapse the unused slots to zero-length.
    for (let i = 0; i < beamVisuals.length; i++) {
      const entry = beamVisuals[i];
      const beam = beams[i];
      if (!beam) { entry.x = 0; entry.y = 0; entry.ex = 0; entry.ey = 0; entry.hot = false; continue; }
      entry.x = beam.x; entry.y = beam.y; entry.ex = beam.ex; entry.ey = beam.ey; entry.hot = !!beam.rock;
    }
    for (const beam of beams) {
      if (!beam.rock) continue;
      if (beam.destroyed) breakRock(beam.rock);
      else scene.hitFlash(beam.ex, beam.ey);
    }
  } else collapseBeams();
  combatTargets(state, hostiles, allies, aimTargets);
  for (const hit of stepRounds(rounds, grid, aimTargets, dt, SOLID_BODIES)) applyHit(hit);
  stepFragments(fragments, grid, dt);
  const scooped = stepOre(ore, state, dt, ORE_PICKUP_RADIUS * Math.min(5, state.spec.collectScale ?? 1), Math.max(0, state.spec.cargo - oreHeld));
  if (scooped > 0) { oreHeld += scooped; counters.oreHeld += scooped; }
}

function applyHit(hit: Hit) {
  if (hit.kind === 'rock') {
    scene.hitFlash(hit.x, hit.y);
    if (hit.destroyed) breakRock(hit.rock);
    return;
  }
  if (hit.kind === 'body') {
    scene.hitFlash(hit.x, hit.y);
    return;
  }
  if (hit.kind === 'ship') {
    scene.hitFlash(hit.x, hit.y);
    if (hit.target === state) { flashDamage(0.5); scene.hitFlashShip(Math.atan2(hit.y - state.position.y, hit.x - state.position.x)); }
    else if (hostiles.some(hostile => hostile.state === hit.target)) {
      lastHitTime = elapsed;
      const point = scene.project({ x: hit.x, y: hit.y }, 8);
      $('#hit-confirm').style.left = `${point.x}px`; $('#hit-confirm').style.top = `${point.y}px`;
    }
  }
}

function breakRock(rock: Obstacle) {
  if (!scene.rocks.has(rock.id)) return;
  rock.hp = 0;
  counters.brokenRadii.push(rock.radius);
  const { fragments: pieces, ore: drops } = fractureRock(rock, () => nextRockId++);
  grid.remove(rock);
  scene.dissolveRock(rock.id);
  for (const piece of pieces) { grid.add(piece); scene.spawnRock(piece); fragments.push(piece); }
  for (const drop of drops) ore.push(drop);
  scene.explode(rock.x, rock.y, rock.radius);
  sound.boom();
  counters.rocksBroken++;
}

function buildMounts(shipClass: ShipClass) {
  const defs = STOCK_MOUNTS[shipClass];
  mounts = defs.map(def => ({ spec: WEAPONS[def.weapon], lx: def.lx, ly: def.ly, cooldown: 0, bearing: 0 }));
  scene.setGunMounts(defs);
}

function hostileLabel(hostile: Hostile) {
  return hostile.kind === 'raider' ? 'Raider' : hostile.kind === 'interceptor' ? 'Interceptor' : hostile.kind === 'turret' ? 'Turret' : 'Mine';
}

function spawnHostiles(kind: HostileKind, near: Vec2, count: number, spread: number, reaction?: number) {
  for (let i = 0; i < count; i++) {
    const angle = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.7;
    const radius = spread * (0.35 + Math.random() * 0.65);
    const hostile = createHostile(nextHostileId++, kind, { x: near.x + Math.cos(angle) * radius, y: near.y + Math.sin(angle) * radius });
    if (reaction !== undefined) hostile.reaction = reaction;
    grid.near(hostile.state.position.x, hostile.state.position.y, nearby);
    for (const rock of nearby) resolveBounceFree(hostile.state, rock);
    hostiles.push(hostile);
    scene.addHostile(hostile);
    const model = scene.hostileModels.get(hostile.id);
    if (model) {
      const savedPosition = model.group.position.clone(), savedAngle = model.group.rotation.z;
      model.group.position.set(0, 0, 0); model.group.rotation.z = 0;
      hostile.state.collider = colliderFor(model, 1);
      model.group.position.copy(savedPosition); model.group.rotation.z = savedAngle;
    }
  }
  updateContacts();
  toast(count === 1 ? `${hostileLabel({ kind } as Hostile)} on scope.` : `${count} contacts on scope — ${hostileLabel({ kind } as Hostile).toLowerCase()}s inbound.`);
  sound.ping();
}

/** Pushes a new hostile out of any rock it spawned inside, without damaging it. */
function resolveBounceFree(ship: ShipState, rock: Obstacle) {
  if (!obbCircleOut(shipBox(ship), rock.x, rock.y, rock.radius * 0.92, spawnPush)) return;
  ship.position.x += spawnPush.x;
  ship.position.y += spawnPush.y;
}

function stepHostiles(dt: number) {
  const friendlies = friendlyTargets();
  for (let i = hostiles.length - 1; i >= 0; i--) {
    const hostile = hostiles[i];
    if (hostile.kind === 'mine') stepMine(hostile, dt);
    else stepHostile(hostile, friendlies, rounds, grid, dt);
    if (hostile.state.hull <= 0) {
      killHostile(hostile);
      hostiles.splice(i, 1);
    }
  }
}

/** Mines drift and detonate on proximity. Ten lines, no separate update loop. */
function stepMine(mine: Hostile, dt: number) {
  mine.state.position.x += mine.state.velocity.x * dt;
  mine.state.position.y += mine.state.velocity.y * dt;
  const friendlies = friendlyTargets();
  if (!friendlies.some(ship => distance(mine.state.position, ship.position) < 150)) return;
  for (const ship of friendlies) {
    const range = distance(mine.state.position, ship.position);
    if (range < 150) ship.hull = Math.max(0, ship.hull - (12 + 34 * (1 - range / 150)));
  }
  scene.explode(mine.state.position.x, mine.state.position.y, 30);
  flashDamage(0.9); sound.boom();
  mine.state.hull = 0;
}

function killHostile(hostile: Hostile) {
  const catalogue = HOSTILES[hostile.kind];
  scene.explode(hostile.state.position.x, hostile.state.position.y, hostile.kind === 'turret' ? 32 : 24);
  scene.removeHostile(hostile.id);
  sound.boom();
  counters.hostilesKilled++;
  pendingBounty += catalogue.bounty;
  for (let i = 0; i < 2; i++) {
    const angle = Math.random() * Math.PI * 2, push = 10 + Math.random() * 24;
    ore.push({ id: nextRockId++, x: hostile.state.position.x, y: hostile.state.position.y, vx: Math.cos(angle) * push, vy: Math.sin(angle) * push, amount: Math.round(catalogue.bounty / 90), life: 90 });
  }
  toast(`${hostileLabel(hostile)} destroyed. ${catalogue.bounty.toLocaleString()} cr bounty banks when you dock.`);
  if (targetId === `hostile-${hostile.id}`) { navTarget = suggestTarget(run, world()); if (navTarget) targetId = navTarget.id; }
  updateContacts();
}

function cycleHostileTarget() {
  if (!hostiles.length) { toast('No hostiles on scope.'); return; }
  const ids = hostiles.map(hostile => `hostile-${hostile.id}`);
  const index = ids.indexOf(targetId);
  selectTarget(ids[(index + 1) % ids.length]);
  toast(`Track ${targetName()}.`);
}

function interact() {
  if (paused || modalOpen || crashed || flow !== 'flight') return;
  const recoverable = interactive(run, world());
  if (recoverable) {
    applySignals(recoverCargo(run, recoverable, world()));
    return;
  }
  if (dockable(run, world())) {
    state.velocity = { x: 0, y: 0 }; state.angularVelocity = 0;
    state.fuel = state.spec.fuel; state.hull = state.spec.hull; state.heat = 0;
    scene.dockPulse(); sound.ping();
    const signals = completeDock(run, world());
    updateMissionPanel();
    applySignals(signals);
    if (!signals.some(signal => signal.type === 'complete')) {
      const banked = pendingBounty + oreHeld * ORE_PRICE;
      if (banked > 0) {
        earn(profile, banked);
        pendingBounty = 0; oreHeld = 0;
        toast(`Docked at Wayfarer · ${banked.toLocaleString()} cr banked for ore and bounties.`);
      } else toast('Docked at Wayfarer. Hull repaired and propellant replenished.');
    }
    return;
  }
  const scan = activeScan();
  if (scan) { toast(`Hold station and let the sensor mast resolve ${scan.name}.`); return; }
  toast('Fly closer to a contact to scan, recover or dock.');
}

/** The contract is closed: pay out, bank the salvage, and show the ledger. */
function finishContract(payout: number) {
  const minutes = Math.floor(elapsed / 60), seconds = Math.floor(elapsed % 60);
  const previous = bestTime(profile, run.contract.id);
  recordTime(profile, run.contract.id, elapsed);
  const best = previous > 0 ? Math.min(previous, elapsed) : elapsed;
  // Bounties and ore bank at the dock, not at the kill: the station is where a sortie ends.
  const earnings = sortieEarnings(run.contract.payout, payout, oreHeld * ORE_PRICE, pendingBounty);
  lastEarnings = earnings;
  const total = earnings.payout + earnings.bonus + earnings.ore + earnings.bounty;
  earn(profile, total);
  pendingBounty = 0;
  oreHeld = 0;
  if (!profile.completed.includes(run.contract.id)) { profile.completed.push(run.contract.id); save(profile); }
  $('#title-credits').textContent = `${profile.credits.toLocaleString()} cr`;
  const unlocked = CONTRACTS.filter(contract => contract.requires?.includes(run.contract.id) && available(contract, profile));
  openDialog(`<span class="dialog-kicker">Contract ${run.contract.id} complete</span><div class="success-icon">${icon('check')}</div><h2 id="dialog-title">${run.contract.title} — done.</h2><p class="dialog-description">${run.contract.brief}</p><div class="debrief-stats">
    <div><span>Contract payment</span><strong>${earnings.payout.toLocaleString()} <small>cr</small></strong></div>
    <div><span>Bonus objective</span><strong>${earnings.bonus.toLocaleString()} <small>cr</small></strong></div>
    <div><span>Ore sold</span><strong>${earnings.ore.toLocaleString()} <small>cr</small></strong></div>
    <div><span>Bounties banked</span><strong>${earnings.bounty.toLocaleString()} <small>cr</small></strong></div>
    <div class="debrief-total"><span>Total earned</span><strong>${total.toLocaleString()} <small>cr</small></strong></div>
    <div><span>Balance</span><strong>${profile.credits.toLocaleString()} <small>cr</small></strong></div>
    <div><span>Flight time</span><strong>${minutes}:${String(seconds).padStart(2, '0')}</strong></div>
    <div><span>Best time</span><strong>${Math.floor(best / 60)}:${String(Math.floor(best % 60)).padStart(2, '0')}</strong></div></div>${unlocked.length ? `<p class="debrief-note">New work on the board: ${unlocked.map(contract => contract.title).join(', ')}.</p>` : ''}<button class="primary-button" id="next-sortie">Return to hangar ${icon('flight')}</button><button class="ghost-button" id="again-sortie">Relaunch same ship</button>`);
  $('#next-sortie').addEventListener('click', () => { closeDialog(); showHangar(); });
  $('#again-sortie').addEventListener('click', () => { resetSortie(state.shipClass, sortieBuild); closeDialog(); launchSequence(); });
  sound.ping();
}

/** A timed contract ran out: the run stops, the pilot keeps the ship. */
function failContract(reason: string) {
  setPaused(true);
  openDialog(`<span class="dialog-kicker">Contract ${run.contract.id} failed</span><h2 id="dialog-title">The window closed.</h2><p class="dialog-description">${reason}</p><button class="primary-button" id="restart-button">Return to hangar ${icon('reset')}</button><button class="ghost-button" id="retry-button">Relaunch same ship</button>`);
  $('#restart-button').addEventListener('click', () => { closeDialog(); showHangar(); });
  $('#retry-button').addEventListener('click', () => { resetSortie(state.shipClass, sortieBuild); closeDialog(); launchSequence(); });
}

function launchSequence() {
  flow = 'launch'; launchTimer = 0;
  setFlowClass();
  scene.setMode('flight');
  scene.launch = 0;
  $<HTMLElement>('#hangar-screen').hidden = true;
  $<HTMLElement>('#title-screen').hidden = true;
  $<HTMLElement>('#launch-card').hidden = false;
  $('#launch-kicker').textContent = `Contract ${selectedContract.id} · ${state.spec.name}`;
  $('#launch-title').textContent = selectedContract.title;
  const first = selectedContract.stages[0];
  $('#launch-line').textContent = `Pilot ${callsign}, ${first.banner ?? first.title.toLowerCase()}. ${first.objectives[0].label}.`;
  $('.game-shell').classList.remove('hud-live');
}

function finishLaunch() {
  if (flow !== 'launch') return;
  flow = 'flight';
  scene.launch = 1;
  setFlowClass();
  $<HTMLElement>('#launch-card').hidden = true;
  navTarget = suggestTarget(run, world());
  if (navTarget) targetId = navTarget.id;
  updateContacts(); updateMissionPanel();
  const name = navTarget?.name ?? 'the nearest contact';
  const range = navTarget ? formatDistance(distance(state.position, navTarget.position)) : '—';
  banner('Sortie launched', `Track ${name} · ${range}`);
  toast(`Main drive released. ${run.contract.kicker} — ${stage(run).objectives[0].label}.`);
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
$('#help-button').addEventListener('click', showHelp);
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
$('#hangar-shipyard').addEventListener('click', () => { sound.ping(); showBuilder(); });
$('#launch-sortie').addEventListener('click', () => {
  callsign = ($<HTMLInputElement>('#callsign').value.trim() || 'Rook').slice(0, 14);
  profile.callsign = callsign;
  save(profile);
  const build = activeBuild();
  if (build) launchBuild(build); else launchStock(bayShip);
});

function changeZoom(delta: number) { scene.setZoom(delta); updateZoomReadout(); }
$('#zoom-in').addEventListener('click', () => changeZoom(0.2));
$('#zoom-out').addEventListener('click', () => changeZoom(-0.2));
$('#zoom-reset').addEventListener('click', () => { scene.resetZoom(); updateZoomReadout(); });
$('#space-canvas').addEventListener('wheel', event => { event.preventDefault(); changeZoom(event.deltaY > 0 ? -0.08 : 0.08); }, { passive: false });
const canvasBounds = () => $('#space-canvas').getBoundingClientRect();
$('#space-canvas').addEventListener('pointermove', event => {
  if (flow !== 'flight' || modalOpen) return;
  const bounds = canvasBounds();
  pointerAim.x = event.clientX - bounds.left; pointerAim.y = event.clientY - bounds.top;
  aim = scene.unproject(pointerAim.x, pointerAim.y);
  aimFromPointer = true;
});
$('#space-canvas').addEventListener('pointerdown', event => {
  if (flow !== 'flight' || modalOpen || paused) return;
  const bounds = canvasBounds();
  pointerAim.x = event.clientX - bounds.left; pointerAim.y = event.clientY - bounds.top;
  aim = scene.unproject(pointerAim.x, pointerAim.y);
  aimFromPointer = true;
  if (event.button === 0) firing = true;
  if (event.button === 2) mining = true;
});
window.addEventListener('pointerup', event => {
  if (event.button === 0) firing = false;
  if (event.button === 2) mining = false;
});
$('#space-canvas').addEventListener('contextmenu', event => event.preventDefault());
$('#throttle').addEventListener('input', event => { const value = Number((event.target as HTMLInputElement).value); burnLimit = value / 100; $('#limiter-value').textContent = `${value}%`; });

const flightKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
window.addEventListener('keydown', event => {
  if (!scene || event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
  if (flow === 'launch') { if (event.code !== 'Escape') { finishLaunch(); } return; }
  if (modalOpen) { if (event.code === 'Escape') closeDialog(); return; }
  if (event.target instanceof HTMLButtonElement && (event.code === 'Space' || event.code === 'Enter')) return;
  if (flow !== 'flight') {
    if (event.code === 'Escape' && flow === 'hangar') showTitle();
    else if (flow === 'title' && !['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape'].includes(event.key)) { event.preventDefault(); showHangar(); }
    return;
  }
  if (modalOpen) { if (event.code === 'Escape') closeDialog(); return; }
  if (event.target instanceof HTMLButtonElement && (event.code === 'Space' || event.code === 'Enter')) return;
  if (flightKeys.includes(event.code) || ['Space', 'KeyC', 'KeyF', 'KeyR', 'KeyM', 'KeyV', 'KeyH', 'Escape', 'Tab'].includes(event.code)) event.preventDefault();
  if (flightKeys.includes(event.code) && !paused) keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Space') { if (paused) setPaused(false); else firing = true; }
  if (event.code === 'KeyC') mining = true;
  if (event.code === 'Escape') setPaused(!paused);
  if (event.code === 'Tab') cycleHostileTarget();
  if (event.code === 'KeyF') toggleAssist();
  if (event.code === 'KeyR') interact();
  if (event.code === 'KeyM') setView(scene.mode !== 'map');
  if (event.code === 'KeyV') setCinematic();
  if (event.code === 'KeyH') showHelp();
});
window.addEventListener('keyup', event => {
  keys.delete(event.code);
  if (event.code === 'Space') firing = false;
  if (event.code === 'KeyC') mining = false;
});
window.addEventListener('blur', () => { keys.clear(); firing = false; mining = false; });
document.addEventListener('visibilitychange', () => { hiddenPaused = document.hidden; keys.clear(); lastFrame = performance.now(); });
document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', event => { event.preventDefault(); if (paused || modalOpen || crashed || flow !== 'flight') return; button.setPointerCapture(event.pointerId); keys.add(button.dataset.key!); button.classList.add('pressed'); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { keys.delete(button.dataset.key!); button.classList.remove('pressed'); });
});
document.querySelectorAll<HTMLButtonElement>('[data-trigger]').forEach(button => {
  const flag = button.dataset.trigger === 'fire' ? 'fire' : 'mine';
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    if (paused || modalOpen || crashed || flow !== 'flight') return;
    button.setPointerCapture(event.pointerId);
    button.classList.add('pressed');
    if (flag === 'fire') firing = true; else mining = true;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => {
    button.classList.remove('pressed');
    if (flag === 'fire') firing = false; else mining = false;
  });
});
window.addEventListener('pointerdown', event => { if (flow === 'launch' && !(event.target instanceof HTMLButtonElement)) finishLaunch(); });

function showShipyard() {
  const builds = profile.builds;
  const list = builds.length
    ? `<div class="yard-builds">${builds.map(build => `<button class="yard-build ${profile.activeShip.kind === 'build' && profile.activeShip.id === build.id ? 'active' : ''}" data-load="${build.id}">
        <b>${escapeHtml(build.name)}</b><small>${CORES[build.core]?.name ?? 'Custom'} · ${derive(build).gees.toFixed(2)} g · ${derive(build).mounts.length} guns</small></button>`).join('')}</div>`
    : '<p class="dialog-description">No yard builds yet. The shipyard assembles a hull around a core, socket by socket.</p>';
  openDialog(`<span class="dialog-kicker">Independent fleet</span><h2 id="dialog-title">Find your kind of trouble.</h2><p class="dialog-description">Three ships. Three ways through the belt. Switching vessels starts a fresh sortie with the contract reset.</p><div class="shipyard-bay" id="shipyard-bay"></div>${innerHangar()}${list}<button class="primary-button" id="shipyard-build">Open the shipyard ${icon('ship')}</button>`, true);
  hydrateBay($('#shipyard-bay'), state.shipClass);
  document.querySelectorAll<HTMLButtonElement>('#dialog-content [data-load]').forEach(button => button.addEventListener('click', () => {
    const build = profile.builds.find(entry => entry.id === button.dataset.load);
    if (!build) return;
    launchBuild(build);
    closeDialog();
    toast(`${build.name} is ready. Your new sortie has begun.`);
  }));
  document.querySelectorAll<HTMLButtonElement>('#dialog-content [data-ship]').forEach(button => button.addEventListener('click', () => {
    const type = button.dataset.ship as ShipClass;
    if (type === state.shipClass && !sortieBuild) { toast(`${SHIPS[type].name} stays your vessel.`); return; }
    profile.activeShip = { kind: 'stock', id: type };
    save(profile);
    launchStock(type);
    closeDialog();
    toast(`${SHIPS[type].name} is ready. Your new sortie has begun.`);
  }));
  $('#shipyard-build')?.addEventListener('click', () => { closeDialog(); showBuilder(); });
}

async function boot() {
  try {
    await document.fonts.ready;
    profile = load();
    callsign = profile.callsign;
    bayShip = profile.activeShip.kind === 'stock' ? profile.activeShip.id : 'kestrel';
    scene = new SpaceScene($('#space-canvas'), obstacles, cargos);
    buildMounts(bayShip);
    radar = new Radar($<HTMLCanvasElement>('#radar-canvas'));
    collar = new Collar($<HTMLCanvasElement>('#collar-canvas'));
    updateContacts(); updateHUD(0); updateMissionPanel(); showTitle();
    $('.game-shell').removeAttribute('inert');
    $('#loading-state').classList.add('loaded');
    window.setTimeout(() => $('#loading-state').remove(), 600);
    lastFrame = performance.now(); requestAnimationFrame(frame);
    // A read-only snapshot supports repeatable browser diagnostics without exposing mutation hooks.
    Object.defineProperty(window, '__DRIFT__', {
      value: {
        snapshot: () => structuredClone({
          state, cargos, elapsed, paused, modalOpen, flow, crashed,
          tactical: scene.mode === 'map', zoom: scene.zoom, mapZoom: scene.mapZoom,
          recoveredCount: cargos.filter(cargo => cargo.kind === 'archive' && cargo.collected).length,
          scanned: [...run.scanned], payout: run.payout, failed: run.failed ?? null,
          navTarget: navTarget?.id ?? null, target: targetId, nav: navTarget ? { id: navTarget.id, name: navTarget.name, x: navTarget.position.x, y: navTarget.position.y } : null, allies: allies.map(ally => ({ id: ally.id, hull: Math.round(ally.state.hull), x: Math.round(ally.state.position.x), y: Math.round(ally.state.position.y), waypoint: ally.waypoint })),
          missionComplete: run.complete, contract: run.contract.id, stage: run.stageIndex, callsign,
          combat: {
            weapons: mounts.map(mount => mount.spec.id),
            bearings: mounts.map(mount => Number(mount.bearing.toFixed(3))),
            liveRounds: rounds.life.reduce((count, life) => count + (life > 0 ? 1 : 0), 0),
            roundPositions: (() => {
              const live: { x: number; y: number; vx: number; vy: number }[] = [];
              for (let i = 0; i < MAX_ROUNDS && live.length < 12; i++) {
                if (rounds.life[i] > 0) live.push({ x: rounds.x[i], y: rounds.y[i], vx: rounds.vx[i], vy: rounds.vy[i] });
              }
              return live;
            })(),
            oreLive: ore.length, oreHeld, fragments: fragments.length,
            orePositions: ore.slice(0, 12).map(chunk => ({ x: Math.round(chunk.x), y: Math.round(chunk.y), amount: chunk.amount })),
            rocksBroken: counters.rocksBroken, hostilesKilled: counters.hostilesKilled,
            hostiles: hostiles.map(hostile => ({
              id: hostile.id, kind: hostile.kind, mode: hostile.mode,
              hull: Math.round(hostile.state.hull), maxHull: HOSTILES[hostile.kind].hull,
              x: Math.round(hostile.state.position.x), y: Math.round(hostile.state.position.y),
              range: Math.round(Math.hypot(hostile.state.position.x - state.position.x, hostile.state.position.y - state.position.y)),
            })),
            pendingBounty,
          },
        }),
        // Read-only projection so a harness can aim real pointer events at a world position.
        project: (x: number, y: number) => scene.project({ x, y }),
        render: () => scene.combatDiagnostics(),
        openShipyard: () => showBuilder(),
        openHangar: () => showHangar(),
        contract: () => ({ stage: run.stageIndex, progress: { ...run.progress }, failed: run.failed ?? null, suggest: suggestTarget(run, world()) ?? null, allies: allies.length }),
        builder: () => (builder ? {
          core: builder.current().core,
          name: builder.current().name,
          slots: { ...builder.current().slots },
          stats: builder.currentSpec(),
          sockets: builder.socketScreen(),
        } : null),
        profile: () => ({ credits: profile.credits, owned: [...profile.owned], builds: profile.builds.map(build => build.id), active: profile.activeShip }),
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
