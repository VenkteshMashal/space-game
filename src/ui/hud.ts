/**
 * Flight instruments (Plan A3). The HUD answers four questions — what threatens me, where am I
 * going, what can I fire and what does the crew need — and nothing else. It is read-only: this
 * module never writes authority state, never starts a frame loop and never computes a ship figure
 * that `deriveFit` already derived.
 *
 * Two structural rules the layout depends on:
 *   - Only reticle, lead, offscreen threat arrows and an immediate prompt may enter the central
 *     field. Everything else is pinned to an edge (`hudMarkup` vs `hudFieldMarkup`).
 *   - DOM telemetry flushes at most every 100 ms. A 30 Hz render loop may call `update` freely;
 *     the writer decides when the DOM is allowed to change.
 */

import type { ClientView, ContactView, Id, LinkState, ObjectiveView, Vec2 } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import { BOUNDARY } from '../shared/balance.ts';
import { CATALOG, muzzleLocal } from '../shared/catalog.ts';
import { aimVisualFor, muzzleTangentialVelocity, muzzleWorld, shapeRadius, solveLead } from '../shared/aim.ts';
import {
  age, distance, energyMJ, fixed, headingDeg, int, massKg, percent, seconds, speed, uncertainty, vectorSpeed,
} from './format.ts';
import { el, esc, meter, reading } from './dom.ts';
import { derivationOfShip } from './derivation.ts';

/** The clear flight field: 70% width by 60% height, measured from the centre (Plan A3). */
export const FIELD_WIDTH_PERCENT = 70;
export const FIELD_HEIGHT_PERCENT = 60;
export const HUD_INTERVAL_MS = 100;

/** The only element kinds allowed inside the central field. */
export type FieldCueKind = 'reticle' | 'lead' | 'threat-arrow' | 'prompt' | 'boundary-arrow';

export interface FieldCue {
  readonly kind: FieldCueKind;
  readonly id: Id;
  readonly label: string;
  /** Bearing in degrees from screen-up, so the renderer can place the cue on the field edge. */
  readonly bearingDeg: number;
  readonly distanceM: number | null;
  readonly tone: 'signal' | 'caution' | 'threat';
}

export interface HudWeapon {
  readonly slotId: Id;
  readonly name: string;
  readonly group: number | null;
  readonly ammo: string;
  readonly state: string;
  readonly blockedReason: string | null;
  readonly ready: boolean;
}

export interface RadarContact {
  readonly id: Id;
  readonly kind: ContactView['kind'];
  readonly bearingDeg: number;
  readonly distanceM: number;
  readonly uncertaintyLabel: string;
  readonly ageLabel: string;
  readonly targetable: boolean;
  readonly tone: 'signal' | 'caution' | 'threat';
}

export interface RadarModel {
  readonly collapsed: boolean;
  readonly rangeM: number;
  readonly contacts: readonly RadarContact[];
  /** Contact count is bounded so a clutter of unknown returns cannot become a full screen. */
  readonly overflow: number;
}

export interface BoundaryModel {
  readonly bearingDeg: number;
  readonly secondsLeft: number;
  readonly distanceM: number;
}

export interface CrewCondition {
  readonly alive: number;
  readonly disabled: number;
  readonly reconnecting: number;
  readonly total: number;
  readonly distress: string | null;
}

export interface HudModel {
  readonly crew: CrewCondition;
  readonly objective: { readonly title: string; readonly progress: string; readonly distance: string | null } | null;
  readonly link: { readonly quality: string; readonly notice: string | null; readonly tone: 'signal' | 'caution' | 'threat' };
  readonly velocity: { readonly speed: string; readonly heading: string; readonly state: string };
  readonly hull: { readonly value: string; readonly fraction: number; readonly critical: boolean };
  readonly propellant: { readonly value: string; readonly fraction: number };
  readonly thermal: { readonly value: string; readonly fraction: number; readonly warning: boolean };
  readonly power: { readonly value: string; readonly detail: string } | null;
  readonly weapons: readonly HudWeapon[];
  readonly radar: RadarModel | null;
  readonly boundary: BoundaryModel | null;
  readonly field: readonly FieldCue[];
  readonly tick: number;
}

