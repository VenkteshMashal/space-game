/**
 * Authority world (Plan B4/B5/B6/B7). One fixed 1/120 s step, integer ticks, no wall clock and no
 * socket anywhere in this file: the same tick sequence applied to the same state always produces the
 * same result, which is what prediction replay and crash recovery both depend on.
 *
 * Tick order is the plan's order and must not be reordered:
 *   1 accept scheduled inputs and hold until the lease expires
 *   2 fly ships under power, fuel, heat and capacitor limits
 *   3 fire weapons, charge rails, guide torpedoes, arm mines
 *   4 move projectiles and resolve the earliest swept hit
 *   5 move rocks inside the arena
 *   6 resolve solid contacts and convert lost energy into damage
 *   7 fracture rocks and respect the physical cap
 *   8 boundary warning and return timer
 *   9 life, destruction, respawn and protection
 *  10 sensors, objectives and the match result
 */

import { BOUNDARY, CLAMPS, CONTACT, HEAT, PVP, RCS_FUEL_KG_S, ROCKS, WEAPONS } from '../shared/balance.ts';
import { CATALOG, deriveFit, muzzleLocal } from '../shared/catalog.ts';
import { damageAt, createModuleSet, slotOutput, toLocal, type ModuleSet } from './modules.ts';
import { createUtilities, isActive, lockLostTicks, repairStep, setUtility, tetherPull, utilityIn, type UtilityRuntime } from './utilities.ts';
import { applyCrewOrder as applyBotOrder, createBotState, stepBot, type BotRole, type BotState } from './bots/bot.ts';
import { advanceItems, carriedMassKg, createMissionEntities, headingErrorDeg, loseItem, type MissionEntities } from './mission.ts';
import type { MissionDefinition } from './campaign/missions.ts';
import type {
  CollisionShape,
  ContactView,
  EventPayloadByKind,
  Fit,
  FitDerivation,
  FlightIntent,
  Id,
  InputFrame,
  InputReceipt,
  Life,
  MapDescriptor,
  Mode,
  NoticeCode,
  Phase,
  ProjectileView,
  ScheduledInput,
  ShipView,
  WeaponBehavior,
} from '../shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../shared/contracts.ts';
import { hash32 } from '../shared/ids.ts';
import type { Rng } from '../shared/rng.ts';
import { createRng } from '../shared/rng.ts';
import { isFriendly } from '../shared/teams.ts';
import { lineOfSightBlocked } from '../shared/geometry.ts';
import type { RigidBody } from './types.ts';
import { LAYER } from './types.ts';
import { planFracture, rockHull, rockMassKg, type RockState } from './fracture.ts';
import { clampRockToBounds, createMapDescriptor, createRocks, mapDefinition, spawnPositions } from './map.ts';
import { normalizeAngle, stepMotion, type PowerAllocation } from './motion.ts';
import { damageFromEnergy, massProperties, shapeRadiusM, stepContacts } from './physics.ts';
import type { MatchResult, ScoreLedger } from './score.ts';
import { attributeKill, createLedger, evaluateResult, recordDamage, tallyFor } from './score.ts';
import { chooseSpawn } from './spawn.ts';
import type { WeaponRuntime } from './weapons.ts';
import {
  admitProjectile, beginCharge, beginReload, canFire, cancelCharge, commitShot, createWeapons,
  solveMuzzle, tickWeapons, wantsToFire, weaponGroupMask,
} from './weapons.ts';
import { SpatialHash } from './spatial.ts';
import { createLockTracker, ecmContest, seekerRng, updateLock, updateSensors, type LockTracker, type SensorInput } from './sensors.ts';

/** A pending simulation event; the room stamps delivery sequence, epoch and tick when it sends it. */
export type SimEvent = {
  [K in keyof EventPayloadByKind]: { kind: K; payload: EventPayloadByKind[K] };
}[keyof EventPayloadByKind];

export interface ProjectileRuntime {
  id: number;
  generation: number;
  bodyId: number;
  behavior: WeaponBehavior;
  partId: Id;
  slotId: Id;
  ownerPilotId: Id;
  ownerLifeId: Id;
  teamId: Id;
  state: ProjectileView['state'];
  armTick: number;
  expiresAtTick: number;
  burnUntilTick: number;
  /** Locked contact for guided weapons, cleared when the lock lapses. */
  lockContactId: Id | null;
  /** True once the decoy contest for this lock has been sampled, so it is never rerolled. */
  ecmContested: boolean;
  /** While coasting after a lost lock, the seeker flies its last course. */
  coastUntilTick: number;
  /** Damage resolved from the firing weapon's spec at spawn, so impact cannot re-derive it. */
  damage: number;
}

export interface PilotRuntime {
  pilotId: Id;
  name: string;
  teamId: Id;
  isBot: boolean;
  fit: Fit;
  derived: FitDerivation;
  weapons: WeaponRuntime[];
  bodyId: number;
  lifeId: Id;
  life: Life;
  hull: number;
  hullMax: number;
  fuelKg: number;
  heatMJ: number;
  capacitorMJ: number;
  activeInput: ScheduledInput | null;
  queued: ScheduledInput[];
  receivedSeq: number;
  appliedSeq: number;
  /** Tick the authority last applied a queued intent for this pilot. */
  lastAppliedTick: number;
  respawnAtTick: number | null;
  protectionUntilTick: number;
  boundarySinceTick: number | null;
  spawnSalt: number;
  scanning: boolean;
  /** Fitted utilities: repair bay, rescue tether, decoy bay (B6). */
  utilities: UtilityRuntime[];
  /** Per-slot module health; a damaged drive or reactor changes what the ship can do (B6). */
  modules: ModuleSet;
  /** Slots whose module is destroyed, kept as a set so the weapon gate is a lookup. */
  disabledSlots: Set<Id>;
  /** Hull dimensions, for routing an impact point into a zone. */
  lengthM: number;
  beamM: number;
  /** Power allocation from this tick's flight step, reused by the weapon phase. */
  power: PowerAllocation;
  score: { kills: number; assists: number; deaths: number };
}

export interface WorldState {
  epoch: Id;
  tick: number;
  phase: Phase;
  mode: Mode;
  map: MapDescriptor;
  bodies: RigidBody[];
  bodyIndex: Map<number, number>;
  nextBodyId: number;
  ships: Map<Id, PilotRuntime>;
  rocks: Map<Id, RockState>;
  /** Bot control state per bot pilot; bots steer through ordinary intents, never direct writes. */
  bots: Map<Id, BotState>;
  /** Campaign items and berths; null in a PvP match, which has no mission entities. */
  mission: MissionEntities | null;
  /** Body id -> rock content id, so a contact can find its rock without scanning the field. */
  rockByBody: Map<number, Id>;
  projectiles: ProjectileRuntime[];
  contacts: Map<Id, ContactView[]>;
  locks: Map<Id, LockTracker>;
  ledger: ScoreLedger;
  events: SimEvent[];
  spatial: SpatialHash;
  seed: number;
  fractureRng: Rng;
  matchEndsAtTick: number;
  result: MatchResult | null;
  /** Last solid contact seen per ship this tick, used by the HUD damage arc. */
  lastHit: Map<Id, { position: { x: number; y: number }; fromAngle: number; tick: number }>;
}

export interface CreateWorldInput {
  epoch: Id;
  mode: Mode;
  mapId: Id;
  seed: number;
  matchSeconds?: number;
  teams: readonly Id[];
}

export function createWorld(input: CreateWorldInput): WorldState {
  const map = createMapDescriptor(input.mapId, input.seed);
  const world: WorldState = {
    epoch: input.epoch,
    tick: 0,
    phase: 'lobby',
    mode: input.mode,
    map,
    bodies: [],
    bodyIndex: new Map(),
    nextBodyId: 1,
    ships: new Map(),
    rocks: new Map(),
    bots: new Map(),
    mission: null,
    rockByBody: new Map(),
    projectiles: [],
    contacts: new Map(),
    locks: new Map(),
    ledger: createLedger(input.teams),
    events: [],
    spatial: new SpatialHash(),
    seed: input.seed,
    fractureRng: createRng(input.seed, 'fracture'),
    matchEndsAtTick: (input.matchSeconds ?? PVP.timeLimitS) * RELEASE.physicsHz,
    result: null,
    lastHit: new Map(),
  };
  for (const generated of createRocks(input.mapId, input.seed)) {
    const rock = addRock(world, generated.contentId, generated.position, generated.velocity, generated.radiusM, generated.renderSeed);
    rock.hull = rock.hullMax;
  }
  return world;
}

