import { clamp, createShip, resolveCollision, shipBox, solidBodyBox, stepShip } from './physics';
import { segmentBoxHit, segmentCircleHit } from './collision';
import type { FlightInput, Obstacle, ShipClass, ShipState, SolidBody, SpatialGrid, Vec2 } from './physics';

// Reused between rounds so stepping the whole pool allocates nothing but the returned hit list.
const roundNearby: Obstacle[] = [];

export type WeaponKind = 'kinetic' | 'beam' | 'missile';
export type WeaponSpec = {
  id: string; name: string; kind: WeaponKind;
  damage: number;   // per hit; per second for a beam
  rof: number;      // shots per second; beams ignore it
  speed: number;    // m/s at the muzzle
  range: number;    // metres before the round expires
  spread: number;   // radians, half-angle
  heat: number;     // drive heat added per shot (per second for a beam)
  draw: number;     // propellant per shot (per second for a beam)
  arc: number;      // radians of traverse off the hull axis; 0 = fixed forward
  traverseRate?: number; // maximum mount slew in radians per second
  rockBonus: number;// damage multiplier vs asteroids — mining tools are poor anti-ship guns
  mass: number; cost: number;
};

export const WEAPONS: Record<string, WeaponSpec> = {
  ac20:   { id: 'ac20',   name: 'AC-20 autocannon', kind: 'kinetic', damage: 14,  rof: 5.5,  speed: 620,  range: 900,  spread: 0.018, heat: 0.006, draw: 1.4, arc: 0.38, rockBonus: 1,   mass: 1400, cost: 900 },
  ac70:   { id: 'ac70',   name: 'AC-70 breaker',    kind: 'kinetic', damage: 58,  rof: 1.1,  speed: 480,  range: 1150, spread: 0.006, heat: 0.030, draw: 6.0, arc: 0.22, rockBonus: 2.4, mass: 3900, cost: 2600 },
  gauss:  { id: 'gauss',  name: 'Gauss lance',      kind: 'kinetic', damage: 130, rof: 0.42, speed: 1400, range: 2200, spread: 0.001, heat: 0.110, draw: 14,  arc: 0.08, rockBonus: 1.6, mass: 6200, cost: 7400 },
  cutter: { id: 'cutter', name: 'Mining cutter',    kind: 'beam',    damage: 46,  rof: 0,    speed: 0,    range: 210,  spread: 0,     heat: 0.340, draw: 9,   arc: 0.50, rockBonus: 3.2, mass: 2100, cost: 1800 },
  swarm:  { id: 'swarm',  name: 'Swarm rack',       kind: 'missile', damage: 85,  rof: 0.7,  speed: 240,  range: 1800, spread: 0.120, heat: 0.020, draw: 4,   arc: 1.20, rockBonus: 0.6, mass: 2800, cost: 4100 },
  pdc:    { id: 'pdc',    name: 'Rotary PD cannon',  kind: 'kinetic', damage: 6,   rof: 18,   speed: 760, range: 700,  spread: 0.085, heat: 0.003, draw: 0.55, arc: Math.PI, rockBonus: 0.65, mass: 1050, cost: 1500, traverseRate: 7.5 },
  torpedo:{ id: 'torpedo',name: 'Heavy torpedo',     kind: 'missile', damage: 220, rof: 0.25, speed: 180, range: 3200, spread: 0.035, heat: 0.060, draw: 12,   arc: 1.35, rockBonus: 0.75, mass: 5200, cost: 7800, traverseRate: 2.6 },
  plasma: { id: 'plasma', name: 'Plasma mining beam', kind: 'beam',    damage: 150, rof: 0,    speed: 0,   range: 360,  spread: 0,     heat: 0.620, draw: 17,   arc: 0.60, rockBonus: 4.8, mass: 4800, cost: 6400, traverseRate: 3.8 },
};

const WEAPON_MUZZLE_OFFSETS: Record<WeaponKind, number> = {
  kinetic: 13,
  beam: 9,
  missile: 8,
};

