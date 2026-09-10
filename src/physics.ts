export type Vec2 = { x: number; y: number };
export type ShipClass = 'kestrel' | 'mule' | 'needle';
export type FlightInput = { thrust: number; turn: number; strafe: number; brake: boolean; boost: boolean };

export type ShipSpec = { name: string; role: string; mass: number; thrust: number; fuel: number; torque: number; hull: number; length: number };

/** The complete ship customization surface. Validated by `sanitizeLoadout`, never trusted from a client. */
export type Loadout = { chassis: ShipClass; hullPts: number; thrustPts: number; fuelPts: number; torquePts: number; color: string };

export const SHIPS = {
  kestrel: { name: 'Kestrel', role: 'Independent corvette', mass: 82000, thrust: 1600000, fuel: 16000, torque: 1.35, hull: 100, length: 42 },
  mule: { name: 'Mule', role: 'Heavy salvage tug', mass: 142000, thrust: 1950000, fuel: 30000, torque: 0.82, hull: 150, length: 58 },
  needle: { name: 'Needle', role: 'Fast reconnaissance cutter', mass: 43000, thrust: 1200000, fuel: 10000, torque: 2.05, hull: 75, length: 31 },
} as const;

/** Points scale the base chassis by at most 25% either way, so nothing dominates. */
export function specFor(l: Loadout): ShipSpec {
  const base = SHIPS[l.chassis];
  const f = (pts: number) => 1 + (pts - 2.5) * 0.10;   // 0 pts -> 0.75x, 5 pts -> 1.25x
  return {
    ...base,
    hull: Math.round(base.hull * f(l.hullPts)),
    thrust: Math.round(base.thrust * f(l.thrustPts)),
    fuel: Math.round(base.fuel * f(l.fuelPts)),
    torque: Number((base.torque * f(l.torquePts)).toFixed(3)),
  };
}

export const defaultLoadout = (chassis: ShipClass = 'kestrel'): Loadout =>
  ({ chassis, hullPts: 2.5, thrustPts: 2.5, fuelPts: 2.5, torquePts: 2.5, color: '#dce6e8' });

export type ShipState = {
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  fuel: number;
  hull: number;
  heat: number;
  acceleration: number;
  thrustLevel: number;
  rcsActive: boolean;
  assist: boolean;
  shipClass: ShipClass;
  /** Derived from the loadout. `stepShip` and `resolveCollision` read this, never `SHIPS` directly. */
  spec: ShipSpec;
};

