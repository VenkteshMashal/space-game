import { describe, expect, test } from 'bun:test';
import { createShip, defaultLoadout, emptyInput, rockHp, rockMass } from '../src/physics';
import type { Rock } from '../src/physics';
import {
  applyArenaBounds, createRocks, GUN, LOADOUT_BUDGET, MAPS, PALETTE, RESPAWN_DELAY,
  sanitizeLoadout, spawnPoint, stepWorld, TEAMS, unpackInput,
} from '../src/world';
import type { Player, TeamId, World } from '../src/world';

const rockAt = (id: number, radius: number, x: number, y: number, over: Partial<Rock> = {}): Rock =>
  ({ id, x, y, vx: 0, vy: 0, radius, hp: rockHp(radius), mass: rockMass(radius), seed: id, z: 0, ...over });

function makePlayer(id: string, team: TeamId, over: Partial<Player> = {}): Player {
  const loadout = defaultLoadout('kestrel');
  return {
    id, name: id, team, loadout,
    ship: createShip(loadout.chassis, loadout),
    dead: false, respawnAt: 0, kills: 0, deaths: 0, cooldown: 0,
    input: { ...emptyInput(), fire: false }, lastSeq: 0, ...over,
  };
}

function makeWorld(roster: [string, TeamId][], over: Partial<World> = {}): World {
  const world: World = {
    tick: 0, time: 0, phase: 'playing', map: MAPS[0],
    players: new Map(), rocks: new Map(), bullets: [], events: [],
    nextEntityId: MAPS[0].rockCount + 1000, ...over,
  };
  for (const [id, team] of roster) world.players.set(id, makePlayer(id, team));
  return world;
}

/** Park a ship at a known point with zero velocity, nose along +x. */
function aim(world: World, id: string, x: number, y: number) {
  const p = world.players.get(id)!;
  p.ship.position = { x, y };
  p.ship.velocity = { x: 0, y: 0 };
  p.ship.angle = -Math.PI / 2;
  return p;
}

const run = (world: World, ticks: number) => { for (let i = 0; i < ticks; i++) stepWorld(world, 1 / 120); };

function serialize(world: World) {
  return JSON.stringify({
    tick: world.tick, time: world.time,
    players: [...world.players.values()].map(p => ({
      id: p.id, x: p.ship.position.x, y: p.ship.position.y, vx: p.ship.velocity.x, vy: p.ship.velocity.y,
      a: p.ship.angle, av: p.ship.angularVelocity, hp: p.ship.hull, fu: p.ship.fuel, ht: p.ship.heat,
      dead: p.dead, kills: p.kills, deaths: p.deaths,
    })),
    rocks: [...world.rocks.values()].map(r => [r.id, r.x, r.y, r.vx, r.vy, r.radius, r.hp]),
    bullets: world.bullets.map(b => [b.id, b.x, b.y, b.vx, b.vy, b.ttl]),
    events: world.events,
  });
}

describe('determinism', () => {
  test('two worlds from the same seed and inputs are identical after 600 ticks', () => {
    const build = () => {
      const roster: [string, TeamId][] = [['alpha', 'blue'], ['bravo', 'red'], ['charlie', 'pirate']];
      const world = makeWorld(roster, { rocks: createRocks(MAPS[0]) });
      for (const [id, team] of roster) {
        const p = world.players.get(id)!;
        p.ship.position = { ...spawnPoint(MAPS[0], team, id.length) };
        p.input = { ...emptyInput(), thrust: 1, turn: id === 'alpha' ? 1 : -0.5, fire: true };
      }
      return world;
    };
    const a = build(), b = build();
    run(a, 600); run(b, 600);
    expect(a.rocks.size).not.toBe(MAPS[0].rockCount);      // the scripted volley actually broke rock
    expect(a.bullets.length).toBeGreaterThan(0);
    expect(serialize(a)).toEqual(serialize(b));
  });

  test('createRocks returns identical fields for two calls with the same map', () => {
    const a = createRocks(MAPS[0]), b = createRocks(MAPS[0]);
    expect(a.size).toBe(b.size);
    expect([...a.values()]).toEqual([...b.values()]);
    const spawns = TEAMS.flatMap(t => MAPS[0].spawns[t]);
    for (const r of a.values()) {
      if (r.z === 0) expect(spawns.some(s => Math.hypot(s.x - r.x, s.y - r.y) < r.radius + 190)).toBe(false);
    }
  });
});