/** Barrel-tip distance in the same local units as Mount.lx and Mount.ly. */
export function muzzleOffset(spec: WeaponSpec): number {
  if (spec.id === 'ac70') return 19;
  if (spec.id === 'gauss') return 32;
  return WEAPON_MUZZLE_OFFSETS[spec.kind];
}

// ponytail: fixed ring buffer, oldest round is dropped on wrap. Grow MAX_ROUNDS if a build ever out-fires it.
export const MAX_ROUNDS = 640;
export type Faction = 0 | 1;   // 0 player, 1 hostile

export class Rounds {
  readonly x = new Float32Array(MAX_ROUNDS);
  readonly y = new Float32Array(MAX_ROUNDS);
  readonly vx = new Float32Array(MAX_ROUNDS);
  readonly vy = new Float32Array(MAX_ROUNDS);
  readonly life = new Float32Array(MAX_ROUNDS);
  readonly damage = new Float32Array(MAX_ROUNDS);
  readonly bonus = new Float32Array(MAX_ROUNDS);
  readonly kind = new Uint8Array(MAX_ROUNDS); // 1 = guided missile, 0 = kinetic round
  readonly maxSpeed = new Float32Array(MAX_ROUNDS);
  readonly faction = new Uint8Array(MAX_ROUNDS);
  readonly target: (ShipState | undefined)[] = new Array(MAX_ROUNDS);
  private cursor: number = 0;

  spawn(x: number, y: number, vx: number, vy: number, spec: WeaponSpec, faction: Faction) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_ROUNDS;
    this.x[i] = x; this.y[i] = y;
    const maxSpeed = spec.kind === 'missile' ? spec.speed * 1.35 : 0;
    const velocity = Math.hypot(vx, vy);
    const velocityScale = maxSpeed > 0 && velocity > maxSpeed ? maxSpeed / velocity : 1;
    this.vx[i] = vx * velocityScale; this.vy[i] = vy * velocityScale;
    this.life[i] = spec.range / spec.speed;
    this.damage[i] = spec.damage; this.bonus[i] = spec.rockBonus; this.faction[i] = faction;
    this.kind[i] = spec.kind === 'missile' ? 1 : 0;
    this.maxSpeed[i] = maxSpeed;
    this.target[i] = undefined;
  }
}

export type Mount = { spec: WeaponSpec; lx: number; ly: number; cooldown: number; bearing: number };

/** The Kestrel model already carries point-defence housings at (+/-10 * wide, 9, 15). Mount there. */
export const STOCK_MOUNTS: Record<ShipClass, { weapon: string; lx: number; ly: number }[]> = {
  kestrel: [
    { weapon: 'ac20', lx: -10, ly: 9 }, { weapon: 'ac20', lx: 10, ly: 9 },
    { weapon: 'cutter', lx: 0, ly: -4 }, { weapon: 'swarm', lx: 0, ly: 17 },
  ],
  mule:    [{ weapon: 'ac70', lx: 0, ly: 16 }, { weapon: 'cutter', lx: 0, ly: -4 }],
  needle:  [{ weapon: 'ac20', lx: -7, ly: 14 }, { weapon: 'ac20', lx: 7, ly: 14 }, { weapon: 'gauss', lx: 0, ly: 6 }, { weapon: 'torpedo', lx: 0, ly: 18 }],
};

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Maximum slew rate for mounts that do not specify their own traverse speed. */
export const TURRET_TRAVERSE_RATE = 4.8;

export type MountWorldPose = { x: number; y: number; bearing: number; muzzleX: number; muzzleY: number };