/** Scene bounds for the renderer and radar, in metres. */
export function worldRadiusM(world: WorldState): number {
  return world.map.boundsRadiusM;
}

function addBody(world: WorldState, body: Omit<RigidBody, 'id' | 'generation'>): RigidBody {
  const id = world.nextBodyId++;
  const created: RigidBody = { ...body, id, generation: 1 };
  world.bodies.push(created);
  world.bodyIndex.set(id, world.bodies.length - 1);
  return created;
}

export function bodyOf(world: WorldState, id: number): RigidBody | null {
  const index = world.bodyIndex.get(id);
  return index === undefined ? null : world.bodies[index] ?? null;
}

export function shipBody(world: WorldState, pilotId: Id): RigidBody | null {
  const pilot = world.ships.get(pilotId);
  return pilot ? bodyOf(world, pilot.bodyId) : null;
}

export function addRock(world: WorldState, contentId: Id, position: { x: number; y: number }, velocity: { x: number; y: number }, radiusM: number, renderSeed: number): RockState {
  const massKg = rockMassKg(radiusM);
  const body = addBody(world, {
    contentId,
    position: { ...position },
    velocity: { ...velocity },
    angle: (hash32(contentId) % 1024) / 1024 * Math.PI * 2,
    angularVelocity: 0,
    ...massProperties({ kind: 'circle', radiusM }, massKg),
    shape: { kind: 'circle', radiusM },
    collidable: true,
    restitution: CONTACT.rockRestitution,
    friction: CONTACT.friction,
    layer: LAYER.rock,
  });
  const rock: RockState = {
    bodyId: body.id,
    generation: body.generation,
    contentId,
    renderSeed,
    radiusM,
    massKg,
    hull: rockHull(radiusM, massKg),
    hullMax: rockHull(radiusM, massKg),
    splitDepth: 0,
    cracked: false,
  };
  world.rocks.set(contentId, rock);
  world.rockByBody.set(body.id, contentId);
  return rock;
}

/** Chassis silhouette as one collision proxy, shared by CCD, debug draw and the hangar (B5). */
export function chassisShape(fit: Fit): CollisionShape {
  const chassis = CATALOG.chassisById.get(fit.chassisId) ?? CATALOG.chassis[0]!;
  const radiusM = chassis.beamM * 0.32;
  return { kind: 'capsule', radiusM, halfSegmentM: Math.max(1, chassis.lengthM * 0.5 - radiusM) };
}

export function addPilot(world: WorldState, input: { pilotId: Id; name: string; teamId: Id; fit: Fit; isBot: boolean; position?: { x: number; y: number }; difficulty?: 'easy' | 'normal' | 'hard'; role?: BotRole }): PilotRuntime {
  const derived = deriveFit(input.fit);
  const shape: CollisionShape = chassisShape(input.fit);
  const chassis = CATALOG.chassisById.get(input.fit.chassisId) ?? CATALOG.chassis[0]!;
  const modules = createModuleSet(input.fit, chassis);
  const spawn = input.position ?? spawnPositions(mapDefinition(world.map.id))[world.ships.size % RELEASE.maxHumans]!.position;
  const body = addBody(world, {
    contentId: `ship:${input.pilotId}`,
    position: { ...spawn },
    velocity: { x: 0, y: 0 },
    angle: Math.atan2(spawn.x, -spawn.y),
    angularVelocity: 0,
    ...massProperties(shape, derived.wetMassKg),
    shape,
    collidable: true,
    restitution: CONTACT.shipRestitution,
    friction: CONTACT.friction,
    layer: LAYER.ship,
  });
  const pilot: PilotRuntime = {
    pilotId: input.pilotId,
    name: input.name,
    teamId: input.teamId,
    isBot: input.isBot,
    fit: input.fit,
    derived,
    weapons: createWeapons(derived, input.fit.fireGroups),
    bodyId: body.id,
    lifeId: `life:${input.pilotId}:1`,
    life: 'alive',
    hull: derived.hullMax,
    hullMax: derived.hullMax,
    fuelKg: derived.fuelCapacityKg,
    heatMJ: 0,
    capacitorMJ: derived.capacitorMJ,
    activeInput: null,
    queued: [],
    receivedSeq: 0,
    appliedSeq: 0,
    lastAppliedTick: 0,
    respawnAtTick: null,
    protectionUntilTick: 0,
    boundarySinceTick: null,
    spawnSalt: 1,
    scanning: false,
    utilities: createUtilities(derived),
    modules,
    disabledSlots: new Set(),
    lengthM: chassis.lengthM,
    beamM: chassis.beamM,
    power: { engineMW: 0, weaponMW: 0, utilityMW: 0, sensorMW: 0, powered: true },
    score: { kills: 0, assists: 0, deaths: 0 },
  };
  world.ships.set(input.pilotId, pilot);
  world.locks.set(input.pilotId, createLockTracker());
  if (input.isBot) {
    world.bots.set(input.pilotId, createBotState({
      pilotId: input.pilotId,
      teamId: input.teamId,
      difficulty: input.difficulty ?? 'normal',
      role: input.role ?? 'suppress',
      seed: world.seed,
      index: world.bots.size + 1,
    }));
  }
  world.ledger.hullMaxByPilot.set(input.pilotId, derived.hullMax);
  tallyFor(world.ledger, input.pilotId, input.teamId, input.name);
  return pilot;
}

export function removePilot(world: WorldState, pilotId: Id): void {
  const pilot = world.ships.get(pilotId);
  if (!pilot) return;
  removeBody(world, pilot.bodyId);
  world.ships.delete(pilotId);
  world.contacts.delete(pilotId);
  world.locks.delete(pilotId);
  world.projectiles = world.projectiles.filter(projectile => projectile.ownerPilotId !== pilotId);
}

function removeBody(world: WorldState, bodyId: number): void {
  const index = world.bodyIndex.get(bodyId);
  if (index === undefined) return;
  const last = world.bodies.length - 1;
  const moved = world.bodies[last]!;
  world.bodies[index] = moved;
  world.bodyIndex.set(moved.id, index);
  world.bodies.pop();
  world.bodyIndex.delete(bodyId);
}

export function applyInput(world: WorldState, pilotId: Id, frame: InputFrame): InputReceipt {
  const pilot = world.ships.get(pilotId);
  if (!pilot) return { seq: frame.seq, result: 'invalid' };
  if (frame.lifeId !== pilot.lifeId) return { seq: frame.seq, result: 'wrong-life' };
  if (frame.seq <= pilot.appliedSeq) return { seq: frame.seq, result: 'stale' };
  const maxFuture = world.tick + 12;
  const minPast = world.tick - 30;
  const target = Math.min(maxFuture, Math.max(world.tick + 1, frame.targetTick));
  if (target < minPast) return { seq: frame.seq, result: 'stale' };
  pilot.receivedSeq = Math.max(pilot.receivedSeq, frame.seq);
  while (pilot.queued.length >= 16) pilot.queued.shift();
  pilot.queued.push({ seq: frame.seq, applyAtTick: target, intent: frame.intent });
  return { seq: frame.seq, result: 'scheduled', applyAtTick: target };
}

/** Blur, hidden tab, overlay, disconnect and life change all land here (B4.3). */
export function releaseInput(world: WorldState, pilotId: Id): void {
  const pilot = world.ships.get(pilotId);
  if (!pilot) return;
  pilot.activeInput = null;
  pilot.queued.length = 0;
}

export function releaseAll(world: WorldState): void {
  for (const pilot of world.ships.values()) {
    pilot.activeInput = null;
    pilot.queued.length = 0;
  }
}

function expireLease(world: WorldState, pilot: PilotRuntime): void {
  if (!pilot.activeInput) return;
  if (world.tick - pilot.lastAppliedTick > RELEASE.inputLeaseTicks) {
    pilot.activeInput = null;
  }
}

function takeScheduled(world: WorldState, pilot: PilotRuntime): void {
  // Highest sequence wins a same-tick conflict; superseded frames are still receipted by the room.
  let best: ScheduledInput | null = null;
  for (let index = pilot.queued.length - 1; index >= 0; index--) {
    const frame = pilot.queued[index]!;
    if (frame.applyAtTick > world.tick) continue;
    if (!best || frame.seq > best.seq) best = frame;
    pilot.queued.splice(index, 1);
  }
  if (best) {
    pilot.activeInput = best;
    pilot.appliedSeq = Math.max(pilot.appliedSeq, best.seq);
    pilot.lastAppliedTick = world.tick;
  }
}

