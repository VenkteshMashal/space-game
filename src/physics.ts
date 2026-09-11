import { HULL_BOXES, obbCircleOut, obbObbOut, pointInBox, pointInCircle } from './collision';
import type { Box } from './collision';

export type Vec2 = { x: number; y: number };
export type ShipClass = 'kestrel' | 'mule' | 'needle';
export type FlightInput = { thrust: number; turn: number; strafe: number; brake: boolean; boost: boolean };

/** Everything `stepShip` reads about a hull. Stock classes and custom builds both produce one. */
export type ShipSpec = {
  name: string; role: string;
  mass: number; thrust: number; fuel: number; torque: number; hull: number; length: number; cargo: number;
  /** Heat shed per second; radiator wings raise it on a custom build. */
  cooling: number;
};

export const SHIPS = {
  kestrel: { name: 'Kestrel', role: 'Independent corvette', mass: 82000, thrust: 1600000, fuel: 16000, torque: 1.35, hull: 100, length: 42, cargo: 120, cooling: 0.055 },
  mule: { name: 'Mule', role: 'Heavy salvage tug', mass: 142000, thrust: 1950000, fuel: 30000, torque: 0.82, hull: 150, length: 58, cargo: 320, cooling: 0.075 },
  needle: { name: 'Needle', role: 'Fast reconnaissance cutter', mass: 43000, thrust: 1200000, fuel: 10000, torque: 2.05, hull: 75, length: 31, cargo: 40, cooling: 0.05 },
} as const satisfies Record<ShipClass, ShipSpec>;

export type ShipState = {
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  fuel: number;
  hull: number;
  heat: number;
  cooling: number;
  acceleration: number;
  thrustLevel: number;
  rcsActive: boolean;
  assist: boolean;
  shipClass: ShipClass;
  spec: ShipSpec;
  /** The drawn hull's collision box: custom builds carry their own, stock classes use the measured table. */
  collider: { halfLength: number; halfWidth: number };
};

export function createShip(shipClass: ShipClass = 'kestrel', spec: ShipSpec = SHIPS[shipClass], collider: { halfLength: number; halfWidth: number } = HULL_BOXES[shipClass]): ShipState {
  return {
    position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: -0.63,
    angularVelocity: 0, fuel: spec.fuel, hull: spec.hull,
    heat: 0, cooling: spec.cooling, acceleration: 0, thrustLevel: 0, rcsActive: false, assist: true, shipClass, spec, collider,
  };
}

export const length = (v: Vec2) => Math.hypot(v.x, v.y);
export const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const heading = (angle: number) => ((-angle * 180 / Math.PI) % 360 + 360) % 360;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const emptyInput = (): FlightInput => ({ thrust: 0, turn: 0, strafe: 0, brake: false, boost: false });