/** World-space mount and muzzle coordinates used by simulation and presentation code. */
export function mountWorldPose(state: ShipState, mount: Mount, scale = 1): MountWorldPose {
  const cos = Math.cos(state.angle), sin = Math.sin(state.angle);
  const hullBearing = state.angle + Math.PI / 2;
  const x = state.position.x + (mount.lx * cos - mount.ly * sin) * scale;
  const y = state.position.y + (mount.lx * sin + mount.ly * cos) * scale;
  const bearing = hullBearing + mount.bearing;
  const muzzle = muzzleOffset(mount.spec) * scale;
  return { x, y, bearing, muzzleX: x + Math.cos(bearing) * muzzle, muzzleY: y + Math.sin(bearing) * muzzle };
}

function missileTarget(rounds: Rounds, index: number, targets: readonly { state: ShipState; faction: Faction }[]): ShipState | undefined {
  const faction = rounds.faction[index] as Faction;
  const current = rounds.target[index];
  if (current && current.hull > 0) {
    for (const target of targets) if (target.state === current && target.faction !== faction) return current;
  }
  let closest: ShipState | undefined;
  let closestDistance = Infinity;
  for (const candidate of targets) {
    if (candidate.faction === faction || candidate.state.hull <= 0) continue;
    const dx = candidate.state.position.x - rounds.x[index];
    const dy = candidate.state.position.y - rounds.y[index];
    const distance = dx * dx + dy * dy;
    if (distance < closestDistance) { closestDistance = distance; closest = candidate.state; }
  }
  rounds.target[index] = closest;
  return closest;
}

/** Turns a missile toward its nearest valid opposite-faction target at a capped rate. */
function guideMissile(rounds: Rounds, index: number, targets: readonly { state: ShipState; faction: Faction }[], dt: number) {
  const target = missileTarget(rounds, index, targets);
  if (!target) return;
  const speed = Math.hypot(rounds.vx[index], rounds.vy[index]);
  if (speed < 1e-6) return;
  const wantedPoint = interceptPoint(
    { x: rounds.x[index], y: rounds.y[index] }, target.position, target.velocity, speed, 3,
  );
  const wanted = Math.atan2(wantedPoint.y - rounds.y[index], wantedPoint.x - rounds.x[index]);
  const current = Math.atan2(rounds.vy[index], rounds.vx[index]);
  const turn = clamp(wrapAngle(wanted - current), -1.8 * dt, 1.8 * dt);
  const next = current + turn;
  const limitedSpeed = Math.min(speed, rounds.maxSpeed[index]);
  rounds.vx[index] = Math.cos(next) * limitedSpeed;
  rounds.vy[index] = Math.sin(next) * limitedSpeed;
}