const FORWARD = (angle: number) => ({ x: -Math.sin(angle), y: Math.cos(angle) });

/** Electrical draw of the weapon groups the pilot is holding the trigger on this tick. */
function weaponDemandMW(pilot: PilotRuntime, fireMask: number): number {
  let demand = 0;
  for (const weapon of pilot.weapons) {
    if ((fireMask & weaponGroupMask(weapon.group)) === 0) continue;
    demand += weapon.spec.behavior === 'beam' ? 3 : 0.4;
  }
  return demand;
}

function flyShip(world: WorldState, pilot: PilotRuntime, dt: number): void {
  const body = bodyOf(world, pilot.bodyId);
  if (!body) return;
  expireLease(world, pilot);
  takeScheduled(world, pilot);
  if (pilot.life !== 'alive') return;
  const intent = pilot.activeInput?.intent ?? EMPTY_FLIGHT_INTENT;
  // Same implementation the client replays for prediction (B4.6): one flight model, no drift.
  pilot.power = stepMotion({
    body,
    resources: pilot,
    derived: pilot.derived,
    priority: pilot.fit.powerPriority,
    intent,
    dt,
    scanning: pilot.scanning,
    weaponDemandMW: weaponDemandMW(pilot, intent.fireMask),
    // A damaged drive pushes less and a damaged reactor supplies less; the penalty is applied from
    // base every tick, never compounded (B6).
    thrustScale: slotOutput(pilot.modules, 'e1'),
    supplyScale: slotOutput(pilot.modules, 'r1'),
    // Recovered items are part of the ship's wet mass, so a loaded hauler flies heavier (B5).
    cargoMassKg: cargoMassKg(world, pilot.pilotId),
  });
}

function weaponFireContext(world: WorldState, pilot: PilotRuntime, powered: boolean) {
  return {
    tick: world.tick,
    heatMJ: pilot.heatMJ,
    heatMaxMJ: pilot.derived.heatCapacityMJ,
    capacitorMJ: pilot.capacitorMJ,
    groupPowered: powered,
    fireMask: pilot.activeInput?.intent.fireMask ?? 0,
    insideServiceVolume: false,
    disabledSlots: pilot.disabledSlots,
  };
}

function fireWeapons(world: WorldState, pilot: PilotRuntime, protectedByPower: boolean): void {
  const body = bodyOf(world, pilot.bodyId);
  if (!body || pilot.life !== 'alive') return;
  tickWeapons(pilot.weapons, world.tick);
  const context = weaponFireContext(world, pilot, protectedByPower);
  for (const weapon of pilot.weapons) {
    if (weapon.spec.behavior === 'beam') {
      if (wantsToFire(weapon, context) && pilot.fuelKg > 0) fireBeam(world, pilot, weapon);
      continue;
    }
    if (weapon.spec.behavior === 'point-defense') {
      firePointDefense(world, pilot, weapon, context);
      continue;
    }
    const held = wantsToFire(weapon, context);
    if (!held) {
      if (weapon.chargeStartTick !== null) pilot.capacitorMJ = Math.min(pilot.derived.capacitorMJ, pilot.capacitorMJ + cancelCharge(weapon));
      weapon.chargeHeld = false;
      continue;
    }
    weapon.chargeHeld = true;
    if (weapon.spec.behavior === 'rail') {
      if (weapon.chargeStartTick === null) {
        if (!beginCharge(weapon, context)) continue;
        // Energy is spent when the charge starts so a cancelled charge returns it intact.
        pilot.capacitorMJ = Math.max(0, pilot.capacitorMJ - weapon.reservedMJ);
        continue;
      }
      if (weapon.chargeFraction < 1) continue;
    } else if (heatBlockedFor(pilot)) {
      weapon.blockedReason = 'thermal-limit';
      continue;
    }
    const state = canFire(weapon, context);
    if (!state.ok) {
      weapon.blockedReason = state.reason;
      if (state.reason === 'no-ammo') beginReload(weapon, world.tick);
      continue;
    }
    weapon.blockedReason = null;
    const activeCount = world.projectiles.length;
    const admission = admitProjectile(activeCount, world.projectiles.filter(projectile => projectile.behavior === 'torpedo' || projectile.behavior === 'mine').length, weapon.spec.behavior);
    if (!admission.ok) {
      weapon.blockedReason = admission.reason;
      continue;
    }
    const plan = commitShot(weapon, context);
    if (!plan) continue;
    pilot.heatMJ = Math.min(pilot.derived.heatCapacityMJ, pilot.heatMJ + plan.heatMJ);
    spawnProjectile(world, pilot, body, weapon);
  }
}

function heatBlockedFor(pilot: PilotRuntime): boolean {
  return pilot.derived.heatCapacityMJ > 0 && pilot.heatMJ >= pilot.derived.heatCapacityMJ * HEAT.block;
}

function spawnProjectile(world: WorldState, pilot: PilotRuntime, body: RigidBody, weapon: WeaponRuntime, aimAngle = body.angle): void {
  const local = muzzleLocal(pilot.fit, weapon.slotId);
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const muzzleWorld = {
    x: body.position.x + local.x * cos - local.y * sin,
    y: body.position.y + local.x * sin + local.y * cos,
  };
  const aiming: RigidBody = aimAngle === body.angle ? body : { ...body, angle: aimAngle };
  const solution = solveMuzzle(weapon, aiming, muzzleWorld, world.tick);
  const shape: CollisionShape = { kind: 'circle', radiusM: weapon.spec.behavior === 'mine' ? 3 : 1.2 };
  const projectileBody = addBody(world, {
    contentId: `shot:${weapon.partId}:${world.tick}`,
    position: { ...muzzleWorld },
    velocity: { ...solution.velocity },
    angle: body.angle,
    angularVelocity: 0,
    ...massProperties(shape, Math.max(0.1, weapon.spec.roundMassKg)),
    shape,
    collidable: false,
    restitution: 0,
    friction: 0,
    layer: LAYER.projectile,
  });
  const runtime: ProjectileRuntime = {
    id: projectileBody.id,
    generation: projectileBody.generation,
    bodyId: projectileBody.id,
    behavior: weapon.spec.behavior,
    partId: weapon.partId,
    slotId: weapon.slotId,
    ownerPilotId: pilot.pilotId,
    ownerLifeId: pilot.lifeId,
    teamId: pilot.teamId,
    state: solution.state,
    armTick: solution.armTick,
    expiresAtTick: solution.expiresAtTick,
    burnUntilTick: world.tick + Math.round(weapon.spec.burnS * RELEASE.physicsHz),
    lockContactId: pilot.activeInput?.intent.lockContactId ?? null,
    ecmContested: false,
    coastUntilTick: 0,
    damage: weapon.spec.damage,
  };
  world.projectiles.push(runtime);
  // Recoil acts at the hardpoint: linear and angular momentum change together (B5).
  const impulse = weapon.spec.impulseNS;
  if (impulse > 0) {
    const forward = FORWARD(body.angle);
    body.velocity = { x: body.velocity.x - (forward.x * impulse) / Math.max(1, pilot.derived.wetMassKg), y: body.velocity.y - (forward.y * impulse) / Math.max(1, pilot.derived.wetMassKg) };
    body.angularVelocity += (local.x * -forward.y * impulse - local.y * -forward.x * impulse) / Math.max(1, pilot.derived.inertiaKgM2) * 0.001;
  }
  world.events.push({
    kind: 'shot',
    payload: {
      shotId: `shot:${projectileBody.id}`,
      slotId: weapon.slotId,
      weaponId: weapon.partId,
      ownerLifeId: pilot.lifeId,
      position: muzzleWorld,
      velocity: solution.velocity,
      state: solution.state,
      expiresAtTick: solution.expiresAtTick,
    },
  });
}

/** PDC picks the detected incoming torpedo or mine with the least time to impact (B6). */
function firePointDefense(world: WorldState, pilot: PilotRuntime, weapon: WeaponRuntime, context: ReturnType<typeof weaponFireContext>): void {
  const body = bodyOf(world, pilot.bodyId);
  if (!body || weapon.spec.defenseRangeM === null) return;
  const threat = bestIncomingThreat(world, pilot, body, weapon.spec.defenseRangeM);
  if (!threat) return;
  const threatBody = bodyOf(world, threat.bodyId);
  if (!threatBody) return;
  const dx = threatBody.position.x - body.position.x;
  const dy = threatBody.position.y - body.position.y;
  const distance = Math.hypot(dx, dy) || 1;
  // A rock between the mount and the threat breaks the intercept: it is within range and LOS, or
  // it does not fire at all.
  const blocking = raycastSolids(world, body.position, { x: dx / distance, y: dy / distance }, distance, pilot.teamId);
  if (blocking?.kind === 'rock') return;
  const ready = canFire(weapon, context);
  if (!ready.ok) {
    weapon.blockedReason = ready.reason;
    return;
  }
  const plan = commitShot(weapon, context);
  if (!plan) return;
  pilot.heatMJ = Math.min(pilot.derived.heatCapacityMJ, pilot.heatMJ + plan.heatMJ);
  spawnProjectile(world, pilot, body, weapon, Math.atan2(-dx / distance, dy / distance));
}