const LINK_NOTICE: Partial<Record<LinkState, string>> = {
  connecting: 'Connecting to the host.',
  handshake: 'Confirming protocol version.',
  loading: 'Receiving the arena.',
  reconnecting: 'Reconnecting. Your ship is coasting.',
  failed: 'Connection lost.',
  idle: 'Not connected.',
};

function toneForContact(kind: ContactView['kind']): RadarContact['tone'] {
  if (kind === 'hostile') return 'threat';
  if (kind === 'hazard' || kind === 'unknown') return 'caution';
  return 'signal';
}

/** Bearing zero faces +Y (contract); screen instruments read clockwise from up. */
export function bearingDeg(from: Vec2, to: Vec2): number {
  const degrees = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

function radarContact(contact: ContactView, origin: Vec2): RadarContact {
  const dx = contact.position.x - origin.x;
  const dy = contact.position.y - origin.y;
  return {
    id: contact.id,
    kind: contact.kind,
    bearingDeg: bearingDeg(origin, contact.position),
    distanceM: Math.sqrt(dx * dx + dy * dy),
    uncertaintyLabel: uncertainty(contact.uncertaintyM),
    // Age is measured in authority ticks; the contract fixes snapshot rate at 30 Hz.
    ageLabel: age(contact.ageTicks, RELEASE.snapshotHz),
    targetable: contact.targetable,
    tone: toneForContact(contact.kind),
  };
}

/** Sensor range is a fitted figure; when it is missing the radar says so instead of inventing one. */
function radarRange(view: ClientView): number {
  const ship = view.self?.ship;
  if (!ship) return 0;
  return derivationOfShip(ship).passiveRangeM;
}

/** Ping quality is only known from the roster; unknown is reported as unknown, never green. */
function selfPing(view: ClientView): string | null {
  const pilotId = view.pilotId;
  if (!pilotId || !view.lobby) return null;
  const entry = view.lobby.roster.find(candidate => candidate.pilotId === pilotId);
  if (!entry || entry.pingMs === null) return 'Ping unknown';
  return `${int(entry.pingMs)}\u2009ms`;
}

function currentObjective(view: ClientView): ObjectiveView | null {
  const order: readonly ObjectiveView['state'][] = ['active', 'locked', 'failed', 'complete'];
  for (const state of order) {
    const found = view.objectives.find(objective => objective.state === state);
    if (found) return found;
  }
  return null;
}

function boundaryModel(view: ClientView): BoundaryModel | null {
  const self = view.self;
  const radius = view.map?.boundsRadiusM ?? 0;
  if (!self || radius <= 0) return null;
  const position = self.predictionState.position;
  const distanceM = Math.sqrt(position.x * position.x + position.y * position.y);
  if (distanceM < radius * BOUNDARY.warnFraction) return null;
  return {
    bearingDeg: bearingDeg(position, { x: 0, y: 0 }),
    secondsLeft: BOUNDARY.returnSeconds,
    distanceM: Math.max(0, radius - distanceM),
  };
}

function threatCues(view: ClientView): readonly FieldCue[] {
  const self = view.self;
  if (!self) return [];
  const cues: FieldCue[] = [];
  for (const contact of view.contacts) {
    if (contact.kind !== 'hostile' && contact.kind !== 'hazard') continue;
    const range = radarRange(view);
    const dx = contact.position.x - self.predictionState.position.x;
    const dy = contact.position.y - self.predictionState.position.y;
    const distanceM = Math.sqrt(dx * dx + dy * dy);
    if (distanceM <= range * 0.35) continue;
    cues.push({
      kind: 'threat-arrow',
      id: contact.id,
      label: contact.kind === 'hostile' ? 'Hostile' : 'Hazard',
      bearingDeg: bearingDeg(self.predictionState.position, contact.position),
      distanceM,
      tone: contact.kind === 'hostile' ? 'threat' : 'caution',
    });
  }
  const boundary = boundaryModel(view);
  if (boundary) {
    cues.push({ kind: 'boundary-arrow', id: 'boundary', label: `Return ${seconds(boundary.secondsLeft)}`, bearingDeg: boundary.bearingDeg, distanceM: boundary.distanceM, tone: 'caution' });
  }
  return cues;
}

/**
 * The lead cue for the selected weapon group (Plan A3). It uses the same shared solver the authority
 * uses, so the reticle never promises a hit the shot cannot make: an outrun, expired, out-of-range or
 * obstructed solution draws nothing. Beams, torpedoes and mines get their own cue kinds and are not
 * led ballistically.
 */
function leadCue(view: ClientView): readonly FieldCue[] {
  const self = view.self;
  if (!self) return [];
  const weapon = self.weapons.find(candidate => candidate.group === 0) ?? self.weapons.find(candidate => candidate.group !== null);
  if (!weapon || aimVisualFor(derivationOfShip(self.ship).weaponSlots.find(slot => slot.slotId === weapon.slotId)?.behavior ?? 'ballistic') !== 'lead') return [];
  const slot = derivationOfShip(self.ship).weaponSlots.find(candidate => candidate.slotId === weapon.slotId);
  if (!slot) return [];
  const target = view.contacts.find(contact => contact.targetable && contact.kind === 'hostile');
  if (!target) return [];
  const predicted = self.predictionState;
  const muzzle = muzzleWorld(predicted.position, predicted.angle, muzzleLocal(self.ship.fit, weapon.slotId));
  const lead = solveLead({
    muzzle,
    muzzleSpeedMS: slot.speedMS,
    targetPosition: target.position,
    targetVelocity: { x: 0, y: 0 },
    shipVelocity: predicted.velocity,
    muzzleTangential: muzzleTangentialVelocity(predicted.position, muzzle, predicted.angularVelocity),
    ttlSeconds: slot.ttlS,
    occluders: view.bodies.filter(body => body.collidable).map(body => ({ position: body.position, radiusM: shapeRadius(body.shape) })),
  });
  if (!lead.valid) return [];
  return [{
    kind: 'lead',
    id: `${weapon.slotId}:${target.id}`,
    label: `Lead ${seconds(lead.timeS)}`,
    bearingDeg: bearingDeg(predicted.position, lead.point),
    distanceM: Math.hypot(lead.point.x - predicted.position.x, lead.point.y - predicted.position.y),
    tone: 'signal',
  }];
}

/** Build the instruments. Derived maxima come from `ClientView.self.derived`, never a local sum. */
export function hudModel(view: ClientView): HudModel | null {
  const self = view.self;
  if (!self) return null;
  const ship = self.ship;
  const derived = self.derived;
  const full = derivationOfShip(ship);
  const crewShips = view.ships.length > 0 ? view.ships : [ship];
  const alive = crewShips.filter(candidate => candidate.life === 'alive' || candidate.life === 'staged').length;
  const disabled = crewShips.filter(candidate => candidate.life === 'disabled' || candidate.life === 'respawning').length;
  const reconnecting = view.lobby
    ? view.lobby.roster.filter(entry => entry.presence === 'reconnecting').length
    : view.link === 'reconnecting'
      ? 1
      : 0;
  const distress = crewShips.find(candidate => candidate.life === 'disabled' && candidate.id !== ship.id)?.id ?? null;

  const hullFraction = ship.hullMax > 0 ? ship.hull / ship.hullMax : 0;
  const fuelFraction = ship.fuelMaxKg > 0 ? ship.fuelKg / ship.fuelMaxKg : 0;
  const heatFraction = ship.heatMaxMJ > 0 ? ship.heatMJ / ship.heatMaxMJ : 0;
  const objective = currentObjective(view);
  const radarRangeM = radarRange(view);
  const radar = radarRangeM > 0
    ? {
      collapsed: false,
      rangeM: radarRangeM,
      contacts: view.contacts
        .slice()
        .sort((a, b) => a.ageTicks - b.ageTicks)
        .slice(0, 12)
        .map(contact => radarContact(contact, self.predictionState.position)),
      overflow: Math.max(0, view.contacts.length - 12),
    }
    : null;

  const weaponParts = new Map(full.weaponSlots.map(slot => [slot.slotId, slot]));
  const weapons: HudWeapon[] = self.weapons.map(weapon => {
    const slot = weaponParts.get(weapon.slotId);
    const name = slot ? CATALOG.partById.get(slot.partId)?.name ?? slot.partId : weapon.slotId;
    const ammo = weapon.magazine === null ? 'Energy' : `${int(weapon.magazine)}${weapon.reserve === null ? '' : ` / ${int(weapon.reserve)}`}`;
    const reloading = weapon.reloadEndsAtTick !== null && weapon.reloadEndsAtTick > view.tick;
    return {
      slotId: weapon.slotId,
      name,
      group: weapon.group,
      ammo,
      state: reloading ? 'Reloading' : weapon.chargeFraction > 0 ? `Charging ${percent(weapon.chargeFraction)}` : weapon.readyAtTick > view.tick ? 'Cooling' : 'Ready',
      blockedReason: weapon.blockedReason,
      ready: weapon.blockedReason === null && !reloading && weapon.readyAtTick <= view.tick,
    };
  });

  const linkNotice = view.link === 'online' ? null : LINK_NOTICE[view.link] ?? null;
  const powerRelevant = derived.idleDemandMW >= derived.powerSupplyMW * 0.8 || full.activeDemandMW > 0 || ship.capacitorMJ < derived.capacitorMJ * 0.5;

  return {
    crew: { alive, disabled, reconnecting, total: crewShips.length, distress },
    objective: objective
      ? {
        title: objective.title,
        progress: objective.required > 1 ? `${int(objective.completed)} / ${int(objective.required)}` : '',
        distance: objective.marker ? distance(Math.hypot(objective.marker.x - self.predictionState.position.x, objective.marker.y - self.predictionState.position.y)) : null,
      }
      : null,
    link: {
      // Healthy link shows one small quality mark; the ping is only known from the roster.
      quality: view.link === 'online' ? (selfPing(view) ?? 'Link ok') : (LINK_NOTICE[view.link] ?? 'Unknown').split('.')[0]!,
      notice: linkNotice,
      tone: view.link === 'online' ? 'signal' : view.link === 'failed' ? 'threat' : 'caution',
    },
    velocity: {
      speed: speed(vectorSpeed(ship.velocity)),
      heading: headingDeg(ship.angle),
      state: self.predictionState.angularAssist ? 'Assist on' : 'Assist off',
    },
    hull: {
      value: `${int(ship.hull)} / ${int(ship.hullMax)}`,
      fraction: hullFraction,
      critical: hullFraction > 0 && hullFraction <= 0.25,
    },
    propellant: { value: `${massKg(ship.fuelKg)} / ${massKg(ship.fuelMaxKg)}`, fraction: fuelFraction },
    thermal: { value: `${energyMJ(ship.heatMJ)} / ${energyMJ(ship.heatMaxMJ)}`, fraction: heatFraction, warning: heatFraction >= 0.85 },
    power: powerRelevant ? { value: percent(derived.powerSupplyMW > 0 ? ship.capacitorMJ / derived.capacitorMJ : 0), detail: `${fixed(full.activeDemandMW, 2)} MW active` } : null,
    weapons,
    radar,
    boundary: boundaryModel(view),
    field: [...leadCue(view), ...threatCues(view)],
    tick: view.tick,
  };
}

// ---------------------------------------------------------------------------------------------
// Markup.
// ---------------------------------------------------------------------------------------------

/** Edge instruments. The centre is deliberately left empty here. */
export function hudMarkup(model: HudModel): string {
  const crew = el('div', { class: 'hud-crew', 'data-hud': 'crew' }, [
    el('span', { class: 'hud-kicker' }, 'Crew'),
    el('strong', { class: 'num' }, `${int(model.crew.alive)} / ${int(model.crew.total)}`),
    el('span', { class: 'hud-detail' }, model.crew.disabled > 0 ? `${int(model.crew.disabled)} disabled` : model.crew.reconnecting > 0 ? `${int(model.crew.reconnecting)} reconnecting` : 'All responding'),
    model.crew.distress ? el('button', { type: 'button', class: 'cta ghost distress', 'data-action': 'hud.distress', 'data-id': model.crew.distress }, 'Distress pin') : '',
  ]);

  const objective = el('div', { class: 'hud-objective', 'data-hud': 'objective' }, model.objective
    ? [el('span', { class: 'hud-kicker' }, 'Objective'), el('strong', {}, esc(model.objective.title)), el('span', { class: 'hud-detail num' }, [model.objective.progress, model.objective.distance].filter(Boolean).join(' \u00b7 '))]
    : [el('span', { class: 'hud-kicker' }, 'Objective'), el('strong', {}, 'No active tasking')]);

  const menu = el('div', { class: 'hud-link', 'data-hud': 'link', 'data-link': model.link.tone }, [
    el('span', { class: `hud-quality tone-${model.link.tone}` }, esc(model.link.quality)),
    model.link.notice ? el('span', { class: 'hud-notice' }, esc(model.link.notice)) : '',
    el('button', { type: 'button', class: 'cta ghost', 'data-action': 'overlay.menu' }, 'Menu'),
  ]);

  const radar = model.radar ? radarMarkup(model.radar) : '';
  const instruments = el('div', { class: 'hud-instruments', 'data-hud': 'instruments' }, [
    reading('Speed', model.velocity.speed, `${model.velocity.heading} \u00b7 ${model.velocity.state}`),
    hullBlock(model),
  ]);
  const weapons = el('div', { class: 'hud-weapons', 'data-hud': 'weapons' }, model.weapons.length > 0
    ? model.weapons.map(weapon => el('div', { class: `hud-weapon${weapon.ready ? '' : ' blocked'}`, 'data-slot': weapon.slotId }, [
      el('span', { class: 'hud-kicker' }, weapon.group === null ? weapon.name : `Group ${weapon.group + 1} \u00b7 ${weapon.name}`),
      el('strong', { class: 'num' }, weapon.ammo),
      el('small', { class: 'hud-detail' }, weapon.blockedReason ?? weapon.state),
    ]))
    : [el('span', { class: 'hud-kicker' }, 'No weapons fitted')]);

  return el('div', { class: 'hud', 'data-hud': 'root', 'data-tick': model.tick }, [
    el('header', { class: 'hud-top' }, [crew, objective, menu]),
    el('footer', { class: 'hud-bottom' }, [radar, instruments, weapons]),
    el('div', { class: 'hud-field', style: `--field-w:${FIELD_WIDTH_PERCENT}%;--field-h:${FIELD_HEIGHT_PERCENT}%`, 'data-field': 'central' }, hudFieldMarkup(model)),
  ]);
}

function hullBlock(model: HudModel): string {
  return el('div', { class: 'hud-resources', 'data-hud': 'resources' }, [
    el('span', { class: 'hud-kicker num' }, `Hull ${esc(model.hull.value)}`),
    meter('Hull', model.hull.fraction, model.hull.critical ? 'threat' : 'signal'),
    el('span', { class: 'hud-kicker num' }, `Propellant ${esc(model.propellant.value)}`),
    meter('Propellant', model.propellant.fraction, 'signal'),
    el('span', { class: 'hud-kicker num' }, `Thermal ${esc(model.thermal.value)}`),
    meter('Thermal', model.thermal.fraction, model.thermal.warning ? 'caution' : 'signal'),
    model.power ? el('span', { class: 'hud-kicker num' }, `Capacitor ${esc(model.power.value)} \u00b7 ${esc(model.power.detail)}`) : '',
  ]);
}

/** Radar draws only what the sensor actually returned, with its age and uncertainty. */
export function radarMarkup(radar: RadarModel): string {
  const size = 144;
  const radius = size / 2;
  const marks = radar.contacts.map(contact => {
    const radians = (contact.bearingDeg * Math.PI) / 180;
    const scaled = Math.min(1, contact.distanceM / Math.max(1, radar.rangeM)) * (radius - 12);
    const x = radius + Math.sin(radians) * scaled;
    const y = radius - Math.cos(radians) * scaled;
    return el('li', {
      class: `radar-contact tone-${contact.tone}`,
      'data-contact': contact.id,
      'data-kind': contact.kind,
      'data-uncertainty': contact.uncertaintyLabel,
      'data-age': contact.ageLabel,
      'aria-label': `${contact.kind} ${distance(contact.distanceM)} ${contact.uncertaintyLabel} ${contact.ageLabel}`,
      style: `--x:${x.toFixed(1)}px;--y:${y.toFixed(1)}px`,
    });
  });
  return el('div', { class: 'hud-radar', 'data-hud': 'radar', 'data-collapsed': radar.collapsed ? 'true' : 'false' }, [
    el('button', { type: 'button', class: 'cta ghost radar-toggle', 'data-action': 'hud.radar-toggle', 'aria-expanded': radar.collapsed ? 'false' : 'true' }, radar.collapsed ? 'Radar' : 'Hide'),
    el('div', { class: 'radar-scope', style: `--radar:${size}px` }, [
      el('ul', { class: 'radar-contacts' }, marks),
      el('span', { class: 'radar-range num' }, distance(radar.rangeM)),
    ]),
    radar.overflow > 0 ? el('span', { class: 'hud-detail' }, `${int(radar.overflow)} more returns`) : '',
  ]);
}

/**
 * The central field. Only reticle, lead, threat arrows, an immediate prompt and the boundary
 * direction may appear; the test asserts the allowed kinds and no persistent panel markup.
 */
export function hudFieldMarkup(model: HudModel): string {
  const reticle = el('div', { class: 'field-reticle', 'data-cue': 'reticle' }, []);
  const cues = model.field.map(cue => el('div', {
    class: `field-cue tone-${cue.tone}`,
    'data-cue': cue.kind,
    'data-id': cue.id,
    'data-bearing': cue.bearingDeg.toFixed(1),
    style: `--bearing:${cue.bearingDeg.toFixed(1)}deg`,
  }, esc(cue.label)));
  const boundary = model.boundary
    ? el('div', { class: 'field-boundary', 'data-cue': 'boundary' }, `${seconds(model.boundary.secondsLeft)} to boundary`)
    : '';
  return [reticle, ...cues, boundary].join('');
}

// ---------------------------------------------------------------------------------------------
// Throttle. 30 Hz callers are expected; the DOM only changes ten times a second.
// ---------------------------------------------------------------------------------------------

export function telemetryDue(nowMs: number, lastFlushMs: number): boolean {
  return nowMs - lastFlushMs >= HUD_INTERVAL_MS;
}

export class HudWriter {
  private lastFlushMs = Number.NEGATIVE_INFINITY;
  private lastMarkup = '';
  private disposed = false;
  private flushes = 0;

  constructor(private readonly write: (markup: string) => void) {}

  get flushCount(): number {
    return this.flushes;
  }

  /** Returns true when the DOM was written. Disposal makes this a permanent no-op. */
  update(view: ClientView, nowMs: number): boolean {
    if (this.disposed || !telemetryDue(nowMs, this.lastFlushMs)) return false;
    const model = hudModel(view);
    if (!model) return false;
    const markup = hudMarkup(model);
    this.lastFlushMs = nowMs;
    if (markup === this.lastMarkup) return false;
    this.lastMarkup = markup;
    this.flushes += 1;
    this.write(markup);
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }
}