/** Newtonian planar motion, integrated with semi-implicit Euler at a fixed 120 Hz. */
export function stepShip(state: ShipState, input: FlightInput, dt: number) {
  const spec = state.spec;
  const dryMass = spec.mass;
  const maxAcceleration = spec.thrust / (dryMass + state.fuel);
  const canBurn = state.fuel > 0 && state.hull > 0;
  const boost = input.boost && state.heat < 0.95 ? 1.65 : 1;
  const thrust = canBurn ? clamp(input.thrust, -0.28, 1) * boost : 0;
  const turn = canBurn ? clamp(input.turn, -1, 1) : 0;
  const strafe = canBurn ? clamp(input.strafe, -1, 1) : 0;
  const forward = { x: -Math.sin(state.angle), y: Math.cos(state.angle) };
  const right = { x: Math.cos(state.angle), y: Math.sin(state.angle) };
  let ax = forward.x * thrust * maxAcceleration + right.x * strafe * maxAcceleration * 0.22;
  let ay = forward.y * thrust * maxAcceleration + right.y * strafe * maxAcceleration * 0.22;
  let fuelRate = Math.abs(thrust) * 14 + Math.abs(turn) * 1.2 + Math.abs(strafe) * 3;

  // An active RCS burn counters velocity. Coasting has no artificial drag.
  if (input.brake && canBurn) {
    const speed = length(state.velocity);
    const braking = Math.min(maxAcceleration * 0.65, speed / dt);
    if (speed > 0.0001) {
      ax -= state.velocity.x / speed * braking;
      ay -= state.velocity.y / speed * braking;
      fuelRate += braking / maxAcceleration * 16;
    }
  }

  let angularAcceleration = turn * spec.torque;
  if (state.assist && !turn && canBurn) {
    const correction = clamp(-state.angularVelocity / dt, -spec.torque, spec.torque);
    angularAcceleration += correction;
    fuelRate += Math.abs(correction) * 0.7;
  }

  state.angularVelocity += angularAcceleration * dt;
  state.angle += state.angularVelocity * dt;
  state.velocity.x += ax * dt;
  state.velocity.y += ay * dt;
  state.position.x += state.velocity.x * dt;
  state.position.y += state.velocity.y * dt;
  state.fuel = Math.max(0, state.fuel - fuelRate * dt);
  state.acceleration = Math.hypot(ax, ay);
  state.thrustLevel = thrust;
  state.rcsActive = canBurn && (Math.abs(turn) > 0 || Math.abs(strafe) > 0 || thrust < 0 || (input.brake && length(state.velocity) > 0.001) || (state.assist && angularAcceleration !== 0));
  state.heat = clamp(state.heat + (Math.abs(thrust) > 1 ? 0.09 : Math.abs(thrust) * 0.016 - state.cooling) * dt, 0, 1);
}

export type Obstacle = {
  id: number;
  x: number; y: number; radius: number; seed: number; z: number;
  hp: number; maxHp: number;
  vx?: number; vy?: number;
};
export type CargoKind = 'archive' | 'blackbox';
export type Cargo = { id: string; name: string; kind: CargoKind; position: Vec2; collected: boolean };

/** The playable volume: a 5.2 x 4.2 km slab of the Nereid recovery zone. */
export const SECTOR = { minX: -2600, maxX: 2600, minY: -2100, maxY: 2100 };
export const STATION = { x: 1560, y: 1180 };
export const RELAY = { x: -640, y: -520 };
export const DERELICT = { x: -1180, y: 1760 };

/** Anything solid that is not an asteroid: the station ring and arms, the relay mast, the wreck. */
export type SolidBody =
  | { id: string; kind: 'circle'; x: number; y: number; radius: number; restitution: number }
  | { id: string; kind: 'box'; x: number; y: number; halfLength: number; halfWidth: number; angle: number; restitution: number };

/** Station ring 78 m, its two 294 m arms, the relay mast and the 160 m wreck — all drawn-extent sized. */
export const SOLID_BODIES: SolidBody[] = [
  { id: 'station-ring', kind: 'circle', x: STATION.x, y: STATION.y, radius: 78, restitution: 1.15 },
  { id: 'station-arm-port', kind: 'box', x: STATION.x - 112, y: STATION.y, halfLength: 44.5, halfWidth: 24, angle: 0, restitution: 1.15 },
  { id: 'station-arm-starboard', kind: 'box', x: STATION.x + 112, y: STATION.y, halfLength: 44.5, halfWidth: 24, angle: 0, restitution: 1.15 },
  { id: 'relay', kind: 'circle', x: RELAY.x, y: RELAY.y, radius: 20, restitution: 1.0 },
  { id: 'derelict', kind: 'box', x: DERELICT.x, y: DERELICT.y, halfLength: 80, halfWidth: 41, angle: 0, restitution: 1.1 },
];

/** Station bodies share an id prefix so the docking collar can open on all of them at once. */
export const isStationBody = (body: SolidBody) => body.id.startsWith('station');

/** Rock integrity scales with cross-section: a 70 m boulder is not a 10 m pebble. */
export const rockHP = (radius: number) => Math.round(14 + radius * radius * 0.42);

