export type Vec2 = { x: number; y: number };
export type ShipClass = 'kestrel' | 'mule' | 'needle';
export type FlightInput = { thrust: number; turn: number; strafe: number; brake: boolean; boost: boolean };

export const SHIPS = {
  kestrel: { name: 'Kestrel', role: 'Independent corvette', mass: 82000, thrust: 1600000, fuel: 16000, torque: 1.35, hull: 100, length: 42 },
  mule: { name: 'Mule', role: 'Heavy salvage tug', mass: 142000, thrust: 1950000, fuel: 30000, torque: 0.82, hull: 150, length: 58 },
  needle: { name: 'Needle', role: 'Fast reconnaissance cutter', mass: 43000, thrust: 1200000, fuel: 10000, torque: 2.05, hull: 75, length: 31 },
} as const;

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
};

export function createShip(shipClass: ShipClass = 'kestrel'): ShipState {
  return {
    position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: -0.63,
    angularVelocity: 0, fuel: SHIPS[shipClass].fuel, hull: SHIPS[shipClass].hull,
    heat: 0, acceleration: 0, thrustLevel: 0, rcsActive: false, assist: true, shipClass,
  };
}

export const length = (v: Vec2) => Math.hypot(v.x, v.y);
export const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const heading = (angle: number) => ((-angle * 180 / Math.PI) % 360 + 360) % 360;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const emptyInput = (): FlightInput => ({ thrust: 0, turn: 0, strafe: 0, brake: false, boost: false });

/** Newtonian planar motion, integrated with semi-implicit Euler at a fixed 120 Hz. */
export function stepShip(state: ShipState, input: FlightInput, dt: number) {
  const spec = SHIPS[state.shipClass];
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

export type Obstacle = { x: number; y: number; radius: number; seed: number; z: number };
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
    rocks.push({ x, y, radius, seed: i + 12, z: i % 4 === 0 ? -100 - rand() * 170 : 0 });
  }
  return rocks;
}

/** Collision normals reflect only the inward component of velocity. */
export function resolveCollision(state: ShipState, rock: Obstacle): number {
  if (rock.z !== 0) return 0;
  const dx = state.position.x - rock.x;
  const dy = state.position.y - rock.y;
  const dist = Math.hypot(dx, dy);
  const clearance = rock.radius * 0.83 + 14;
  if (dist >= clearance) return 0;
  const nx = dist > 0.001 ? dx / dist : 1;
  const ny = dist > 0.001 ? dy / dist : 0;
  state.position.x = rock.x + nx * clearance;
  state.position.y = rock.y + ny * clearance;
  const closingSpeed = state.velocity.x * nx + state.velocity.y * ny;
  if (closingSpeed >= 0) return 0;
  state.velocity.x -= 1.3 * closingSpeed * nx;
  state.velocity.y -= 1.3 * closingSpeed * ny;
  const damage = Math.max(0, -closingSpeed - 2) * 1.5;
  state.hull = Math.max(0, state.hull - damage);
  return damage;
}

export function canRecover(state: ShipState, cargo: Cargo) {
  return !cargo.collected && distance(state.position, cargo.position) < 75 && length(state.velocity) < 12;
}
export function canDock(state: ShipState) {
  return distance(state.position, STATION) < 115 && length(state.velocity) < 8;
}