function bestIncomingThreat(world: WorldState, pilot: PilotRuntime, body: RigidBody, rangeM: number): ProjectileRuntime | null {
  let best: ProjectileRuntime | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const projectile of world.projectiles) {
    if (projectile.teamId === pilot.teamId) continue;
    if (projectile.behavior !== 'torpedo' && projectile.behavior !== 'mine') continue;
    const projectileBody = bodyOf(world, projectile.bodyId);
    if (!projectileBody) continue;
    const distance = Math.hypot(body.position.x - projectileBody.position.x, body.position.y - projectileBody.position.y);
    if (distance > rangeM) continue;
    const closing = Math.hypot(projectileBody.velocity.x - body.velocity.x, projectileBody.velocity.y - body.velocity.y);
    const time = distance / Math.max(1e-3, closing);
    if (time < bestTime) {
      bestTime = time;
      best = projectile;
    }
  }
  return best;
}

/** Beams hit the nearest solid within range each damage tick; no projectile slot is used (B6). */
function fireBeam(world: WorldState, pilot: PilotRuntime, weapon: WeaponRuntime): void {
  const body = bodyOf(world, pilot.bodyId);
  if (!body) return;
  const range = weapon.spec.rangeM ?? 0;
  const forward = FORWARD(body.angle);
  const hit = raycastSolids(world, body.position, forward, range, pilot.teamId);
  pilot.heatMJ = Math.min(pilot.derived.heatCapacityMJ, pilot.heatMJ + (weapon.spec.heatShotMJ + 2) / RELEASE.physicsHz);
  if (!hit) return;
  const damage = hit.kind === 'rock' ? (weapon.spec.rockDamageS ?? 0) / RELEASE.physicsHz : (weapon.spec.damageS ?? 0) / RELEASE.physicsHz;
  applyHit(world, pilot, hit.pilotId ?? null, hit.rockId ?? null, damage, 'beam', hit.position, forward);
}

function raycastSolids(
  world: WorldState,
  origin: { x: number; y: number },
  direction: { x: number; y: number },
  rangeM: number,
  friendlyTeamId: Id,
): { kind: 'ship' | 'rock'; pilotId?: Id; rockId?: Id; position: { x: number; y: number } } | null {
  let closest: { kind: 'ship' | 'rock'; pilotId?: Id; rockId?: Id; position: { x: number; y: number } } | null = null;
  let closestDistance = rangeM;
  for (const pilot of world.ships.values()) {
    if (pilot.life !== 'alive') continue;
    const target = bodyOf(world, pilot.bodyId);
    if (!target) continue;
    const dx = target.position.x - origin.x;
    const dy = target.position.y - origin.y;
    const along = dx * direction.x + dy * direction.y;
    if (along <= 0 || along > closestDistance) continue;
    const lateral = Math.abs(dx * -direction.y + dy * direction.x);
    const radius = shapeRadiusM(target.shape);
    if (lateral > radius) continue;
    closestDistance = along;
    closest = { kind: 'ship', pilotId: pilot.pilotId, position: { x: origin.x + direction.x * along, y: origin.y + direction.y * along } };
  }
  for (const rock of world.rocks.values()) {
    const target = bodyOf(world, rock.bodyId);
    if (!target) continue;
    const dx = target.position.x - origin.x;
    const dy = target.position.y - origin.y;
    const along = dx * direction.x + dy * direction.y;
    if (along <= 0 || along > closestDistance) continue;
    const lateral = Math.abs(dx * -direction.y + dy * direction.x);
    if (lateral > rock.radiusM) continue;
    closestDistance = along;
    closest = { kind: 'rock', rockId: rock.contentId, position: { x: origin.x + direction.x * along, y: origin.y + direction.y * along } };
  }
  return closest;
}

function moveProjectiles(world: WorldState, dt: number): void {
  const survivors: ProjectileRuntime[] = [];
  for (const projectile of world.projectiles) {
    const body = bodyOf(world, projectile.bodyId);
    if (!body) continue;
    if (world.tick >= projectile.expiresAtTick) continue;
    if (world.tick >= projectile.armTick) {
      if (projectile.state === 'unarmed') projectile.state = 'armed';
    }
    if (projectile.behavior === 'torpedo') {
      if (world.tick < projectile.burnUntilTick) {
        const forward = FORWARD(body.angle);
        body.velocity = { x: body.velocity.x + forward.x * 100 * dt, y: body.velocity.y + forward.y * 100 * dt };
        projectile.state = 'burning';
      } else {
        projectile.state = 'coasting';
      }
    }
    const from = { ...body.position };
    const to = { x: body.position.x + body.velocity.x * dt, y: body.position.y + body.velocity.y * dt };
    const hit = sweptProjectileHit(world, projectile, from, to, body);
    if (hit) {
      const owner = world.ships.get(projectile.ownerPilotId);
      applyHit(world, owner ?? null, hit.pilotId ?? null, hit.rockId ?? null, projectile.damage, projectile.behavior, hit.position, hit.normal);
      continue;
    }
    body.position = to;
    if (projectile.behavior === 'mine') {
      body.velocity = { x: body.velocity.x * (1 - 0.4 * dt), y: body.velocity.y * (1 - 0.4 * dt) };
    }
    survivors.push(projectile);
  }
  world.projectiles = survivors;
}

function sweptProjectileHit(
  world: WorldState,
  projectile: ProjectileRuntime,
  from: { x: number; y: number },
  to: { x: number; y: number },
  body: RigidBody,
): { pilotId?: Id; rockId?: Id; position: { x: number; y: number }; normal: { x: number; y: number } } | null {
  const travelled = Math.hypot(to.x - from.x, to.y - from.y);
  if (travelled < 1e-6) return null;
  let closestT = 1;
  let result: { pilotId?: Id; rockId?: Id; position: { x: number; y: number }; normal: { x: number; y: number } } | null = null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (const pilot of world.ships.values()) {
    if (pilot.life !== 'alive') continue;
    if (pilot.pilotId === projectile.ownerPilotId && world.tick < projectile.armTick) continue;
    const target = bodyOf(world, pilot.bodyId);
    if (!target) continue;
    const radius = shapeRadiusM(target.shape);
    const relativeX = from.x - target.position.x;
    const relativeY = from.y - target.position.y;
    const a = dx * dx + dy * dy;
    const b = 2 * (relativeX * dx + relativeY * dy);
    const c = relativeX * relativeX + relativeY * relativeY - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) continue;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0 || t > closestT) continue;
    closestT = t;
    result = {
      pilotId: pilot.pilotId,
      position: { x: from.x + dx * t, y: from.y + dy * t },
      normal: { x: dx, y: dy },
    };
  }
  for (const rock of world.rocks.values()) {
    const target = bodyOf(world, rock.bodyId);
    if (!target) continue;
    const radius = rock.radiusM;
    const relativeX = from.x - target.position.x;
    const relativeY = from.y - target.position.y;
    const a = dx * dx + dy * dy;
    const b = 2 * (relativeX * dx + relativeY * dy);
    const c = relativeX * relativeX + relativeY * relativeY - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) continue;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0 || t > closestT) continue;
    closestT = t;
    result = {
      rockId: rock.contentId,
      position: { x: from.x + dx * t, y: from.y + dy * t },
      normal: { x: dx, y: dy },
    };
  }
  void body;
  return result;
}