/** Advances cooldowns and fires held mounts. Runs inside the fixed step. */
export function fireMounts(
  mounts: Mount[], state: ShipState, aim: Vec2, trigger: boolean, rounds: Rounds,
  faction: Faction, scale: number, dt: number,
  onShotOrMissileTrigger?: ((mx: number, my: number, angle: number, spec: WeaponSpec) => void) | boolean,
  missileTrigger?: boolean,
) {
  const onShot = typeof onShotOrMissileTrigger === 'function' ? onShotOrMissileTrigger : undefined;
  // A missing missile trigger is the old API: the primary trigger applies to every mount.
  // Supplying it splits one pass into primary and missile groups without stepping cooldowns twice.
  const missileFire = typeof onShotOrMissileTrigger === 'boolean'
    ? onShotOrMissileTrigger
    : missileTrigger;
  const legacyTrigger = missileFire === undefined;
  const cos = Math.cos(state.angle), sin = Math.sin(state.angle);
  // stepShip's forward is (-sin, cos): the hull axis is angle + PI/2 in world bearing terms.
  const hullBearing = state.angle + Math.PI / 2;
  for (const mount of mounts) {
    mount.cooldown = Math.max(0, mount.cooldown - dt);
    const mx = state.position.x + (mount.lx * cos - mount.ly * sin) * scale;
    const my = state.position.y + (mount.lx * sin + mount.ly * cos) * scale;
    const wanted = Math.atan2(aim.y - my, aim.x - mx);
    const desired = clamp(wrapAngle(wanted - hullBearing), -mount.spec.arc, mount.spec.arc);
    const current = Number.isFinite(mount.bearing) ? clamp(mount.bearing, -mount.spec.arc, mount.spec.arc) : 0;
    const error = wrapAngle(desired - current);
    const slewRate = Math.max(0, Math.min(TURRET_TRAVERSE_RATE, mount.spec.traverseRate ?? TURRET_TRAVERSE_RATE));
    const slew = slewRate * Math.max(0, dt);
    // The proportional term gives a responsive mount while slew caps preserve deterministic motion.
    mount.bearing = clamp(current + clamp(error * 6, -slew, slew), -mount.spec.arc, mount.spec.arc);
    if (mount.spec.kind === 'beam') continue;     // beams are continuous, see 1.8
    const canTrigger = mount.spec.kind === 'missile'
      ? (legacyTrigger ? trigger : missileFire === true)
      : trigger;
    if (!canTrigger || mount.cooldown > 0) continue;
    if (state.fuel < mount.spec.draw || state.heat > 0.98) continue;

    const angle = hullBearing + mount.bearing + (Math.random() - 0.5) * 2 * mount.spec.spread;
    const muzzle = muzzleOffset(mount.spec) * scale;
    const shotX = mx + Math.cos(angle) * muzzle;
    const shotY = my + Math.sin(angle) * muzzle;
    // Rounds inherit ship velocity. A Newtonian sim that skips this feels wrong the moment you strafe.
    rounds.spawn(shotX, shotY,
      state.velocity.x + Math.cos(angle) * mount.spec.speed,
      state.velocity.y + Math.sin(angle) * mount.spec.speed,
      mount.spec, faction);
    mount.cooldown = 1 / mount.spec.rof;
    state.fuel = Math.max(0, state.fuel - mount.spec.draw);
    state.heat = clamp(state.heat + mount.spec.heat, 0, 1);
    onShot?.(shotX, shotY, angle, mount.spec);
  }
}

export type Hit =
  | { kind: 'rock'; rock: Obstacle; x: number; y: number; damage: number; destroyed: boolean }
  | { kind: 'ship'; target: ShipState; x: number; y: number; damage: number }
  | { kind: 'body'; x: number; y: number }
  | { kind: 'expire'; x: number; y: number };

export function stepRounds(rounds: Rounds, grid: SpatialGrid, targets: { state: ShipState; faction: Faction }[], dt: number, bodies: readonly SolidBody[] = []): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (rounds.life[i] <= 0) continue;
    if (rounds.kind[i]) guideMissile(rounds, i, targets, dt);
    const vx = rounds.vx[i], vy = rounds.vy[i];
    const previousLife = rounds.life[i];
    rounds.life[i] -= dt;
    // A dying round only travels the part of this step left in its range.
    const travelDt = Math.min(dt, previousLife);
    const x0 = rounds.x[i], y0 = rounds.y[i];
    const x1 = x0 + vx * travelDt, y1 = y0 + vy * travelDt;
    let bestT = Infinity;
    let bestRock: Obstacle | undefined;
    let bestTarget: ShipState | undefined;
    let bestKind: 'rock' | 'ship' | 'body' | undefined;

    for (const target of targets) {
      if (target.faction === rounds.faction[i] || target.state.hull <= 0) continue;
      const t = segmentBoxHit(x0, y0, x1, y1, shipBox(target.state));
      if (t !== undefined && t < bestT) { bestT = t; bestTarget = target.state; bestKind = 'ship'; }
    }
    for (const body of bodies) {
      const t = body.kind === 'circle'
        ? segmentCircleHit(x0, y0, x1, y1, body)
        : segmentBoxHit(x0, y0, x1, y1, solidBodyBox(body));
      if (t !== undefined && t < bestT) { bestT = t; bestKind = 'body'; }
    }
    grid.nearSegment(x0, y0, x1, y1, roundNearby);
    for (const rock of roundNearby) {
      if (rock.z !== 0 || rock.hp <= 0) continue;
      const t = segmentCircleHit(x0, y0, x1, y1, rock, rock.radius * 0.9);
      if (t !== undefined && t < bestT) { bestT = t; bestRock = rock; bestKind = 'rock'; }
    }

    if (bestKind) {
      const hitX = x0 + (x1 - x0) * bestT, hitY = y0 + (y1 - y0) * bestT;
      rounds.x[i] = hitX; rounds.y[i] = hitY; rounds.life[i] = 0;
      if (bestKind === 'ship') {
        const damage = rounds.damage[i];
        bestTarget!.hull = Math.max(0, bestTarget!.hull - damage);
        hits.push({ kind: 'ship', target: bestTarget!, x: hitX, y: hitY, damage });
      } else if (bestKind === 'body') {
        hits.push({ kind: 'body', x: hitX, y: hitY });
      } else {
        const damage = rounds.damage[i] * rounds.bonus[i];
        bestRock!.hp -= damage;
        hits.push({ kind: 'rock', rock: bestRock!, x: hitX, y: hitY, damage, destroyed: bestRock!.hp <= 0 });
      }
    } else {
      rounds.x[i] = x1; rounds.y[i] = y1;
      if (rounds.life[i] <= 0) hits.push({ kind: 'expire', x: x1, y: y1 });
    }
  }
  return hits;
}

