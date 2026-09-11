import { describe, expect, test } from 'bun:test';
import { bodyAt, createShip, fractureRock, ORE_PICKUP_RADIUS, rockHP, resolveShipCollision, SOLID_BODIES, SpatialGrid, STATION, stepOre } from '../src/physics';
import type { Obstacle, Ore, SolidBody } from '../src/physics';
import { createHostile, fireMounts, HOSTILES, interceptPoint, Rounds, stepBeams, stepHostile, STOCK_MOUNTS, TURRET_TRAVERSE_RATE, stepRounds, WEAPONS, wrapAngle } from '../src/combat';
import type { Mount } from '../src/combat';

const DT = 1 / 120;
let nextId = 1;

const rock = (over: Partial<Obstacle> = {}): Obstacle => {
  const radius = over.radius ?? 30;
  return { id: nextId++, x: 0, y: 0, radius, seed: 3, z: 0, hp: rockHP(radius), maxHp: rockHP(radius), ...over };
};

function mount(weapon: string, over: Partial<Mount> = {}): Mount {
  return { spec: WEAPONS[weapon], lx: 0, ly: 0, cooldown: 0, bearing: 0, ...over };
}

function advanceRounds(rounds: Rounds, grid: SpatialGrid, targets: { state: ReturnType<typeof createShip>; faction: 0 | 1 }[], seconds: number, bodies: readonly SolidBody[] = []) {
  const hits = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) hits.push(...stepRounds(rounds, grid, targets, DT, bodies));
  return hits;
}

