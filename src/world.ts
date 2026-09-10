import {
  clamp, createShip, randomSeed, resolveCollision, rockHp, rockMass, splitRock, stepShip,
  type FlightInput, type Loadout, type Rock, type ShipClass, type ShipState,
} from './physics';

export type { Loadout, Rock };

export type TeamId = 'blue' | 'red' | 'pirate';
export const TEAMS: TeamId[] = ['blue', 'red', 'pirate'];

export const LOADOUT_BUDGET = 10;
export const PALETTE = ['#dce6e8', '#83b9b5', '#efb879', '#df8277', '#8fa4c8', '#a8c08a'];
const CHASSIS: Record<ShipClass, true> = { kestrel: true, mule: true, needle: true };

export type PlayerMeta = { id: string; name: string; team: TeamId; loadout: Loadout };
export type LobbyPlayer = PlayerMeta & { ready: boolean; isHost: boolean };

export type Player = {
  id: string; name: string; team: TeamId; loadout: Loadout;
  ship: ShipState;
  dead: boolean; respawnAt: number;
  kills: number; deaths: number;
  cooldown: number;
  input: FlightInput & { fire: boolean };
  lastSeq: number;
};

export type Bullet = { id: number; x: number; y: number; vx: number; vy: number; ttl: number; owner: string; team: TeamId; damage: number };

export type WorldEvent =
  | { e: 'rockSplit'; id: number; children: Rock[] }
  | { e: 'rockGone'; id: number }
  | { e: 'kill'; killer: string; victim: string }
  | { e: 'hit'; id: string; dmg: number; x: number; y: number }
  | { e: 'spawn'; id: string; x: number; y: number }
  | { e: 'join'; player: PlayerMeta }
  | { e: 'leave'; id: string };

export type World = {
  tick: number; time: number;
  phase: 'lobby' | 'playing';
  map: MapDef;
  players: Map<string, Player>;
  rocks: Map<number, Rock>;
  bullets: Bullet[];
  events: WorldEvent[];
  nextEntityId: number;
};

export type MapDef = {
  id: string; name: string; seed: number; radius: number;
  rockCount: number; spreadX: number; spreadY: number; rockMin: number; rockMax: number;
  spawns: Record<TeamId, { x: number; y: number }[]>;
};

export const MAPS: MapDef[] = [
  {
    id: 'belt', name: 'Drift Belt', seed: 4712, radius: 1500, rockCount: 110,
    spreadX: 2600, spreadY: 2100, rockMin: 9, rockMax: 71,
    spawns: {
      blue: [{ x: -900, y: -700 }, { x: -1040, y: -480 }],
      red: [{ x: 900, y: 700 }, { x: 1040, y: 480 }],
      pirate: [{ x: 0, y: 1150 }, { x: 0, y: -1150 }],
    },
  },
  {
    id: 'quarry', name: 'The Quarry', seed: 9031, radius: 1100, rockCount: 190,
    spreadX: 1900, spreadY: 1900, rockMin: 7, rockMax: 38,
    spawns: {
      blue: [{ x: -760, y: -240 }, { x: -760, y: 240 }],
      red: [{ x: 760, y: 240 }, { x: 760, y: -240 }],
      pirate: [{ x: 0, y: 820 }, { x: 0, y: -820 }],
    },
  },
  {
    id: 'expanse', name: 'Open Expanse', seed: 2255, radius: 2200, rockCount: 55,
    spreadX: 3800, spreadY: 3200, rockMin: 14, rockMax: 95,
    spawns: {
      blue: [{ x: -1500, y: -1100 }, { x: -1700, y: -800 }],
      red: [{ x: 1500, y: 1100 }, { x: 1700, y: 800 }],
      pirate: [{ x: 0, y: 1800 }, { x: 0, y: -1800 }],
    },
  },
];

export const mapById = (id: string) => MAPS.find(m => m.id === id) ?? MAPS[0];

export const GUN = {
  // ponytail: discrete bullet steps. At 420 m/s a bullet moves 3.5 m per 120 Hz tick, well under
  // ROCK_MIN_R = 7, so nothing tunnels. Above ~800 m/s this needs segment-vs-circle sweeping.
  speed: 420,
  cooldown: 0.16,
  damage: 9,
  rockDamage: 26,
  ttl: 3.2,
  offset: 26,
  radius: 1.5,
};
export const RESPAWN_DELAY = 5;
export const SHIP_RADIUS = (s: ShipState) => s.spec.length * 0.42;

export function spawnPoint(map: MapDef, team: TeamId, salt: number) {
  const list = map.spawns[team];
  return list[Math.abs(salt) % list.length];
}

/**
 * Deterministic on both server and client, which is what lets rocks stay off the wire entirely.
 * Every `rand()` call is unconditional and in a fixed order; the `continue` runs after all four.
 * Reordering or short-circuiting them puts rocks in different places on different machines.
 */