/** One place applies damage, so score attribution, fracture and events can never disagree. */
function applyHit(
  world: WorldState,
  attacker: PilotRuntime | null,
  pilotId: Id | null,
  rockId: Id | null,
  damage: number,
  kind: WeaponBehavior | 'collision',
  position: { x: number; y: number },
  normal: { x: number; y: number },
): void {
  if (pilotId) {
    const victim = world.ships.get(pilotId);
    if (!victim || victim.life !== 'alive') return;
    const friendly = attacker !== null && isFriendly(attacker.teamId, victim.teamId);
    // Friendly fire defaults off, but an ally still blocks the shot: no damage, no event. A friendly
    // *collision* does hurt both hulls — it simply never credits a kill, so ramming cannot farm score.
    if (friendly && kind !== 'collision') return;
    const reduction = kind === 'beam' ? victim.derived.thermalReduction : victim.derived.kineticReduction;
    const applied = damage * (1 - reduction);
    victim.hull = Math.max(0, victim.hull - applied);
    if (attacker && attacker.pilotId !== victim.pilotId && !friendly) {
      recordDamage(world.ledger, { attackerPilotId: attacker.pilotId, victimPilotId: victim.pilotId, tick: world.tick, damage: applied });
    }
    // The impact point decides which zone and therefore which modules are hit; the client never
    // claims a hit location (B6).
    const victimBody = bodyOf(world, victim.bodyId);
    if (victimBody) {
      const local = toLocal(position, victimBody.position, victimBody.angle);
      const struck = damageAt(victim.modules, local, victim.lengthM, victim.beamM, applied);
      for (const slotId of struck.disabled) victim.disabledSlots.add(slotId);
    }
    world.lastHit.set(victim.pilotId, { position: { ...position }, fromAngle: Math.atan2(position.y - (bodyOf(world, victim.bodyId)?.position.y ?? 0), position.x - (bodyOf(world, victim.bodyId)?.position.x ?? 0)), tick: world.tick });
    const destroyed = victim.hull <= 0;
    world.events.push({
      kind: 'impact',
      payload: {
        hitId: `hit:${world.tick}:${pilotId}`,
        kind: 'ship',
        targetId: pilotId,
        position: { ...position },
        normal: { ...normal },
        damage: applied,
        energyJ: applied,
        destroyed,
        attackerPilotId: attacker?.pilotId ?? null,
        victimPilotId: pilotId,
      },
    });
    if (destroyed) destroyPilot(world, victim, attacker);
    return;
  }
  if (rockId) {
    const rock = world.rocks.get(rockId);
    if (!rock) return;
    rock.hull = Math.max(0, rock.hull - damage);
    world.events.push({
      kind: 'impact',
      payload: {
        hitId: `hit:${world.tick}:${rockId}`,
        kind: 'rock',
        targetId: rockId,
        position: { ...position },
        normal: { ...normal },
        damage,
        energyJ: damage,
        destroyed: rock.hull <= 0,
        attackerPilotId: attacker?.pilotId ?? null,
        victimPilotId: null,
      },
    });
    if (rock.hull <= 0) fractureRock(world, rock, normal, position);
  }
}

function destroyPilot(world: WorldState, pilot: PilotRuntime, attacker: PilotRuntime | null): void {
  scatterCarriedItems(world, pilot.pilotId);
  pilot.life = 'destroyed';
  pilot.respawnAtTick = world.tick + PVP.respawnSeconds * RELEASE.physicsHz;
  pilot.activeInput = null;
  pilot.queued.length = 0;
  const body = bodyOf(world, pilot.bodyId);
  if (body) body.collidable = false;
  const outcome = attributeKill(world.ledger, pilot.pilotId, pilot.teamId, world.tick);
  if (outcome.killerPilotId) {
    const killer = world.ships.get(outcome.killerPilotId);
    if (killer) killer.score.kills += 1;
  }
  pilot.score.deaths += 1;
  world.events.push({
    kind: 'life',
    payload: { lifeId: pilot.lifeId, shipId: `ship:${pilot.pilotId}`, pilotId: pilot.pilotId, life: 'destroyed', position: body?.position ?? { x: 0, y: 0 }, respawnAtTick: pilot.respawnAtTick },
  });
  for (const projectile of world.projectiles) if (projectile.ownerPilotId === pilot.pilotId) projectile.state = 'coasting';
}

function respawnPilot(world: WorldState, pilot: PilotRuntime): void {
  const body = bodyOf(world, pilot.bodyId);
  if (!body) return;
  const definition = mapDefinition(world.map.id);
  const choice = chooseSpawn({
    tick: world.tick,
    seed: world.seed + pilot.spawnSalt,
    teamId: pilot.teamId,
    candidates: spawnPositions(definition),
    corridor: world.map.navigationCorridors.map(corridor => ({ id: corridor.id, position: corridor.points[0]! })),
    occupants: [...world.ships.values()].filter(other => other.pilotId !== pilot.pilotId && other.life === 'alive').map(other => ({ position: bodyOf(world, other.bodyId)?.position ?? { x: 0, y: 0 }, radiusM: 12, teamId: other.teamId })),
    hazards: world.projectiles.map(projectile => ({ position: bodyOf(world, projectile.bodyId)?.position ?? { x: 0, y: 0 }, velocity: bodyOf(world, projectile.bodyId)?.velocity ?? { x: 0, y: 0 }, ttlTicks: Math.max(0, projectile.expiresAtTick - world.tick), radiusM: 2 })),
    enemies: [...world.ships.values()].filter(other => other.teamId !== pilot.teamId && other.life === 'alive').map(other => ({ position: bodyOf(world, other.bodyId)?.position ?? { x: 0, y: 0 }, radiusM: 14, teamId: other.teamId })),
    obstacles: [...world.rocks.values()].map(rock => ({ position: bodyOf(world, rock.bodyId)?.position ?? { x: 0, y: 0 }, radiusM: rock.radiusM })),
    boundsRadiusM: world.map.boundsRadiusM,
    shipRadiusM: 12,
  });
  pilot.spawnSalt += 1;
  pilot.lifeId = `life:${pilot.pilotId}:${pilot.spawnSalt}`;
  body.position = { ...choice.position };
  body.velocity = { x: 0, y: 0 };
  body.angularVelocity = 0;
  body.collidable = true;
  body.angle = Math.atan2(choice.position.x, -choice.position.y);
  pilot.hull = pilot.hullMax;
  pilot.fuelKg = pilot.derived.fuelCapacityKg;
  pilot.heatMJ = 0;
  pilot.capacitorMJ = pilot.derived.capacitorMJ;
  pilot.boundarySinceTick = null;
  // A redeployed loaner arrives fully repaired (B7), so a knocked-out weapon never carries over.
  for (const module of pilot.modules.modules) {
    module.health = module.maxHealth;
    module.output = 1;
    module.disabled = false;
  }
  pilot.disabledSlots.clear();
  pilot.life = 'alive';
  pilot.respawnAtTick = null;
  pilot.protectionUntilTick = world.tick + PVP.spawnProtectionSeconds * RELEASE.physicsHz;
  // A fresh body launches with a loaded magazine drawn from its own reserve.
  for (const weapon of pilot.weapons) {
    if (weapon.magazine === null || weapon.spec.magazine === null) continue;
    const want = weapon.spec.magazine - weapon.magazine;
    const available = Math.min(want, weapon.reserve ?? 0);
    weapon.magazine += available;
    weapon.reserve = (weapon.reserve ?? 0) - available;
    weapon.reloadEndsAtTick = null;
    weapon.readyAtTick = world.tick;
    weapon.chargeStartTick = null;
    weapon.chargeFraction = 0;
  }
  world.events.push({
    kind: 'life',
    payload: { lifeId: pilot.lifeId, shipId: `ship:${pilot.pilotId}`, pilotId: pilot.pilotId, life: 'alive', position: { ...choice.position }, respawnAtTick: null },
  });
}

function fractureRock(world: WorldState, rock: RockState, normal: { x: number; y: number }, position: { x: number; y: number }): void {
  const body = bodyOf(world, rock.bodyId);
  if (!body) return;
  const outcome = planFracture({
    rock,
    position: body.position,
    velocity: body.velocity,
    impactNormal: normal,
    liveRockCount: world.rocks.size - 1,
    tick: world.tick,
  });
  if (outcome.kind === 'retained') {
    rock.cracked = true;
    rock.hull = outcome.crackedHull;
    rock.hullMax = Math.max(rock.hullMax, outcome.crackedHull);
    rock.radiusM = rock.radiusM * 0.9;
    return;
  }
  world.rocks.delete(rock.contentId);
  world.rockByBody.delete(rock.bodyId);
  removeBody(world, rock.bodyId);
  for (const child of outcome.children) {
    const created = addRock(world, child.contentId, child.position, child.velocity, child.radiusM, child.renderSeed);
    const createdBody = bodyOf(world, created.bodyId);
    if (createdBody) createdBody.generation = rock.generation + 1;
    created.splitDepth = rock.splitDepth + 1;
  }
  void position;
}