describe('combat', () => {
  test('fire is level-triggered and paced by the server cooldown', () => {
    const world = makeWorld([['gunner', 'blue']], { rocks: new Map() });
    const gunner = aim(world, 'gunner', 0, 0);
    gunner.input.fire = true;
    stepWorld(world, 1 / 120);
    expect(world.bullets).toHaveLength(1);
    expect(world.bullets[0].x).toBeCloseTo(GUN.offset + GUN.speed / 120, 6);
    expect(world.bullets[0].vx).toBeCloseTo(GUN.speed, 6);
    expect(world.bullets[0].vy).toBeCloseTo(0, 6);

    run(world, 5);
    expect(world.bullets).toHaveLength(1);                                // still cooling down
    run(world, Math.ceil(GUN.cooldown * 120) + 1);
    expect(world.bullets.length).toBeGreaterThanOrEqual(2);               // held trigger keeps firing
  });

  test('a bullet damages an enemy and passes through a teammate', () => {
    const world = makeWorld([['gunner', 'blue'], ['friend', 'blue'], ['target', 'red']], { rocks: new Map() });
    const gunner = aim(world, 'gunner', 0, 0);
    aim(world, 'friend', 200, 0);
    aim(world, 'target', 400, 0);
    gunner.input.fire = true; stepWorld(world, 1 / 120); gunner.input.fire = false;
    run(world, 180);
    expect(world.players.get('friend')!.ship.hull).toBe(100);
    expect(world.players.get('target')!.ship.hull).toBe(100 - GUN.damage);
  });

  test('a pirate bullet damages both fleets', () => {
    const world = makeWorld([['raider', 'pirate'], ['blue', 'blue'], ['red', 'red']], { rocks: new Map() });
    const raider = aim(world, 'raider', 0, 0);
    const blue = aim(world, 'blue', 200, 0);
    aim(world, 'red', 400, 0);
    blue.ship.hull = 10;                       // dies after two hits, clearing the line to red
    raider.input.fire = true;
    run(world, 200);
    expect(blue.dead).toBe(true);
    expect(world.players.get('red')!.ship.hull).toBeLessThan(100);
  });

  test('killing a player credits the killer and respawns on the timer', () => {
    const world = makeWorld([['raider', 'pirate'], ['victim', 'red']], { rocks: new Map() });
    const raider = aim(world, 'raider', 0, 0);
    const victim = aim(world, 'victim', 200, 0);
    victim.ship.hull = 5;
    raider.input.fire = true; stepWorld(world, 1 / 120); raider.input.fire = false;

    run(world, 120);
    expect(victim.dead).toBe(true);
    expect(victim.ship.hull).toBe(0);
    expect(victim.deaths).toBe(1);
    expect(raider.kills).toBe(1);
    expect(world.events.some(e => e.e === 'kill' && e.killer === 'raider' && e.victim === 'victim')).toBe(true);

    const respawnAt = victim.respawnAt;
    expect(respawnAt).toBeGreaterThan(world.time);
    expect(respawnAt).toBeLessThanOrEqual(world.time + RESPAWN_DELAY);
    run(world, Math.ceil(RESPAWN_DELAY * 120) + 2);
    expect(victim.dead).toBe(false);
    expect(victim.ship.hull).toBe(100);
    expect(victim.ship.fuel).toBe(16000);
    expect(MAPS[0].spawns.red).toContainEqual(victim.ship.position);
    // Spawned facing the arena centre, not away from it.
    const forward = { x: -Math.sin(victim.ship.angle), y: Math.cos(victim.ship.angle) };
    expect(forward.x * victim.ship.position.x + forward.y * victim.ship.position.y).toBeLessThan(0);
  });
});