export function createRocks(map: MapDef): Map<number, Rock> {
  const rand = randomSeed(map.seed);
  const spawnList = TEAMS.flatMap(t => map.spawns[t]);
  const out = new Map<number, Rock>();
  for (let i = 0; i < map.rockCount; i++) {
    const x = (rand() - 0.5) * map.spreadX;
    const y = (rand() - 0.5) * map.spreadY;
    const radius = map.rockMin + Math.pow(rand(), 2) * (map.rockMax - map.rockMin);
    const back = rand();
    const z = i % 5 === 0 ? -100 - back * 170 : 0;
    if (z === 0 && spawnList.some(s => Math.hypot(s.x - x, s.y - y) < radius + 190)) continue;
    out.set(i, { id: i, x, y, vx: 0, vy: 0, radius, hp: rockHp(radius), mass: rockMass(radius), seed: i + 12, z });
  }
  return out;
}

export function sanitizeLoadout(raw: unknown): Loadout {
  const l = (raw ?? {}) as Partial<Loadout>;
  const pt = (v: unknown) => clamp(Math.floor(Number(v) || 0), 0, 5);
  const out: Loadout = {
    chassis: typeof l.chassis === 'string' && l.chassis in CHASSIS ? l.chassis as ShipClass : 'kestrel',
    hullPts: pt(l.hullPts), thrustPts: pt(l.thrustPts), fuelPts: pt(l.fuelPts), torquePts: pt(l.torquePts),
    color: PALETTE.includes(l.color as string) ? l.color as string : PALETTE[0],
  };
  // Spend down rather than reject: a stale or hostile client stays playable instead of erroring.
  const keys = ['torquePts', 'fuelPts', 'thrustPts', 'hullPts'] as const;
  let spent = keys.reduce((sum, k) => sum + out[k], 0);
  for (const k of keys) {
    if (spent <= LOADOUT_BUDGET) break;
    const take = Math.min(out[k], spent - LOADOUT_BUDGET);
    out[k] -= take; spent -= take;
  }
  return out;
}

// ponytail: soft radial boundary. A hard wall or a wrapping torus are both bigger changes.
export function applyArenaBounds(ship: ShipState, map: MapDef, dt: number) {
  const d = Math.hypot(ship.position.x, ship.position.y);
  if (d < map.radius) return;
  const nx = ship.position.x / d, ny = ship.position.y / d;
  const pull = Math.min(60, (d - map.radius) * 0.35);
  ship.velocity.x -= nx * pull * dt;
  ship.velocity.y -= ny * pull * dt;
  if (d > map.radius * 1.25) ship.hull = Math.max(0, ship.hull - 14 * dt);
}

/** Put a player at their team's spawn point, facing the arena centre, with a fresh ship. */
export function spawnPlayer(world: World, p: Player, salt: number) {
  const pt = spawnPoint(world.map, p.team, salt);
  p.ship = createShip(p.loadout.chassis, p.loadout);
  p.ship.position = { ...pt };
  p.ship.angle = Math.atan2(pt.x, -pt.y);   // forward = (-sin, cos), so this faces the arena centre
  p.dead = false; p.cooldown = 0; p.input.fire = false;
  world.events.push({ e: 'spawn', id: p.id, x: pt.x, y: pt.y });
}

function killPlayer(world: World, p: Player, killerId: string | null) {
  if (p.dead) return;
  p.dead = true; p.deaths++; p.respawnAt = world.time + RESPAWN_DELAY;
  const killer = killerId ? world.players.get(killerId) : undefined;
  if (killer && killer.id !== p.id) killer.kills++;
  world.events.push({ e: 'kill', killer: killerId ?? '', victim: p.id });
}

function spawnBullet(world: World, p: Player) {
  const s = p.ship;
  const fx = -Math.sin(s.angle), fy = Math.cos(s.angle);   // must match stepShip's forward vector
  world.bullets.push({
    id: world.nextEntityId++,
    x: s.position.x + fx * GUN.offset,
    y: s.position.y + fy * GUN.offset,
    vx: s.velocity.x + fx * GUN.speed,
    vy: s.velocity.y + fy * GUN.speed,
    ttl: GUN.ttl, owner: p.id, team: p.team, damage: GUN.damage,
  });
}

function fracture(world: World, rock: Rock, impactAngle: number) {
  world.rocks.delete(rock.id);
  const children = splitRock(rock, impactAngle, () => world.nextEntityId++);
  if (children.length === 0) { world.events.push({ e: 'rockGone', id: rock.id }); return; }
  for (const c of children) world.rocks.set(c.id, c);
  world.events.push({ e: 'rockSplit', id: rock.id, children });
}