/** Rocks never leave the arena: a rock that the contact step carried out is reflected back in. */
function clampRocks(world: WorldState): void {
  for (const rock of world.rocks.values()) {
    const body = bodyOf(world, rock.bodyId);
    if (!body) continue;
    const clamped = clampRockToBounds(body.position, body.velocity, world.map.boundsRadiusM);
    body.position = clamped.position;
    body.velocity = clamped.velocity;
  }
}

function resolveSolidContacts(world: WorldState): void {
  const movable: RigidBody[] = [];
  // Ships, rocks and station structure are all solid (B5's pair table); scenery never is, and
  // projectiles run their own continuous pass.
  for (const body of world.bodies) if ((body.layer & (LAYER.ship | LAYER.rock | LAYER.structure)) !== 0) movable.push(body);
  const result = stepContacts(movable, 1 / RELEASE.physicsHz, CONTACT.maxToiPerBodyPerTick);
  for (const contact of result.contacts) {
    const a = bodyOf(world, contact.a);
    const b = bodyOf(world, contact.b);
    if (!a || !b) continue;
    const pilotA = pilotForBody(world, a.id);
    const pilotB = pilotForBody(world, b.id);
    // Collision damage is a tuned function of lost impact energy, capped per contact so a single
    // impact cannot delete a full-hull ship (B5).
    const victimHull = pilotA?.hullMax ?? pilotB?.hullMax ?? 110;
    const scaled = Math.min(damageFromEnergy(contact.lostEnergyJ, victimHull), CONTACT.maxDamagePerTick);
    if (scaled <= 0) continue;
    // A contact damages both sides: ships lose hull, rocks crack and can fracture. Team-independent
    // — a friendly ram hurts both hulls, it just never earns score (see applyHit).
    if (pilotA) applyHit(world, pilotB, pilotA.pilotId, null, scaled, 'collision', contact.point, contact.normal);
    if (pilotB) applyHit(world, pilotA, pilotB.pilotId, null, scaled, 'collision', contact.point, contact.normal);
    const rockA = rockForBody(world, a.id);
    const rockB = rockForBody(world, b.id);
    if (rockA) applyHit(world, null, null, rockA.contentId, scaled, 'collision', contact.point, contact.normal);
    if (rockB) applyHit(world, null, null, rockB.contentId, scaled, 'collision', contact.point, contact.normal);
  }
}

function rockForBody(world: WorldState, bodyId: number): RockState | null {
  const contentId = world.rockByBody.get(bodyId);
  return contentId === undefined ? null : world.rocks.get(contentId) ?? null;
}

function pilotForBody(world: WorldState, bodyId: number): PilotRuntime | null {
  for (const pilot of world.ships.values()) if (pilot.bodyId === bodyId) return pilot;
  return null;
}

function updateBoundary(world: WorldState): void {
  const limit = world.map.boundsRadiusM * BOUNDARY.warnFraction;
  for (const pilot of world.ships.values()) {
    const body = bodyOf(world, pilot.bodyId);
    if (!body || pilot.life !== 'alive') continue;
    const distance = Math.hypot(body.position.x, body.position.y);
    if (distance <= limit) {
      if (pilot.boundarySinceTick !== null) {
        pilot.boundarySinceTick = null;
        world.events.push({ kind: 'notice', payload: { code: 'boundary-warning', message: 'Return corridor re-established', forPilotId: pilot.pilotId } });
      }
      continue;
    }
    if (pilot.boundarySinceTick === null) {
      pilot.boundarySinceTick = world.tick;
      world.events.push({ kind: 'notice', payload: { code: 'boundary-warning', message: `Outside arena: return within ${BOUNDARY.returnSeconds} seconds`, forPilotId: pilot.pilotId } });
      continue;
    }
    if (world.tick - pilot.boundarySinceTick >= BOUNDARY.returnSeconds * RELEASE.physicsHz) {
      destroyPilot(world, pilot, null);
      world.events.push({ kind: 'notice', payload: { code: 'boundary-tow', message: 'Recovered by the belt tug', forPilotId: pilot.pilotId } });
    }
  }
}

function updateSensorsFor(world: WorldState): void {
  for (const pilot of world.ships.values()) {
    const body = bodyOf(world, pilot.bodyId);
    if (!body) continue;
    const input: SensorInput = {
      tick: world.tick,
      observerTeamId: pilot.teamId,
      observerPosition: body.position,
      observerBonuses: { passiveRangeM: pilot.derived.passiveRangeM, activeRangeM: pilot.derived.activeRangeM, scanMultiplier: pilot.derived.scanMultiplier },
      targets: [...world.ships.values()].filter(other => other.life === 'alive' && other.pilotId !== pilot.pilotId).map(other => {
        const otherBody = bodyOf(world, other.bodyId)!;
        const speed = Math.hypot(otherBody.velocity.x, otherBody.velocity.y);
        return {
          id: other.pilotId,
          teamId: other.teamId,
          position: otherBody.position,
          velocity: otherBody.velocity,
          boosting: speed > 200,
          coasting: speed < 1,
          signatureMultiplier: other.derived.signatureMultiplier,
          radiusM: 12,
        };
      }),
      occluders: [...world.rocks.values()].map(rock => ({ position: bodyOf(world, rock.bodyId)?.position ?? { x: 0, y: 0 }, radiusM: rock.radiusM })),
      arenaRadiusM: world.map.boundsRadiusM,
    };
    const output = updateSensors(input, world.contacts.get(pilot.pilotId) ?? []);
    world.contacts.set(pilot.pilotId, output.contacts);
    const tracker = world.locks.get(pilot.pilotId);
    if (tracker) updateLock(tracker, output.targetable);
  }
}

export function stepWorld(world: WorldState): void {
  if (world.phase !== 'live') return;
  const dt = 1 / RELEASE.physicsHz;
  world.tick += 1;
  runBotControl(world);
  for (const pilot of world.ships.values()) {
    if (pilot.life === 'alive') flyShip(world, pilot, dt);
  }
  for (const pilot of world.ships.values()) {
    if (pilot.life !== 'alive') continue;
    fireWeapons(world, pilot, pilot.power.powered);
  }
  moveProjectiles(world, dt);
  guideTorpedoes(world, dt);
  runUtilities(world, dt);
  // The contact step advances every ship and rock to the end of the tick with time-of-impact
  // accuracy, applies impulses and reports lost energy; clamping then reflects any rock that the
  // step carried past the arena edge.
  resolveSolidContacts(world);
  clampRocks(world);
  advanceItems(world.mission, dt);
  updateBoundary(world);
  for (const pilot of world.ships.values()) {
    if (pilot.life === 'destroyed' && pilot.respawnAtTick !== null && world.tick >= pilot.respawnAtTick) respawnPilot(world, pilot);
    if (pilot.protectionUntilTick > 0 && world.tick === pilot.protectionUntilTick && pilot.heatMJ >= 0) {
      const body = bodyOf(world, pilot.bodyId);
      if (body) body.collidable = true;
    }
  }
  if (world.tick % 4 === 0) updateSensorsFor(world);
  if (world.mode === 'team-deathmatch' && world.result === null) {
    const occupied = world.ledger.teams.filter(teamId => [...world.ships.values()].some(pilot => pilot.teamId === teamId && pilot.life !== 'spectating'));
    const result = evaluateResult(world.ledger, {
      tick: world.tick,
      matchEndsAtTick: world.matchEndsAtTick,
      activeTeams: world.ledger.teams,
      teamsWithCombatants: occupied,
    });
    if (result) {
      world.result = result;
      world.events.push({ kind: 'result', payload: { resultId: `${world.epoch}:result`, outcome: result.outcome, winningTeamId: result.winningTeamId } });
    }
  }
}

/**
 * Bot control (B7). Bots steer through the same `applyInput` path a client uses, with senses built
 * from what the authority already knows, so a bot cannot see or do anything a pilot could not.
 */