describe('rounds and damage', () => {
  test('a round stops on a solid body instead of flying through it', () => {
    const grid = new SpatialGrid([]);
    const withBodies = new Rounds();
    withBodies.spawn(STATION.x - 600, STATION.y, 620, 0, WEAPONS.ac20, 0);
    const blocked = advanceRounds(withBodies, grid, [], 1.2, SOLID_BODIES);
    expect(blocked.some(hit => hit.kind === 'body')).toBe(true);
    const unblocked = new Rounds();
    unblocked.spawn(STATION.x - 600, STATION.y, 620, 0, WEAPONS.ac20, 0);
    const free = advanceRounds(unblocked, grid, [], 1.2);
    expect(free.some(hit => hit.kind === 'body')).toBe(false);
  });

  test('a round takes exactly damage times rock bonus off the rock it hits', () => {
    const target = rock({ radius: 40, x: 300, y: 0 });
    const grid = new SpatialGrid([target]);
    const rounds = new Rounds();
    const spec = WEAPONS.ac70;
    rounds.spawn(0, 0, spec.speed, 0, spec, 0);
    const hits = advanceRounds(rounds, grid, [], 1);
    const rockHit = hits.find(hit => hit.kind === 'rock');
    expect(rockHit).toBeTruthy();
    expect(rockHit!.damage).toBeCloseTo(spec.damage * spec.rockBonus, 3);
    expect(target.hp).toBeCloseTo(rockHP(40) - spec.damage * spec.rockBonus, 3);
  });

  test('a round that passes wide of a rock leaves it untouched', () => {
    const target = rock({ radius: 12, x: 300, y: 120 });
    const grid = new SpatialGrid([target]);
    const rounds = new Rounds();
    rounds.spawn(0, 0, 620, 0, WEAPONS.ac20, 0);
    const hits = advanceRounds(rounds, grid, [], 1);
    expect(hits.some(hit => hit.kind === 'rock')).toBe(false);
    expect(target.hp).toBe(target.maxHp);
  });

  test('a 1400 m/s round cannot tunnel through a small rock between two steps', () => {
    const target = rock({ radius: 9, x: 300.4, y: 0 });
    const grid = new SpatialGrid([target]);
    const rounds = new Rounds();
    // One step covers 11.7 m, more than the rock's 9 m radius: the endpoint clears the rock and
    // only the midpoint sample lands inside it, so this passes on the substep alone.
    rounds.spawn(298.5, 0, 1400, 0, WEAPONS.gauss, 0);
    const hits = stepRounds(rounds, grid, [], DT);
    expect(hits.some(hit => hit.kind === 'rock')).toBe(true);
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  test('rounds never damage their own faction and expire on range', () => {
    const friendly = createShip();
    const enemy = createShip(); enemy.position = { x: 200, y: 0 };
    const grid = new SpatialGrid([]);
    const rounds = new Rounds();
    rounds.spawn(0, 0, 620, 0, WEAPONS.ac20, 0);
    advanceRounds(rounds, grid, [{ state: friendly, faction: 0 }, { state: enemy, faction: 1 }], 0.2);
    expect(friendly.hull).toBe(friendly.spec.hull);
    expect(enemy.hull).toBe(friendly.spec.hull);
    const swing = new Rounds();
    swing.spawn(0, 0, 620, 0, WEAPONS.ac20, 0);
    const hits = advanceRounds(swing, grid, [{ state: enemy, faction: 1 }], 0.2);
    expect(hits.some(hit => hit.kind === 'ship')).toBe(false);
    const expiring = new Rounds();
    expiring.spawn(0, 0, 620, 0, WEAPONS.ac20, 0);
    const expiry = advanceRounds(expiring, grid, [], 4);
    expect(expiry.some(hit => hit.kind === 'expire')).toBe(true);
  });
});

describe('firing', () => {
  test('a held trigger respects the rate of fire, drains propellant and heats the drive', () => {
    const ship = createShip();
    const mounts = [mount('ac20')];
    const rounds = new Rounds();
    let shots = 0;
    for (let i = 0; i < 120; i++) fireMounts(mounts, ship, { x: 500, y: 0 }, true, rounds, 0, 1, DT, () => { shots++; });
    expect(shots).toBeGreaterThanOrEqual(5);
    expect(shots).toBeLessThanOrEqual(6);
    expect(ship.fuel).toBeLessThan(ship.spec.fuel);
    expect(ship.heat).toBeGreaterThan(0);
  });

  test('a release stops firing and an empty tank cannot fire at all', () => {
    const ship = createShip();
    const mounts = [mount('ac20')];
    const rounds = new Rounds();
    for (let i = 0; i < 60; i++) fireMounts(mounts, ship, { x: 500, y: 0 }, false, rounds, 0, 1, DT);
    expect(rounds.life.some(life => life > 0)).toBe(false);
    const dry = createShip(); dry.fuel = 0;
    for (let i = 0; i < 60; i++) fireMounts(mounts, dry, { x: 500, y: 0 }, true, rounds, 0, 1, DT);
    expect(rounds.life.some(life => life > 0)).toBe(false);
  });

  test('rounds inherit the ship velocity and the turret cannot leave its arc', () => {
    const ship = createShip();
    ship.velocity = { x: 30, y: -12 };
    const mounts = [mount('ac20', { lx: 0, ly: 0 })];
    const rounds = new Rounds();
    fireMounts(mounts, ship, { x: -900, y: 0 }, true, rounds, 0, 1, DT);
    const index = rounds.life.findIndex(life => life > 0);
    expect(index).toBeGreaterThanOrEqual(0);
    // Forward is 620 m/s along the hull bearing; the stern-ward aim only shifts it within the arc.
    expect(Math.hypot(rounds.vx[index], rounds.vy[index])).toBeGreaterThan(560);
    expect(Math.hypot(rounds.vx[index] - ship.velocity.x, rounds.vy[index] - ship.velocity.y)).toBeCloseTo(WEAPONS.ac20.speed, 0);
    expect(Math.abs(mounts[0].bearing)).toBeLessThan(WEAPONS.ac20.arc);
    expect(Math.abs(mounts[0].bearing)).toBeLessThanOrEqual(TURRET_TRAVERSE_RATE * DT + 1e-9);
    expect(Math.abs(wrapAngle(mounts[0].bearing))).toBeLessThanOrEqual(WEAPONS.ac20.arc + 1e-9);
  });

  test('a missile mount fires and stores a guided round in the standard pool', () => {
    const ship = createShip();
    const mounts = [mount('swarm')];
    const rounds = new Rounds();
    for (let i = 0; i < 120; i++) fireMounts(mounts, ship, { x: 400, y: 0 }, true, rounds, 0, 1, DT);
    const index = rounds.life.findIndex(life => life > 0);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(rounds.kind[index]).toBe(1);
    expect(ship.fuel).toBeLessThan(ship.spec.fuel);
  });

  test('primary and missile triggers are separated in one cooldown pass', () => {
    const ship = createShip();
    const mounts = [mount('ac20'), mount('swarm', { cooldown: 0.05 })];
    const rounds = new Rounds();
    fireMounts(mounts, ship, { x: 400, y: 0 }, true, rounds, 0, 1, DT, undefined, false);
    expect(rounds.kind.some(kind => kind === 0 && rounds.life.some(life => life > 0))).toBe(true);
    expect(rounds.kind.some((kind, i) => kind === 1 && rounds.life[i] > 0)).toBe(false);
    expect(mounts[1].cooldown).toBeCloseTo(0.05 - DT, 6);

    mounts[1].cooldown = 0;
    fireMounts(mounts, ship, { x: -400, y: 0 }, false, rounds, 0, 1, DT, undefined, true);
    expect(mounts[1].cooldown).toBeCloseTo(1 / WEAPONS.swarm.rof, 6);
    expect(rounds.kind.some((kind, i) => kind === 1 && rounds.life[i] > 0)).toBe(true);
  });

  test('the new weapon roles have bounded control characteristics', () => {
    expect(WEAPONS.pdc.kind).toBe('kinetic');
    expect(WEAPONS.pdc.damage).toBeLessThan(WEAPONS.ac20.damage);
    expect(WEAPONS.pdc.rof).toBeGreaterThan(WEAPONS.ac20.rof);
    expect(WEAPONS.pdc.arc).toBeCloseTo(Math.PI, 8);
    expect(WEAPONS.torpedo.kind).toBe('missile');
    expect(WEAPONS.torpedo.rof).toBeLessThan(WEAPONS.swarm.rof);
    expect(WEAPONS.torpedo.range).toBeGreaterThan(WEAPONS.swarm.range);
    expect(WEAPONS.plasma.kind).toBe('beam');
    expect(WEAPONS.plasma.range).toBe(360);
    expect(WEAPONS.plasma.damage).toBeGreaterThan(WEAPONS.cutter.damage);
    expect(WEAPONS.plasma.rockBonus).toBeGreaterThan(WEAPONS.cutter.rockBonus);
  });

  test('the intercept helper leads a moving target at projectile speed', () => {
    const point = interceptPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 10 }, 50);
    expect(point.x).toBe(100);
    expect(point.y).toBeCloseTo(1000 / Math.sqrt(2400), 6);
  });

  test('stock ships expose their combat and mining tools', () => {
    expect(STOCK_MOUNTS.kestrel.map(mount => mount.weapon)).toEqual(['ac20', 'ac20', 'cutter', 'swarm']);
    expect(STOCK_MOUNTS.needle.map(mount => mount.weapon)).toEqual(['ac20', 'ac20', 'gauss', 'torpedo']);
  });

  test('a missile turns only within its bounded guidance rate', () => {
    const target = createShip(); target.position = { x: 0, y: 300 };
    const rounds = new Rounds();
    rounds.spawn(0, 0, 240, 0, WEAPONS.swarm, 0);
    const grid = new SpatialGrid([]);
    const before = Math.atan2(rounds.vy[0], rounds.vx[0]);
    stepRounds(rounds, grid, [{ state: target, faction: 1 }], DT);
    const after = Math.atan2(rounds.vy[0], rounds.vx[0]);
    expect(Math.abs(wrapAngle(after - before))).toBeLessThanOrEqual(1.8 * DT + 1e-6);
    expect(target.hull).toBe(target.spec.hull);
  });

  test('a swept round resolves the nearest impact across rocks, bodies and ships', () => {
    const near = rock({ radius: 10, x: 105, y: 0 });
    const far = rock({ radius: 10, x: 116, y: 0 });
    const enemy = createShip(); enemy.position = { x: 160, y: 0 };
    const grid = new SpatialGrid([near, far]);
    const rounds = new Rounds();
    rounds.spawn(90, 0, 1400, 0, WEAPONS.gauss, 0);
    const hits = stepRounds(rounds, grid, [{ state: enemy, faction: 1 }], DT, []);
    expect(hits[0]?.kind).toBe('rock');
    expect(hits[0]?.x).toBeLessThan(110);
    expect(far.hp).toBe(far.maxHp);
    expect(enemy.hull).toBe(enemy.spec.hull);
  });

  test('ship collision exchanges a mass-weighted impulse and damages both hulls', () => {
    const light = createShip('needle');
    const heavy = createShip('mule');
    light.position = { x: -40, y: 0 }; heavy.position = { x: 40, y: 0 };
    light.angle = heavy.angle = -Math.PI / 2;
    light.velocity = { x: 50, y: 0 }; heavy.velocity = { x: -10, y: 0 };
    const result = resolveShipCollision(light, heavy);
    expect(result.relativeSpeed).toBeGreaterThan(0);
    expect(result.damageA).toBeGreaterThan(0);
    expect(result.damageB).toBeGreaterThan(0);
    expect(light.hull).toBeLessThan(light.spec.hull);
    expect(heavy.hull).toBeLessThan(heavy.spec.hull);
    expect(Math.abs(light.velocity.x - heavy.velocity.x)).toBeLessThan(60);
  });

  test('bodyAt respects a caller supplied body list', () => {
    const custom: SolidBody = { id: 'test-body', kind: 'circle', x: 12, y: 8, radius: 5, restitution: 1 };
    expect(bodyAt(custom.x, custom.y, [custom])).toBe(custom);
    expect(bodyAt(STATION.x, STATION.y, [custom])).toBeUndefined();
  });
});