export function createShip(shipClass: ShipClass = 'kestrel', loadout?: Loadout): ShipState {
  const spec = loadout ? specFor(loadout) : { ...SHIPS[shipClass] };
  return {
    position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: -0.63,
    angularVelocity: 0, fuel: spec.fuel, hull: spec.hull,
    heat: 0, acceleration: 0, thrustLevel: 0, rcsActive: false, assist: true, shipClass, spec,
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
  state.heat = clamp(state.heat + (Math.abs(thrust) > 1 ? 0.09 : Math.abs(thrust) * 0.016 - 0.055) * dt, 0, 1);
}

export type Rock = {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  hp: number;
  mass: number;
  seed: number;
  /** z !== 0 means background scenery: rendered, never simulated. */
  z: number;
};
export type Obstacle = Rock;

export const ROCK_DENSITY = 900;      // kg per m^2 of cross-section. 20 m rock ~ 1.1e6 kg.
export const ROCK_HP_K = 0.9;         // hp = radius^2 * ROCK_HP_K. 20 m rock = 360 hp.
export const ROCK_MIN_R = 7;          // below this a rock is dust: destroy, do not split.
export const ROCK_SPLIT_R = 0.62;     // child radius factor (2-3 children ~ conserves area)
export const RESTITUTION = 0.3;       // matches the original 1.3x closing-speed reflection

export const rockMass = (r: number) => Math.PI * r * r * ROCK_DENSITY;
export const rockHp = (r: number) => r * r * ROCK_HP_K;

export type Cargo = { id: string; name: string; position: Vec2; collected: boolean };
export const STATION = { x: 660, y: 530 };
export function createCargo(): Cargo[] {
  return [
    { id: 'cargo-1', name: 'Flight recorder', position: { x: 220, y: 190 }, collected: false },
    { id: 'cargo-2', name: 'Research canister', position: { x: -240, y: 390 }, collected: false },
    { id: 'cargo-3', name: 'Survey archive', position: { x: 450, y: -200 }, collected: false },
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
  const cargo = createCargo();
  for (let i = 0; i < 90; i++) {
    const x = (rand() - 0.5) * 2600;
    const y = (rand() - 0.5) * 2100;
    const radius = 9 + Math.pow(rand(), 2) * 62;
    if (Math.hypot(x, y) < radius + 145 || distance({ x, y }, STATION) < radius + 155 || cargo.some(c => distance(c.position, { x, y }) < radius + 100)) continue;
    rocks.push({ id: i, x, y, vx: 0, vy: 0, radius, hp: rockHp(radius), mass: rockMass(radius), seed: i + 12, z: i % 4 === 0 ? -100 - rand() * 170 : 0 });
  }
  return rocks;
}

/**
 * Impulse-based ship/rock response. Both bodies move: the correction and the impulse are split by
 * mass, so a light rock is shoved aside and a heavy one barely notices. Returns hull damage.
 */
export function resolveCollision(state: ShipState, rock: Rock): number {
  if (rock.z !== 0) return 0;
  const dx = state.position.x - rock.x;
  const dy = state.position.y - rock.y;
  const dist = Math.hypot(dx, dy);
  const clearance = rock.radius * 0.83 + Math.max(14, state.spec.length * 0.33);
  if (dist >= clearance) return 0;
  const nx = dist > 0.001 ? dx / dist : 1;
  const ny = dist > 0.001 ? dy / dist : 0;

  const shipMass = state.spec.mass + state.fuel;
  const total = shipMass + rock.mass;

  // Positional de-overlap. The pair separates by exactly `push`.
  const push = clearance - dist;
  state.position.x += nx * push * (rock.mass / total);
  state.position.y += ny * push * (rock.mass / total);
  rock.x -= nx * push * (shipMass / total);
  rock.y -= ny * push * (shipMass / total);

  const rvx = state.velocity.x - rock.vx;
  const rvy = state.velocity.y - rock.vy;
  const closing = rvx * nx + rvy * ny;
  if (closing >= 0) return 0;

  const j = -(1 + RESTITUTION) * closing / (1 / shipMass + 1 / rock.mass);
  state.velocity.x += j * nx / shipMass;
  state.velocity.y += j * ny / shipMass;
  rock.vx -= j * nx / rock.mass;
  rock.vy -= j * ny / rock.mass;

  const damage = Math.max(0, -closing - 2) * 1.5;
  state.hull = Math.max(0, state.hull - damage);
  rock.hp -= damage * 4;                            // ramming chips rocks; the caller checks hp <= 0
  return damage;
}

/**
 * Fracture a rock into 2-3 children. Area is approximately conserved, so total mass drops slightly;
 * the evenly spaced outward kicks sum to ~0, so linear momentum survives to within float error.
 */
export function splitRock(rock: Rock, impactAngle: number, nextId: () => number): Rock[] {
  if (rock.radius * ROCK_SPLIT_R < ROCK_MIN_R) return [];      // dust: the caller emits rockGone
  const n = rock.radius > 26 ? 3 : 2;
  const cr = rock.radius * (n === 3 ? 0.577 : 0.707) * 0.95;
  const kick = 6 + 40 / rock.radius;
  const out: Rock[] = [];
  for (let i = 0; i < n; i++) {
    const a = impactAngle + Math.PI / 2 + i / n * Math.PI * 2;
    out.push({
      id: nextId(),
      x: rock.x + Math.cos(a) * cr * 1.05,
      y: rock.y + Math.sin(a) * cr * 1.05,
      vx: rock.vx + Math.cos(a) * kick,
      vy: rock.vy + Math.sin(a) * kick,
      radius: cr, hp: rockHp(cr), mass: rockMass(cr),
      seed: (rock.seed * 31 + i * 7) % 100000, z: 0,
    });
  }
  return out;
}

export function canRecover(state: ShipState, cargo: Cargo) {
  return !cargo.collected && distance(state.position, cargo.position) < 75 && length(state.velocity) < 12;
}
export function canDock(state: ShipState) {
  return distance(state.position, STATION) < 115 && length(state.velocity) < 8;
}