/** One 120 Hz tick. Deterministic: no randomness, no clock reads, no DOM. */
export function stepWorld(world: World, dt: number) {
  world.time += dt; world.tick++;

  // 1. ships
  for (const p of world.players.values()) {
    if (p.dead) { if (world.time >= p.respawnAt) spawnPlayer(world, p, world.tick + p.name.length); continue; }
    stepShip(p.ship, p.input, dt);
    applyArenaBounds(p.ship, world.map, dt);
    p.cooldown = Math.max(0, p.cooldown - dt);
    if (p.input.fire && p.cooldown === 0 && p.ship.hull > 0) { spawnBullet(world, p); p.cooldown = GUN.cooldown; }
  }

  // 2. rocks drift. No rock-vs-rock collision on purpose: fragments pass through each other.
  for (const rock of world.rocks.values()) {
    if (rock.vx || rock.vy) { rock.x += rock.vx * dt; rock.y += rock.vy * dt; }
  }

  // 3. hull vs rock
  // ponytail: O(players x rocks) with no broadphase. Add a spatial hash above ~600 rocks.
  const broken: { rock: Rock; angle: number }[] = [];
  for (const p of world.players.values()) {
    if (p.dead) continue;
    for (const rock of world.rocks.values()) {
      if (resolveCollision(p.ship, rock) > 0 && rock.hp <= 0) {
        broken.push({ rock, angle: Math.atan2(p.ship.position.y - rock.y, p.ship.position.x - rock.x) });
      }
    }
    if (p.ship.hull <= 0) killPlayer(world, p, null);
  }
  for (const hit of broken) if (world.rocks.has(hit.rock.id)) fracture(world, hit.rock, hit.angle);

  // 4. bullets. Iterated backwards so removal is a plain splice.
  for (let i = world.bullets.length - 1; i >= 0; i--) {
    const b = world.bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.ttl -= dt;
    if (b.ttl <= 0) { world.bullets.splice(i, 1); continue; }

    let spent = false;
    for (const rock of world.rocks.values()) {
      if (Math.hypot(b.x - rock.x, b.y - rock.y) >= rock.radius) continue;
      rock.hp -= GUN.rockDamage;
      world.events.push({ e: 'hit', id: b.owner, dmg: GUN.rockDamage, x: b.x, y: b.y });
      world.bullets.splice(i, 1); spent = true;
      if (rock.hp <= 0) fracture(world, rock, Math.atan2(b.vy, b.vx));
      break;
    }
    if (spent) continue;

    for (const p of world.players.values()) {
      if (p.dead || p.id === b.owner || p.team === b.team) continue;
      if (Math.hypot(b.x - p.ship.position.x, b.y - p.ship.position.y) >= SHIP_RADIUS(p.ship)) continue;
      p.ship.hull = Math.max(0, p.ship.hull - b.damage);
      world.events.push({ e: 'hit', id: p.id, dmg: b.damage, x: b.x, y: b.y });
      world.bullets.splice(i, 1);
      if (p.ship.hull <= 0) killPlayer(world, p, b.owner);
      break;
    }
  }

  if (world.bullets.length > 400) world.bullets.splice(0, world.bullets.length - 400);
}

/* ---------- wire protocol ---------- */

export type PackedInput = { th: number; tu: number; st: number; b: 0 | 1; bo: 0 | 1; f: 0 | 1 };
export type WirePlayer = {
  id: string; x: number; y: number; vx: number; vy: number; a: number; av: number;
  hp: number; fu: number; ht: number; th: number; ac: number; rcs: 0 | 1; dead: 0 | 1; k: number; d: number; ack: number;
};
export type WireBullet = { id: number; x: number; y: number; vx: number; vy: number; tm: number };
/** What the renderer consumes each frame: distinct from the wire message because the client interpolates. */
export type RenderView = { players: WirePlayer[]; bullets: WireBullet[] };
export type ScoreRow = { id: string; name: string; team: TeamId; kills: number; deaths: number };

export type C2S =
  | { t: 'hello'; name: string }
  | { t: 'lobby'; name?: string; team: TeamId; loadout: Loadout; ready: boolean; mapId?: string }
  | { t: 'start' }
  | { t: 'end' }
  | { t: 'input'; seq: number; i: PackedInput }
  | { t: 'respawn' }
  | { t: 'ping'; c: number };

export type S2C =
  | { t: 'welcome'; you: string; you_is_host: boolean; mapId: string; host: string }
  | { t: 'lobby'; players: LobbyPlayer[]; mapId: string }
  | { t: 'begin'; mapSeed: number; mapId: string; players: PlayerMeta[]; startTick: number }
  | { t: 'rocksFull'; rocks: Rock[] }
  | { t: 'snap'; k: number; p: WirePlayer[]; b: WireBullet[] }
  | { t: 'ev'; k: number; e: WorldEvent[] }
  | { t: 'debrief'; players: ScoreRow[] }
  | { t: 'pong'; c: number }
  | { t: 'bye'; id: string };

/** Level-triggered input. Fire is a held flag with a server-side cooldown, never an edge event. */
export function packInput(input: FlightInput & { fire: boolean }): PackedInput {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { th: r(input.thrust), tu: r(input.turn), st: r(input.strafe), b: input.brake ? 1 : 0, bo: input.boost ? 1 : 0, f: input.fire ? 1 : 0 };
}

/** Server-side validation of an untrusted input packet. Clamps every field. */
export function unpackInput(raw: Partial<PackedInput> | undefined): FlightInput & { fire: boolean } {
  const num = (v: unknown, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) ? clamp(x, lo, hi) : 0; };
  return {
    thrust: num(raw?.th, -0.28, 1), turn: num(raw?.tu, -1, 1), strafe: num(raw?.st, -1, 1),
    brake: raw?.b === 1, boost: raw?.bo === 1, fire: raw?.f === 1,
  };
}