export type BeamHit = { mount: Mount; x: number; y: number; ex: number; ey: number; rock?: Obstacle; blocked?: boolean; destroyed: boolean };

export function stepBeams(
  mounts: Mount[], state: ShipState, grid: SpatialGrid, trigger: boolean, scale: number, dt: number,
  bodies: readonly SolidBody[] = [],
): BeamHit[] {
  const out: BeamHit[] = [];
  const nearby: Obstacle[] = [];
  for (const mount of mounts) {
    if (mount.spec.kind !== 'beam' || !trigger) continue;
    if (state.fuel < mount.spec.draw * dt || state.heat > 0.99) continue;
    const pose = mountWorldPose(state, mount, scale);
    const angle = pose.bearing;
    const mx = pose.muzzleX, my = pose.muzzleY;
    const dx = Math.cos(angle), dy = Math.sin(angle);

    const endX = mx + dx * mount.spec.range, endY = my + dy * mount.spec.range;
    let bestT = Infinity;
    let hitRock: Obstacle | undefined;
    let blocked = false;
    // Sweep the complete beam once, then choose the nearest entry point among all candidates.
    grid.nearSegment(mx, my, endX, endY, nearby);
    for (const rock of nearby) {
      if (rock.z !== 0 || rock.hp <= 0) continue;
      const t = segmentCircleHit(mx, my, endX, endY, rock);
      if (t !== undefined && t < bestT) { bestT = t; hitRock = rock; blocked = false; }
    }
    for (const body of bodies) {
      const t = body.kind === 'circle'
        ? segmentCircleHit(mx, my, endX, endY, body)
        : segmentBoxHit(mx, my, endX, endY, solidBodyBox(body));
      if (t !== undefined && t < bestT) { bestT = t; hitRock = undefined; blocked = true; }
    }
    const ex = bestT < Infinity ? mx + (endX - mx) * bestT : endX;
    const ey = bestT < Infinity ? my + (endY - my) * bestT : endY;
    state.fuel = Math.max(0, state.fuel - mount.spec.draw * dt);
    state.heat = clamp(state.heat + mount.spec.heat * dt, 0, 1);
    let destroyed = false;
    if (hitRock) {
      hitRock.hp -= mount.spec.damage * mount.spec.rockBonus * dt;
      destroyed = hitRock.hp <= 0;
    }
    out.push({ mount, x: mx, y: my, ex, ey, rock: hitRock, blocked: blocked || undefined, destroyed });
  }
  return out;
}

export type HostileKind = 'raider' | 'interceptor' | 'turret' | 'mine';
export type AIMode = 'patrol' | 'attack' | 'flee';