describe('beams', () => {
  test('the cutter damages the first rock in its path and stops there', () => {
    const near = rock({ radius: 20, x: 100, y: 0 });
    const far = rock({ radius: 20, x: 190, y: 0 });
    const grid = new SpatialGrid([near, far]);
    const ship = createShip();
    ship.angle = -Math.PI / 2;   // hull bearing zero: the beam runs along +x
    const mounts = [mount('cutter')];
    const hits = stepBeams(mounts, ship, grid, true, 1, DT);
    expect(hits.length).toBe(1);
    expect(hits[0].rock).toBe(near);
    expect(far.hp).toBe(far.maxHp);
    expect(near.hp).toBeLessThan(near.maxHp);
    expect(hits[0].ex).toBeLessThan(far.x);
  });

  test('a released or out-of-range cutter does no work', () => {
    const target = rock({ radius: 20, x: 400, y: 0 });
    const grid = new SpatialGrid([target]);
    const ship = createShip();
    ship.angle = -Math.PI / 2;
    const mounts = [mount('cutter')];
    const hits = stepBeams(mounts, ship, grid, true, 1, DT);
    expect(hits[0].rock).toBeUndefined();
    expect(target.hp).toBe(target.maxHp);
    expect(stepBeams(mounts, ship, grid, false, 1, DT)).toEqual([]);
  });

  test('a continuous beam finds the exact first small rock and stops there', () => {
    const near = rock({ radius: 2, x: 72.5, y: 0 });
    const far = rock({ radius: 8, x: 105, y: 0 });
    const grid = new SpatialGrid([near, far]);
    const ship = createShip();
    ship.angle = -Math.PI / 2;
    const hit = stepBeams([mount('plasma')], ship, grid, true, 1, DT)[0];
    expect(hit.rock).toBe(near);
    expect(hit.ex).toBeCloseTo(near.x - near.radius, 5);
    expect(far.hp).toBe(far.maxHp);
  });

  test('a solid body blocks a beam at its swept entry point', () => {
    const grid = new SpatialGrid([]);
    const ship = createShip();
    ship.angle = -Math.PI / 2;
    const body: SolidBody = { id: 'bulkhead', kind: 'circle', x: 80, y: 0, radius: 6, restitution: 1 };
    const hit = stepBeams([mount('plasma')], ship, grid, true, 1, DT, [body])[0];
    expect(hit.blocked).toBe(true);
    expect(hit.rock).toBeUndefined();
    expect(hit.ex).toBeCloseTo(body.x - body.radius, 5);
  });
});