export function createCargo(): Cargo[] {
  return [
    { id: 'cargo-1', name: 'Flight recorder', kind: 'archive', position: { x: 1020, y: -1380 }, collected: false },
    { id: 'cargo-2', name: 'Research canister', kind: 'archive', position: { x: -1520, y: 420 }, collected: false },
    { id: 'cargo-3', name: 'Survey archive', kind: 'archive', position: { x: 300, y: 1860 }, collected: false },
    { id: 'blackbox', name: 'Kite’s End black box', kind: 'blackbox', position: { ...DERELICT }, collected: false },
  ];
}

export function randomSeed(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function createObstacles(): Obstacle[] {
  const rand = randomSeed(4712);
  const rocks: Obstacle[] = [];
  const keeps: { x: number; y: number; radius: number }[] = [
    ...createCargo().map(cargo => ({ ...cargo.position, radius: cargo.kind === 'blackbox' ? 200 : 135 })),
    { ...STATION, radius: 320 },
    { ...RELAY, radius: 175 },
  ];
  let id = 0;
  for (let i = 0; i < 460; i++) {
    const x = (rand() - 0.5) * 5200;
    const y = (rand() - 0.5) * 4200;
    const radius = 8 + Math.pow(rand(), 2) * 76;
    if (Math.hypot(x, y) < radius + 150) continue;
    if (keeps.some(keep => distance(keep, { x, y }) < radius + keep.radius * 0.8)) continue;
    const hp = rockHP(radius);
    rocks.push({ id: id++, x, y, radius, seed: i + 12, z: i % 5 === 0 ? -120 - rand() * 210 : 0, hp, maxHp: hp });
  }
  return rocks;
}

const CELL = 260;
const cellKey = (cx: number, cy: number) => cx * 8192 + cy;

/** Uniform grid over the static rock field: every ship, round and beam query goes through it. */
export class SpatialGrid {
  private cells = new Map<number, Obstacle[]>();

  constructor(obstacles: Obstacle[]) { for (const obstacle of obstacles) this.insert(obstacle); }

  private insert(obstacle: Obstacle) {
    // ponytail: a rock is filed by centre only, and CELL > 2 * maxRadius guarantees
    // a 3x3 neighbourhood query can never miss it. Re-derive CELL if radii grow.
    const key = cellKey(Math.floor(obstacle.x / CELL), Math.floor(obstacle.y / CELL));
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(obstacle); else this.cells.set(key, [obstacle]);
  }

  add(obstacle: Obstacle) { this.insert(obstacle); }

  remove(obstacle: Obstacle) { this.removeAt(obstacle, obstacle.x, obstacle.y); }

  private removeAt(obstacle: Obstacle, x: number, y: number) {
    const bucket = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
    const index = bucket?.indexOf(obstacle) ?? -1;
    if (index >= 0) bucket!.splice(index, 1);
  }

  /** Files a moving rock again after it has been repositioned. */
  refile(obstacle: Obstacle, previousX: number, previousY: number) {
    if (Math.floor(previousX / CELL) === Math.floor(obstacle.x / CELL) && Math.floor(previousY / CELL) === Math.floor(obstacle.y / CELL)) return;
    this.removeAt(obstacle, previousX, previousY);
    this.insert(obstacle);
  }

  /** Every rock whose cell touches the 3x3 neighbourhood of (x, y). */
  near(x: number, y: number, out: Obstacle[] = []): Obstacle[] {
    out.length = 0;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const bucket = this.cells.get(cellKey(cx + i, cy + j));
      if (bucket) for (const obstacle of bucket) out.push(obstacle);
    }
    return out;
  }
}

const contactPush = { x: 0, y: 0 };
const shipHull: Box = { x: 0, y: 0, halfLength: 59, halfWidth: 30, angle: 0 };
const bodyHull: Box = { x: 0, y: 0, halfLength: 0, halfWidth: 0, angle: 0 };