function runBotControl(world: WorldState): void {
  if (world.bots.size === 0) return;
  for (const [pilotId, state] of world.bots) {
    const pilot = world.ships.get(pilotId);
    if (!pilot || pilot.life !== 'alive') continue;
    const body = bodyOf(world, pilot.bodyId);
    if (!body) continue;
    const decision = stepBot(state, {
      tick: world.tick,
      self: {
        position: body.position,
        velocity: body.velocity,
        angle: body.angle,
        hull: pilot.hull,
        hullMax: pilot.hullMax,
        fuelKg: pilot.fuelKg,
        heatMJ: pilot.heatMJ,
      },
      contacts: world.contacts.get(pilotId) ?? [],
      objectives: [],
      allies: [...world.ships.values()]
        .filter(other => other.pilotId !== pilotId && other.teamId === pilot.teamId && other.life === 'alive')
        .map(other => {
          const allyBody = bodyOf(world, other.bodyId)!;
          return { pilotId: other.pilotId, position: allyBody.position, velocity: allyBody.velocity, hull: other.hull, hullMax: other.hullMax };
        }),
      hazards: world.projectiles.map(projectile => {
        const shot = bodyOf(world, projectile.bodyId);
        return shot
          ? { position: shot.position, velocity: shot.velocity, radiusM: 2, ttlTicks: Math.max(0, projectile.expiresAtTick - world.tick) }
          : null;
      }).filter((hazard): hazard is { position: { x: number; y: number }; velocity: { x: number; y: number }; radiusM: number; ttlTicks: number } => hazard !== null && hazard.velocity.x * hazard.velocity.x + hazard.velocity.y * hazard.velocity.y > 1),
      obstacles: [...world.rocks.values()].map(rock => ({ position: bodyOf(world, rock.bodyId)?.position ?? { x: 0, y: 0 }, radiusM: rock.radiusM })),
      boundsRadiusM: world.map.boundsRadiusM,
      accelerationMS2: pilot.derived.thrustN / Math.max(1, pilot.derived.wetMassKg),
      turnRateRadS: (pilot.derived.rcsTorqueMNm * 1e6) / Math.max(1, pilot.derived.inertiaKgM2),
    });
    applyInput(world, pilotId, { epoch: world.epoch, lifeId: pilot.lifeId, seq: world.tick, targetTick: world.tick, intent: decision.intent });
    for (const command of decision.commands) {
      // A bot's only recovery lever is the ordinary respawn request, exactly like a pilot's.
      if (command.kind === 'recovery' && command.action === 'tow') requestRespawn(world, pilotId);
    }
  }
}

export function beginMatch(world: WorldState, phase: Phase = 'live'): void {
  world.phase = phase;
  world.tick = 0;
}

/** Populate a campaign arena from its mission definition; a PvP match never calls this. */
export function createMission(world: WorldState, mission: MissionDefinition): void {
  world.mission = createMissionEntities(mission);
}

export interface InteractFacts {
  distanceM: number;
  relativeSpeedMS: number;
  lineOfSight: boolean;
  targetAlive: boolean;
  pilotAlive: boolean;
  headingErrorDeg: number | null;
  berthClear: boolean;
  queueVisible: boolean;
}

/**
 * The measured facts for one interaction, taken from the world rather than from the client (B8). The
 * campaign runtime decides what they mean; nothing here accepts or rejects an objective.
 */
export function interactFacts(world: WorldState, pilotId: Id, objectiveId: Id, itemId: Id | null): InteractFacts | null {
  const pilot = world.ships.get(pilotId);
  const body = pilot ? bodyOf(world, pilot.bodyId) : null;
  if (!pilot || !body) return null;
  const target = itemId !== null ? world.mission?.items.get(itemId) ?? null : null;
  const berth = world.mission ? world.mission.berths.find(candidate => candidate.objectiveId === objectiveId) ?? null : null;
  const point = target?.position ?? berth?.position ?? null;
  const distanceM = point ? Math.hypot(point.x - body.position.x, point.y - body.position.y) : Number.POSITIVE_INFINITY;
  const targetVelocity = target?.carriedBy !== null && target !== null
    ? bodyOf(world, world.ships.get(target.carriedBy)?.bodyId ?? -1)?.velocity ?? { x: 0, y: 0 }
    : target?.velocity ?? { x: 0, y: 0 };
  const relativeSpeedMS = Math.hypot(targetVelocity.x - body.velocity.x, targetVelocity.y - body.velocity.y);
  const occluders = [...world.rocks.values()].map(rock => ({ position: bodyOf(world, rock.bodyId)?.position ?? { x: 0, y: 0 }, radiusM: rock.radiusM }));
  const berthOccupied = berth !== null && [...world.ships.values()].some(other => {
    if (other.pilotId === pilotId) return false;
    const otherBody = bodyOf(world, other.bodyId);
    return otherBody !== null && Math.hypot(otherBody.position.x - berth.position.x, otherBody.position.y - berth.position.y) <= berth.radiusM;
  });
  return {
    distanceM,
    relativeSpeedMS,
    lineOfSight: point === null ? false : !lineOfSightBlocked(body.position, point, occluders),
    targetAlive: target === null ? true : target.carriedBy === null || world.ships.get(target.carriedBy)?.life === 'alive',
    pilotAlive: pilot.life === 'alive',
    headingErrorDeg: berth === null ? null : headingErrorDeg(body.angle, berth.headingRad),
    berthClear: berth === null ? true : !berthOccupied,
    queueVisible: true,
  };
}

/** Hand a recovered item to a pilot: the mass follows it (B5), and the carrier can lose it later. */
export function recoverItem(world: WorldState, pilotId: Id, itemId: Id): boolean {
  const item = world.mission?.items.get(itemId);
  const pilot = world.ships.get(pilotId);
  if (!item || !pilot || item.carriedBy !== null) return false;
  item.carriedBy = pilotId;
  item.lost = false;
  item.velocity = { x: 0, y: 0 };
  world.events.push({ kind: 'notice', payload: { code: 'checkpoint-restored', message: `${item.id} secured`, forPilotId: pilotId } });
  return true;
}

/**
 * A destroyed carrier leaves its items at a reachable beacon rather than deleting the objective. The
 * beacon is pulled back inside the arena, because an archive lost past the boundary would otherwise
 * be a goal nobody is allowed to reach (B8).
 */
function scatterCarriedItems(world: WorldState, pilotId: Id): void {
  if (!world.mission) return;
  const body = bodyOf(world, world.ships.get(pilotId)?.bodyId ?? -1);
  const lost = body?.position ?? { x: 0, y: 0 };
  const limit = world.map.boundsRadiusM * 0.8;
  const distance = Math.hypot(lost.x, lost.y);
  const beacon = distance <= limit || distance < 1e-6 ? { ...lost } : { x: (lost.x / distance) * limit, y: (lost.y / distance) * limit };
  for (const item of [...world.mission.items.values()]) {
    if (item.carriedBy !== pilotId) continue;
    loseItem(world.mission, item.id, beacon);
  }
}

export function cargoMassKg(world: WorldState, pilotId: Id): number {
  return carriedMassKg(world.mission, pilotId);
}

export interface UtilityOutcomeView { ok: boolean; reason: NoticeCode | null }

/**
 * Switch a fitted utility on or off (B6). The effect is bounded by its own stock, charge and range,
 * and it is applied by the tick loop, never by the command itself — a command cannot heal a hull
 * instantly, only ask the bay to start working.
 */
export function applyUtility(world: WorldState, pilotId: Id, slotId: Id, targetId: Id | null, active: boolean): UtilityOutcomeView {
  const pilot = world.ships.get(pilotId);
  if (!pilot || pilot.life !== 'alive') return { ok: false, reason: 'invalid-target' };
  const runtime = utilityIn(pilot.utilities, slotId);
  if (!runtime) return { ok: false, reason: 'invalid-target' };
  if (active && (runtime.kind === 'repair' || runtime.kind === 'tether')) {
    const target = targetId === null ? pilot : world.ships.get(targetId);
    if (!target || target.life !== 'alive') return { ok: false, reason: 'invalid-target' };
    if (runtime.kind === 'tether' && target.pilotId === pilotId) return { ok: false, reason: 'invalid-target' };
    const ownerBody = bodyOf(world, pilot.bodyId);
    const targetBody = bodyOf(world, target.bodyId);
    if (!ownerBody || !targetBody) return { ok: false, reason: 'invalid-target' };
    const reach = runtime.kind === 'repair' ? pilot.derived.repairRangeM : pilot.derived.tetherRangeM;
    if (Math.hypot(targetBody.position.x - ownerBody.position.x, targetBody.position.y - ownerBody.position.y) > reach) {
      return { ok: false, reason: 'out-of-range' };
    }
  }
  const outcome = setUtility(runtime, { slotId, targetId, active, tick: world.tick, derived: pilot.derived });
  return outcome.ok ? { ok: true, reason: null } : { ok: false, reason: outcome.reason };
}