describe('hostiles', () => {
  const emptyGrid = new SpatialGrid([]);

  test('a distant hostile patrols and closes to attack once inside its alert range', () => {
    const player = createShip();
    const raider = createHostile(1, 'raider', { x: 3000, y: 0 });
    const rounds = new Rounds();
    for (let i = 0; i < 360; i++) stepHostile(raider, [player], rounds, emptyGrid, DT);
    expect(raider.mode).toBe('patrol');
    raider.state.position = { x: 300, y: 0 };
    for (let i = 0; i < 360; i++) stepHostile(raider, [player], rounds, emptyGrid, DT);
    expect(raider.mode).toBe('attack');
  });

  test('a wrecked hostile runs with its nose away from the player', () => {
    const player = createShip();
    const raider = createHostile(2, 'raider', { x: 300, y: 0 });
    raider.state.angle = -Math.PI / 2; // deterministic nose-away start for the response assertion
    raider.state.hull = HOSTILES.raider.hull * 0.2;
    const rounds = new Rounds();
    for (let i = 0; i < 480; i++) stepHostile(raider, [player], rounds, emptyGrid, DT);
    expect(raider.mode).toBe('flee');
    // The raider sits at +x with the player at the origin, so running away means +x.
    const forward = { x: -Math.sin(raider.state.angle), y: Math.cos(raider.state.angle) };
    expect(forward.x).toBeGreaterThan(0.5);
    expect(raider.state.velocity.x).toBeGreaterThan(0);
  });

  test('hostile fire hurts the player and never another hostile', () => {
    const player = createShip();
    const wingman = createHostile(9, 'raider', { x: 260, y: 0 });
    const raider = createHostile(3, 'raider', { x: 260, y: 0 });
    const rounds = new Rounds();
    const targets = [{ state: player, faction: 0 as const }, { state: raider.state, faction: 1 as const }, { state: wingman.state, faction: 1 as const }];
    for (let i = 0; i < 900; i++) {
      stepHostile(raider, [player], rounds, emptyGrid, DT);
      stepRounds(rounds, emptyGrid, targets, DT);
    }
    expect(player.hull).toBeLessThan(player.spec.hull);
    expect(wingman.state.hull).toBe(HOSTILES.raider.hull);
    expect(raider.state.hull).toBe(HOSTILES.raider.hull);
  });

  test('a turret holds station while it tracks and fires', () => {
    const player = createShip();
    const turret = createHostile(4, 'turret', { x: 400, y: 0 });
    const anchor = { ...turret.state.position };
    const rounds = new Rounds();
    for (let i = 0; i < 600; i++) stepHostile(turret, [player], rounds, emptyGrid, DT);
    expect(Math.hypot(turret.state.position.x - anchor.x, turret.state.position.y - anchor.y)).toBeLessThan(1);
    expect(rounds.life.some(life => life > 0)).toBe(true);
  });

  test('the catalogue ships a full set of kinds with sane bounties', () => {
    expect(HOSTILES.turret.bounty).toBeGreaterThan(0);
    expect(HOSTILES.mine.weapons).toEqual([]);
    for (const kind of ['raider', 'interceptor', 'turret', 'mine'] as const) {
      const hostile = createHostile(5, kind, { x: 10, y: 20 });
      expect(hostile.state.spec.thrust).toBeGreaterThan(0);
      expect(hostile.state.hull).toBe(HOSTILES[kind].hull);
      expect(hostile.mode).toBe('patrol');
    }
  });
});