/** The ship collides as its drawn hull, not as a point: halfLength runs along its nose. */
export function shipBox(state: ShipState): Box {
  shipHull.x = state.position.x;
  shipHull.y = state.position.y;
  shipHull.halfLength = state.collider.halfLength;
  shipHull.halfWidth = state.collider.halfWidth;
  shipHull.angle = state.angle;
  return shipHull;
}

/** Resolves one contact and returns the hull damage it cost. */
function applyContact(state: ShipState, restitution: number): number {
  const push = Math.hypot(contactPush.x, contactPush.y);
  if (push < 1e-6) return 0;
  const nx = contactPush.x / push, ny = contactPush.y / push;
  state.position.x += contactPush.x;
  state.position.y += contactPush.y;
  const closing = state.velocity.x * nx + state.velocity.y * ny;
  if (closing >= 0) return 0;
  state.velocity.x -= restitution * closing * nx;
  state.velocity.y -= restitution * closing * ny;
  // Hull damage scales with closing speed but is capped, so a long high-speed leg cannot one-shot the ship.
  const damage = Math.min(42, Math.max(0, -closing - 4) * 0.9);
  state.hull = Math.max(0, state.hull - damage);
  return damage;
}

export function resolveCollision(state: ShipState, rock: Obstacle): number {
  if (rock.z !== 0 || rock.hp <= 0) return 0;
  // Asteroids are irregular, so their collider is a circle just inside the drawn silhouette.
  if (!obbCircleOut(shipBox(state), rock.x, rock.y, rock.radius * 0.92, contactPush)) return 0;
  // The MTV pushes the circle out of the box, so the hull moves the other way.
  contactPush.x = -contactPush.x; contactPush.y = -contactPush.y;
  return applyContact(state, 1.3);
}

export function resolveBodies(state: ShipState, docked: boolean): number {
  let damage = 0;
  for (const body of SOLID_BODIES) {
    // Docking clearance opens the station collar; everything else stays solid.
    if (docked && isStationBody(body)) continue;
    const box = shipBox(state);
    if (body.kind === 'circle') {
      if (!obbCircleOut(box, body.x, body.y, body.radius, contactPush)) continue;
      contactPush.x = -contactPush.x; contactPush.y = -contactPush.y;
    } else {
      bodyHull.x = body.x; bodyHull.y = body.y;
      bodyHull.halfLength = body.halfLength; bodyHull.halfWidth = body.halfWidth;
      bodyHull.angle = body.angle + stationSpin;
      if (!obbObbOut(bodyHull, box, contactPush)) continue;
    }
    damage += applyContact(state, body.restitution);
  }
  return damage;
}

/** The station turns slowly; its arm colliders turn with it. */
let stationSpin = 0;
export const setStationSpin = (angle: number) => { stationSpin = angle; };

/** Point test used by projectiles: rocks, ships and solid bodies all answer to it. */
export function bodyAt(x: number, y: number): SolidBody | undefined {
  for (const body of SOLID_BODIES) {
    if (body.kind === 'circle') {
      if (pointInCircle(body, x, y)) return body;
    } else {
      bodyHull.x = body.x; bodyHull.y = body.y;
      bodyHull.halfLength = body.halfLength; bodyHull.halfWidth = body.halfWidth;
      bodyHull.angle = body.angle + stationSpin;
      if (pointInBox(bodyHull, x, y)) return body;
    }
  }
  return undefined;
}

export function canRecover(state: ShipState, cargo: Cargo) {
  return !cargo.collected && distance(state.position, cargo.position) < 75 && length(state.velocity) < 12;
}

export function canDock(state: ShipState) {
  return distance(state.position, STATION) < 115 && length(state.velocity) < 8;
}

export type Ore = { id: number; x: number; y: number; vx: number; vy: number; amount: number; life: number };

/**
 * Breaks a rock. Returns the fragments it left behind; the caller adds them to the grid and the scene.
 * Below 20 m a rock simply vanishes: fragments smaller than that are noise the player cannot hit.
 */