/** A crew order reaches every bot on the pilot's team; a human pilot is never overridden by one. */
export function applyCrewOrder(world: WorldState, pilotId: Id, order: 'focus' | 'defend' | 'recover' | 'regroup', contactId: Id | null): boolean {
  const pilot = world.ships.get(pilotId);
  if (!pilot) return false;
  let applied = false;
  for (const [botId, state] of world.bots) {
    const bot = world.ships.get(botId);
    if (!bot || bot.teamId !== pilot.teamId || botId === pilotId) continue;
    applyBotOrder(state, order, contactId, world.tick);
    applied = true;
  }
  return applied;
}

/** An early respawn request; the timer stays authoritative, so it can only end a finished wait. */
export function requestRespawn(world: WorldState, pilotId: Id): boolean {
  const pilot = world.ships.get(pilotId);
  if (!pilot) return false;
  if (pilot.life === 'alive') return false;
  if (pilot.respawnAtTick !== null && world.tick < pilot.respawnAtTick) return false;
  respawnPilot(world, pilot);
  return true;
}

/** One tick of every running utility: repair heals, the tether hauls, effects expire on their own. */
function runUtilities(world: WorldState, dt: number): void {
  for (const pilot of world.ships.values()) {
    if (pilot.life !== 'alive') {
      for (const runtime of pilot.utilities) {
        runtime.activeUntilTick = 0;
        runtime.targetId = null;
      }
      continue;
    }
    for (const runtime of pilot.utilities) {
      if (!isActive(runtime, world.tick)) continue;
      const ownerBody = bodyOf(world, pilot.bodyId);
      if (!ownerBody) continue;
      const target = runtime.targetId === null ? pilot : world.ships.get(runtime.targetId);
      if (!target || target.life !== 'alive') {
        runtime.activeUntilTick = 0;
        runtime.targetId = null;
        continue;
      }
      const targetBody = bodyOf(world, target.bodyId);
      if (!targetBody) continue;
      const dx = targetBody.position.x - ownerBody.position.x;
      const dy = targetBody.position.y - ownerBody.position.y;
      const distance = Math.hypot(dx, dy);
      if (runtime.kind === 'repair') {
        if (distance > pilot.derived.repairRangeM) continue;
        const step = repairStep(runtime.repairStock, target.hull, target.hullMax, pilot.derived.repairHullS, dt);
        runtime.repairStock = step.stockLeft;
        if (step.healed > 0) target.hull = Math.min(target.hullMax, target.hull + step.healed);
        if (runtime.repairStock <= 0 || step.healed <= 0) {
          runtime.activeUntilTick = 0;
          runtime.targetId = null;
        }
        continue;
      }
      if (runtime.kind === 'tether') {
        const closing = ((targetBody.velocity.x - ownerBody.velocity.x) * dx + (targetBody.velocity.y - ownerBody.velocity.y) * dy) / Math.max(1e-6, distance);
        const pull = tetherPull(distance, closing, pilot.derived);
        if (!pull) {
          runtime.activeUntilTick = 0;
          runtime.targetId = null;
          continue;
        }
        if (pull.broke) {
          runtime.activeUntilTick = 0;
          runtime.targetId = null;
          world.events.push({ kind: 'notice', payload: { code: 'out-of-range', message: 'Rescue tether parted', forPilotId: pilot.pilotId } });
          continue;
        }
        const ux = distance > 1e-6 ? dx / distance : 0;
        const uy = distance > 1e-6 ? dy / distance : 0;
        // Equal and opposite, scaled by each body's own inverse mass: a Mule hauls a Needle easily
        // and barely moves itself, which is the point of a tug. `u` points from owner to target.
        const impulse = pull.forceN * dt;
        const ownerPush = impulse * ownerBody.invMass;
        const targetPush = impulse * targetBody.invMass;
        ownerBody.velocity = { x: ownerBody.velocity.x + ux * ownerPush, y: ownerBody.velocity.y + uy * ownerPush };
        targetBody.velocity = { x: targetBody.velocity.x - ux * targetPush, y: targetBody.velocity.y - uy * targetPush };
        continue;
      }
    }
  }
}

/**
 * Guided weapons steer toward their lock at the weapon's turn limit, and a decoy bay forces a single
 * contest per lock: win it and the seeker flies its last course for a moment before it may reacquire.
 */
function guideTorpedoes(world: WorldState, dt: number): void {
  for (const projectile of world.projectiles) {
    if (projectile.behavior !== 'torpedo') continue;
    const body = bodyOf(world, projectile.bodyId);
    if (!body) continue;
    if (projectile.lockContactId === null) continue;
    const target = world.ships.get(projectile.lockContactId);
    if (!target || target.life !== 'alive') {
      projectile.lockContactId = null;
      continue;
    }
    const decoy = target.utilities.find(runtime => runtime.kind === 'ecm' && isActive(runtime, world.tick));
    if (decoy && !projectile.ecmContested) {
      projectile.ecmContested = true;
      const rng = seekerRng(world.seed, projectile.id);
      if (ecmContest(rng, target.derived.scanMultiplier > 1)) {
        projectile.lockContactId = null;
        projectile.coastUntilTick = world.tick + lockLostTicks();
        world.events.push({ kind: 'notice', payload: { code: 'invalid-target', message: 'Seeker decoyed', forPilotId: projectile.ownerPilotId } });
        continue;
      }
    }
    if (world.tick < projectile.coastUntilTick) continue;
    const targetBody = bodyOf(world, target.bodyId);
    if (!targetBody) continue;
    const desired = Math.atan2(-(targetBody.position.x - body.position.x), targetBody.position.y - body.position.y);
    const turn = normalizeAngle(desired - body.angle);
    const maxTurn = 1.2 * dt;
    body.angle = normalizeAngle(body.angle + Math.max(-maxTurn, Math.min(maxTurn, turn)));
  }
}

/** Drain this tick's events. The room sends them and must clear them, or the list grows forever. */
export function takeEvents(world: WorldState): SimEvent[] {
  const pending = world.events;
  world.events = [];
  return pending;
}

export function shipView(world: WorldState, pilot: PilotRuntime): ShipView {
  const body = bodyOf(world, pilot.bodyId)!;
  return {
    id: `ship:${pilot.pilotId}`,
    pilotId: pilot.pilotId,
    lifeId: pilot.lifeId,
    teamId: pilot.teamId,
    position: { ...body.position },
    velocity: { ...body.velocity },
    angle: body.angle,
    angularVelocity: body.angularVelocity,
    fit: pilot.fit,
    hull: pilot.hull,
    hullMax: pilot.hullMax,
    fuelKg: pilot.fuelKg,
    fuelMaxKg: pilot.derived.fuelCapacityKg,
    heatMJ: pilot.heatMJ,
    heatMaxMJ: pilot.derived.heatCapacityMJ,
    capacitorMJ: pilot.capacitorMJ,
    life: pilot.life,
  };
}

export function projectileViews(world: WorldState): ProjectileView[] {
  const views: ProjectileView[] = [];
  for (const projectile of world.projectiles) {
    const body = bodyOf(world, projectile.bodyId);
    if (!body) continue;
    views.push({
      id: `shot:${projectile.id}`,
      generation: projectile.generation,
      weaponId: projectile.partId,
      ownerLifeId: projectile.ownerLifeId,
      teamId: projectile.teamId,
      position: { ...body.position },
      velocity: { ...body.velocity },
      angle: body.angle,
      state: projectile.state,
      expiresAtTick: projectile.expiresAtTick,
    });
  }
  return views;
}

export function rockViews(world: WorldState): { rock: RockState; body: RigidBody }[] {
  const views: { rock: RockState; body: RigidBody }[] = [];
  for (const rock of world.rocks.values()) {
    const body = bodyOf(world, rock.bodyId);
    if (body) views.push({ rock, body });
  }
  return views;
}

export function rockHash(world: WorldState): number {
  let hash = 0x811c9dc5;
  for (const { rock, body } of rockViews(world)) {
    hash = hash32(`${hash}:${rock.contentId}`);
    hash = hash32(`${hash}:${Math.round(body.position.x * 1000)}`);
    hash = hash32(`${hash}:${Math.round(body.position.y * 1000)}`);
    hash = hash32(`${hash}:${Math.round(rock.radiusM * 100)}`);
  }
  return hash >>> 0;
}

export function boundaryWarning(world: WorldState, pilotId: Id): { outside: boolean; secondsLeft: number } | null {
  const pilot = world.ships.get(pilotId);
  if (!pilot || pilot.boundarySinceTick === null) return null;
  const elapsed = (world.tick - pilot.boundarySinceTick) / RELEASE.physicsHz;
  return { outside: true, secondsLeft: Math.max(0, BOUNDARY.returnSeconds - elapsed) };
}