describe('fracture and ore', () => {
  test('a big rock breaks into fragments whose area is conserved, and drops ore', () => {
    const parent = rock({ radius: 60 });
    const { fragments, ore } = fractureRock(parent, () => nextId++);
    expect(parent.hp).toBe(0);
    expect(fragments.length).toBe(3);
    const parentArea = parent.radius * parent.radius;
    const childArea = fragments.reduce((sum, fragment) => sum + fragment.radius * fragment.radius, 0);
    expect(childArea).toBeGreaterThan(parentArea * 0.75);
    expect(childArea).toBeLessThan(parentArea * 1.25);
    expect(ore.length).toBeGreaterThanOrEqual(3);
    for (const fragment of fragments) {
      expect(fragment.hp).toBe(fragment.maxHp);
      expect(fragment.radius).toBeGreaterThanOrEqual(9);
      expect(Math.hypot(fragment.vx ?? 0, fragment.vy ?? 0)).toBeGreaterThan(0);
    }
  });

  test('a small rock vanishes without fragments but still drops ore', () => {
    const { fragments, ore } = fractureRock(rock({ radius: 12, x: 40, y: 40 }), () => nextId++);
    expect(fragments).toEqual([]);
    expect(ore.length).toBe(1);
    expect(ore[0].amount).toBeGreaterThan(0);
  });

  test('ore is scooped once, on proximity, and expires on its own', () => {
    const ship = createShip();
    const chunks: Ore[] = [
      { id: 1, x: 0, y: 0, vx: 0, vy: 0, amount: 30, life: 90 },
      { id: 2, x: 900, y: 0, vx: 0, vy: 0, amount: 12, life: 0.4 },
    ];
    expect(stepOre(chunks, ship, DT)).toBe(30);
    expect(chunks.length).toBe(1);
    for (let i = 0; i < 60; i++) stepOre(chunks, ship, DT);
    expect(chunks.length).toBe(0);
  });

  test('a wider collector envelope reaches further out', () => {
    const make = () => [{ id: 5, x: 120, y: 0, vx: 0, vy: 0, amount: 9, life: 90 }];
    const ship = createShip();
    let taken = 0;
    const outside = make();
    for (let i = 0; i < 240; i++) taken += stepOre(outside, ship, DT);
    expect(taken).toBe(0);
    const inside = make();
    for (let i = 0; i < 900 && inside.length; i++) taken += stepOre(inside, ship, DT, ORE_PICKUP_RADIUS * 3);
    expect(taken).toBe(9);
  });
});