export function fractureRock(rock: Obstacle, nextId: () => number, rand: () => number = Math.random): { fragments: Obstacle[]; ore: Ore[] } {
  rock.hp = 0;
  const fragments: Obstacle[] = [];
  const ore: Ore[] = [];
  const pieces = rock.radius >= 20 ? (rock.radius > 48 ? 3 : 2) : 0;
  for (let i = 0; i < pieces; i++) {
    const angle = (i / pieces) * Math.PI * 2 + rand() * 0.8;
    // Conserve area, not radius: r_child = r_parent / sqrt(pieces) keeps the mass roughly honest,
    // and the 0.9-1.0 spread keeps the total inside the 25% budget the fracture contract promises.
    const radius = Math.max(9, rock.radius / Math.sqrt(pieces) * (0.9 + rand() * 0.1));
    const push = 14 + rand() * 22;
    const id = nextId();
    fragments.push({
      id, seed: id * 7 + 3, z: 0,
      x: rock.x + Math.cos(angle) * rock.radius * 0.5,
      y: rock.y + Math.sin(angle) * rock.radius * 0.5,
      radius, hp: rockHP(radius), maxHp: rockHP(radius),
      vx: Math.cos(angle) * push, vy: Math.sin(angle) * push,
    });
  }
  const drops = 1 + Math.floor(rock.radius / 26);
  for (let i = 0; i < drops; i++) {
    const angle = rand() * Math.PI * 2, push = 8 + rand() * 26;
    ore.push({
      id: nextId(), x: rock.x + Math.cos(angle) * rock.radius * 0.4, y: rock.y + Math.sin(angle) * rock.radius * 0.4,
      vx: Math.cos(angle) * push, vy: Math.sin(angle) * push,
      amount: Math.round(6 + rock.radius * 0.9), life: 90,
    });
  }
  return { fragments, ore };
}

export const ORE_PICKUP_RADIUS = 62;
/** Ore sold at Wayfarer, per unit. */
export const ORE_PRICE = 4;

/** Drifting ore, collected on proximity into whatever hold space is left. Returns the amount taken this step. */
export function stepOre(ore: Ore[], state: ShipState, dt: number, pickupRadius = ORE_PICKUP_RADIUS, space = Number.POSITIVE_INFINITY): number {
  let taken = 0;
  for (let i = ore.length - 1; i >= 0; i--) {
    const chunk = ore[i];
    chunk.x += chunk.vx * dt; chunk.y += chunk.vy * dt;
    chunk.vx *= 0.995; chunk.vy *= 0.995;
    chunk.life -= dt;
    const range = Math.hypot(chunk.x - state.position.x, chunk.y - state.position.y);
    if (range < pickupRadius && taken < space) {
      // Inside the collector envelope it is drawn in, so pickup reads as a deliberate scoop.
      const pull = (1 - range / pickupRadius) * 260 * dt;
      chunk.x += (state.position.x - chunk.x) * Math.min(1, pull / Math.max(range, 1));
      chunk.y += (state.position.y - chunk.y) * Math.min(1, pull / Math.max(range, 1));
    }
    if (range < 26 && taken < space) {
      taken += Math.min(chunk.amount, space - taken);
      ore.splice(i, 1);
    } else if (chunk.life <= 0) ore.splice(i, 1);
  }
  return taken;
}

/** Moves fragments and files them again in the grid when they cross a cell. */
export function stepFragments(fragments: Obstacle[], grid: SpatialGrid, dt: number) {
  for (const fragment of fragments) {
    if (fragment.vx === undefined || fragment.vy === undefined) continue;
    const previousX = fragment.x, previousY = fragment.y;
    const decay = Math.pow(0.995, dt * 120);
    fragment.vx *= decay; fragment.vy *= decay;
    fragment.x += fragment.vx * dt; fragment.y += fragment.vy * dt;
    grid.refile(fragment, previousX, previousY);
  }
}