export type Hostile = {
  id: number; kind: HostileKind;
  state: ShipState;
  mounts: Mount[];
  mode: AIMode;
  home: Vec2;          // patrol anchor
  alertRange: number;
  preferred: number;   // the range it tries to hold
  reaction: number;    // seconds of decision lag; keeps it from being a perfect aimbot
  bounty: number;
  cooldown: number;
  /** Simulation seconds alive: the sim never reads the wall clock, so replays stay identical. */
  clock: number;
};

export const HOSTILES: Record<HostileKind, { ship: ShipClass; hull: number; weapons: string[]; alert: number; preferred: number; reaction: number; bounty: number }> = {
  raider:      { ship: 'kestrel', hull: 90,  weapons: ['ac20', 'ac20'], alert: 900,  preferred: 380, reaction: 0.34, bounty: 1400 },
  interceptor: { ship: 'needle',  hull: 55,  weapons: ['ac20'],         alert: 1200, preferred: 260, reaction: 0.20, bounty: 1900 },
  turret:      { ship: 'mule',    hull: 140, weapons: ['ac70'],         alert: 700,  preferred: 0,   reaction: 0.45, bounty: 1100 },
  mine:        { ship: 'needle',  hull: 20,  weapons: [],               alert: 150,  preferred: 0,   reaction: 0,    bounty: 300 },
};

/** One Mount per catalogue weapon, mirrored down the hull (single-weapon kinds sit on the axis). */
function hostileMounts(weapons: string[]): Mount[] {
  const mounts: Mount[] = [];
  for (let i = 0; i < weapons.length; i++) {
    const lx = weapons.length === 1 ? 0 : (i % 2 === 0 ? -10 : 10);
    mounts.push({ spec: WEAPONS[weapons[i]], lx, ly: 9, cooldown: 0, bearing: 0 });
  }
  return mounts;
}

/** A hostile built from the catalogue. Mass, thrust, fuel and torque come from its stock ship class. */
export function createHostile(id: number, kind: HostileKind, position: Vec2): Hostile {
  const entry = HOSTILES[kind];
  const state = createShip(entry.ship);
  state.position.x = position.x; state.position.y = position.y;
  state.angle = Math.random() * Math.PI * 2;
  state.hull = entry.hull;   // spec.hull is the shared stock const — the kind's own value lives here
  return {
    id, kind, state, mounts: hostileMounts(entry.weapons),
    mode: 'patrol', home: { x: position.x, y: position.y },
    alertRange: entry.alert, preferred: entry.preferred, reaction: entry.reaction, bounty: entry.bounty,
    cooldown: 0, clock: 0,
  };
}

/** Returns a leading point for a projectile intercept, with a direct-aim fallback. */
export function interceptPoint(from: Vec2, target: Vec2, targetVelocity: Vec2, speed: number, maxTime = Infinity): Vec2 {
  const rx = target.x - from.x, ry = target.y - from.y;
  const distance = Math.hypot(rx, ry);
  if (distance < 1e-9 || speed <= 1e-9) return { x: target.x, y: target.y };

  const vv = targetVelocity.x * targetVelocity.x + targetVelocity.y * targetVelocity.y;
  const rv = rx * targetVelocity.x + ry * targetVelocity.y;
  const a = vv - speed * speed;
  const b = 2 * rv;
  const c = distance * distance;
  let time = Infinity;
  if (Math.abs(a) < 1e-9) {
    if (b < -1e-9) time = -c / b;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const t0 = (-b - root) / (2 * a), t1 = (-b + root) / (2 * a);
      if (t0 > 1e-9) time = t0;
      if (t1 > 1e-9 && t1 < time) time = t1;
    }
  }
  if (!Number.isFinite(time)) time = distance / speed;
  time = Math.min(time, maxTime);
  return { x: target.x + targetVelocity.x * time, y: target.y + targetVelocity.y * time };
}