describe('asteroid fracture', () => {
  test('a rock too small to fracture is destroyed without children', () => {
    const world = makeWorld([['gunner', 'blue']], { rocks: new Map([[7, rockAt(7, 5, 200, 0)]]) });
    const gunner = aim(world, 'gunner', 0, 0);
    gunner.input.fire = true; stepWorld(world, 1 / 120); gunner.input.fire = false;
    run(world, 60);
    expect(world.rocks.has(7)).toBe(false);
    expect(world.events.some(e => e.e === 'rockGone' && e.id === 7)).toBe(true);
    expect(world.events.some(e => e.e === 'rockSplit')).toBe(false);
  });

  test('a large rock shatters into children that join the field', () => {
    const parent = rockAt(11, 30, 200, 0, { hp: 5 });
    const world = makeWorld([['gunner', 'blue']], { rocks: new Map([[11, parent]]) });
    const gunner = aim(world, 'gunner', 0, 0);
    gunner.input.fire = true; stepWorld(world, 1 / 120); gunner.input.fire = false;
    run(world, 60);

    expect(world.rocks.has(11)).toBe(false);
    const split = world.events.find(e => e.e === 'rockSplit');
    expect(split?.children).toHaveLength(3);
    if (split?.e !== 'rockSplit') throw new Error('expected a rockSplit event');
    for (const child of split.children) expect(world.rocks.get(child.id)).toEqual(child);
    expect(world.rocks.size).toBe(3);
  });

  test('a player killed by the belt is credited to nobody', () => {
    const world = makeWorld([['pilot', 'blue']], { rocks: new Map() });
    const pilot = aim(world, 'pilot', MAPS[0].radius * 1.4, 0);
    pilot.ship.hull = 1;
    run(world, 30);
    expect(pilot.dead).toBe(true);
    expect(world.events.some(e => e.e === 'kill' && e.killer === '' && e.victim === 'pilot')).toBe(true);
  });
});

describe('arena bounds and validation', () => {
  test('a ship outside map.radius is pulled inward and takes hull damage past 1.25x', () => {
    const outside = createShip();
    outside.position = { x: MAPS[0].radius * 1.3, y: 0 };
    applyArenaBounds(outside, MAPS[0], 1 / 120);
    expect(outside.velocity.x).toBeLessThan(0);
    expect(outside.velocity.y).toBe(0);
    expect(outside.hull).toBeLessThan(100);

    const inside = createShip();
    inside.position = { x: MAPS[0].radius * 0.5, y: 0 };
    applyArenaBounds(inside, MAPS[0], 1 / 120);
    expect(inside.velocity).toEqual({ x: 0, y: 0 });
    expect(inside.hull).toBe(100);
  });

  test('sanitizeLoadout spends a 20 point cheat down to the budget', () => {
    const cheat = sanitizeLoadout({ chassis: 'mule', hullPts: 5, thrustPts: 5, fuelPts: 5, torquePts: 5, color: '#ff0000' });
    expect(cheat).toEqual({ chassis: 'mule', hullPts: 5, thrustPts: 5, fuelPts: 0, torquePts: 0, color: PALETTE[0] });
    expect(cheat.hullPts + cheat.thrustPts + cheat.fuelPts + cheat.torquePts).toBeLessThanOrEqual(LOADOUT_BUDGET);

    const nonsense = sanitizeLoadout({ chassis: 'deathstar', hullPts: -4, color: 'red' });
    expect(nonsense).toEqual({ chassis: 'kestrel', hullPts: 0, thrustPts: 0, fuelPts: 0, torquePts: 0, color: PALETTE[0] });
    expect(sanitizeLoadout(undefined).chassis).toBe('kestrel');
  });

  test('unpackInput clamps every field of a hostile packet', () => {
    expect(unpackInput({ th: 99, tu: -99, st: 5, b: 1, bo: 0, f: 1 }))
      .toEqual({ thrust: 1, turn: -1, strafe: 1, brake: true, boost: false, fire: true });
    expect(unpackInput({ th: -9 }).thrust).toBe(-0.28);
    expect(unpackInput({ th: Number.NaN, tu: Number.POSITIVE_INFINITY }))
      .toEqual({ thrust: 0, turn: 0, strafe: 0, brake: false, boost: false, fire: false });
    expect(unpackInput(undefined)).toEqual({ thrust: 0, turn: 0, strafe: 0, brake: false, boost: false, fire: false });
  });
});