/** Compatibility name for callers that describe the same intercept as a lead point. */
export const leadPoint = interceptPoint;

/** Hostiles shoot the nearest thing on the player's side, which is what makes an escort dangerous. */
function nearestTarget(from: Vec2, targets: readonly ShipState[]): ShipState | undefined {
  let best: ShipState | undefined;
  let bestRange = Infinity;
  for (const target of targets) {
    if (target.hull <= 0) continue;
    const range = Math.hypot(target.position.x - from.x, target.position.y - from.y);
    if (range < bestRange) { bestRange = range; best = target; }
  }
  return best;
}

export function stepHostile(h: Hostile, targets: readonly ShipState[], rounds: Rounds, grid: SpatialGrid, dt: number): void {
  h.clock += dt;
  if (h.state.hull <= 0) return;
  const player = nearestTarget(h.state.position, targets);
  if (!player) return;
  const toPlayer = { x: player.position.x - h.state.position.x, y: player.position.y - h.state.position.y };
  const range = Math.hypot(toPlayer.x, toPlayer.y);
  const hullRatio = h.state.hull / HOSTILES[h.kind].hull;

  h.cooldown -= dt;
  if (h.cooldown <= 0) {                    // decisions are made at ~3 Hz, not 120 Hz
    h.cooldown = h.reaction;
    if (hullRatio < 0.28) h.mode = 'flee';
    else if (range < h.alertRange && player.hull > 0) h.mode = 'attack';
    else if (h.mode !== 'flee') h.mode = 'patrol';
  }

  const spec = h.mounts[0]?.spec;
  const aim = spec ? leadPoint(h.state.position, player.position, player.velocity, spec.speed) : player.position;
  const wantBearing = h.mode === 'flee'
    ? Math.atan2(-toPlayer.y, -toPlayer.x)
    : Math.atan2(aim.y - h.state.position.y, aim.x - h.state.position.x);

  // stepShip's hull axis is angle + PI/2; turn toward the wanted bearing with a damped proportional law.
  const error = wrapAngle(wantBearing - (h.state.angle + Math.PI / 2));
  const turn = clamp(error * 2.4 - h.state.angularVelocity * 0.7, -1, 1);

  let thrust = 0, strafe = 0;
  // Turrets and mines never translate — their input stays zeroed before stepShip; they still rotate to track.
  const mobile = h.kind !== 'turret' && h.kind !== 'mine';
  if (mobile && h.preferred > 0 && h.mode !== 'patrol') {
    const gap = range - h.preferred;
    thrust = clamp(gap / 260, -0.28, 1) * (h.mode === 'flee' ? -1 : 1);
    if (h.mode === 'flee') thrust = 1;                 // nose is already pointed away
    // Orbit rather than sit still: a stationary target is no fun to fight and no threat to fly past.
    else if (Math.abs(gap) < 140) strafe = Math.sin(h.id * 1.7 + h.clock / 2.6) > 0 ? 1 : -1;
  } else if (mobile && h.mode === 'patrol' && h.preferred > 0) {
    const drift = Math.hypot(h.home.x - h.state.position.x, h.home.y - h.state.position.y);
    thrust = drift > 500 ? 0.35 : 0;
  }

  const aligned = Math.abs(error) < 0.16 && range < (spec?.range ?? 0) * 0.85;
  const input: FlightInput = { thrust, turn, strafe, brake: h.mode === 'patrol' && thrust === 0, boost: false };
  stepShip(h.state, input, dt);
  grid.near(h.state.position.x, h.state.position.y, roundNearby);   // same scratch as the round loop
  for (const rock of roundNearby) resolveCollision(h.state, rock);   // hostiles hit rocks too, and it shows
  if (h.mounts.length) {
    fireMounts(h.mounts, h.state, aim, h.mode === 'attack' && aligned, rounds, 1, 1.3, dt);
  }
}

// ponytail: 3 Hz decisions and a proportional turn law. Behaviour trees only if a contract needs coordination.
