import { describe, expect, test } from 'bun:test';
import { canDock, canRecover, createCargo, createObstacles, createShip, DERELICT, distance, dockingRadius, emptyInput, length, randomSeed, recoveryRadius, resolveBodies, resolveCollision, setStationSpin, shipBox, SHIPS, solidBodyBox, SOLID_BODIES, SpatialGrid, STATION, stepShip } from '../src/physics';
import type { Obstacle } from '../src/physics';
import { obbCircleOut, scratch } from '../src/collision';
import { buildSpec, presetBuild } from '../src/build';

function advance(ship: ReturnType<typeof createShip>, input = emptyInput(), seconds = 1) {
  for (let i = 0; i < seconds * 120; i++) stepShip(ship, input, 1 / 120);
}

describe('Newtonian flight', () => {
  test('a coasting ship preserves velocity, fuel and angular momentum without assist', () => {
    const ship = createShip(); ship.assist = false;
    ship.velocity = { x: 31, y: -19 }; ship.angularVelocity = 0.2;
    const fuel = ship.fuel, angle = ship.angle;
    advance(ship, emptyInput(), 10);
    expect(ship.velocity).toEqual({ x: 31, y: -19 });
    expect(ship.position.x).toBeCloseTo(310, 6);
    expect(ship.position.y).toBeCloseTo(-190, 6);
    expect(ship.fuel).toBe(fuel);
    expect(ship.angle).toBeCloseTo(angle + 2, 6);
  });

  test('rotation changes orientation without steering existing velocity', () => {
    const ship = createShip(); ship.velocity = { x: 42, y: 9 };
    advance(ship, { ...emptyInput(), turn: 1 }, 1);
    expect(ship.velocity).toEqual({ x: 42, y: 9 });
    expect(ship.angle).toBeGreaterThan(-0.63);
    expect(ship.fuel).toBeLessThan(SHIPS.kestrel.fuel);
  });

  test('main drive acceleration follows heading and consumes propellant', () => {
    const ship = createShip(); ship.angle = -Math.PI / 2;
    advance(ship, { ...emptyInput(), thrust: 1 }, 1);
    expect(ship.velocity.x).toBeGreaterThan(16);
    expect(Math.abs(ship.velocity.y)).toBeLessThan(0.001);
    expect(ship.fuel).toBeLessThan(SHIPS.kestrel.fuel);
  });

  test('braking uses reaction mass and comes to rest without reversing velocity', () => {
    const ship = createShip(); ship.velocity = { x: 4, y: -3 };
    advance(ship, { ...emptyInput(), brake: true }, 3);
    expect(length(ship.velocity)).toBeLessThan(0.0001);
    expect(ship.fuel).toBeLessThan(SHIPS.kestrel.fuel);
  });

  test('empty tanks prevent main drive, steering, assist and braking', () => {
    const ship = createShip(); ship.fuel = 0; ship.velocity = { x: 10, y: 3 }; ship.angularVelocity = 0.1;
    advance(ship, { thrust: 1, turn: 1, strafe: 1, boost: true, brake: true }, 1);
    expect(ship.velocity).toEqual({ x: 10, y: 3 });
    expect(ship.angularVelocity).toBe(0.1);
    expect(ship.fuel).toBe(0);
  });

  test('the lighter cutter accelerates faster than the salvage tug', () => {
    const cutter = createShip('needle'), tug = createShip('mule');
    advance(cutter, { ...emptyInput(), thrust: 1 }); advance(tug, { ...emptyInput(), thrust: 1 });
    expect(length(cutter.velocity)).toBeGreaterThan(length(tug.velocity));
  });

  test('a ship flies from the spec it carries rather than from its class', () => {
    const sluggish = createShip('kestrel', { ...SHIPS.kestrel, mass: 400000, thrust: 420000 });
    const stock = createShip();
    advance(sluggish, { ...emptyInput(), thrust: 1 }); advance(stock, { ...emptyInput(), thrust: 1 });
    expect(length(sluggish.velocity)).toBeLessThan(length(stock.velocity));
    expect(sluggish.hull).toBe(100);
  });

  test('attitude hold arrests spin and does not slow linear motion', () => {
    const ship = createShip(); ship.angularVelocity = 0.5; ship.velocity.x = 25;
    advance(ship, emptyInput(), 2);
    expect(Math.abs(ship.angularVelocity)).toBeLessThan(0.0001);
    expect(ship.velocity.x).toBe(25);
  });
});

describe('collision and recovery boundaries', () => {
  const rock = (over: Partial<Obstacle> = {}): Obstacle => ({ id: 0, x: 0, y: 0, radius: 20, seed: 1, z: 0, hp: 100, maxHp: 100, ...over });

  test('high-speed impacts damage the hull and rebound from the surface', () => {
    const ship = createShip();
    const obstacle = rock({ radius: 20, x: 0, y: 0 });
    ship.angle = Math.PI / 2;   // nose down the -x axis: a true head-on, not a graze
    ship.position = { x: 100, y: 0 }; ship.velocity = { x: -25, y: 0 };
    let damage = 0;
    for (let i = 0; i < 240 && damage === 0; i++) {
      ship.position.x += ship.velocity.x / 120;
      damage = resolveCollision(ship, obstacle);
    }
    expect(damage).toBeGreaterThan(0);
    expect(ship.hull).toBeLessThan(100);
    expect(ship.velocity.x).toBeGreaterThan(0);
    // Stopped by the nose, not by the centre: the hull reaches the rock long before the middle does.
    expect(ship.position.x).toBeGreaterThan(obstacle.radius + 40);
  });

  test('background rocks never cause planar collisions', () => {
    const ship = createShip(); ship.velocity.x = 20;
    expect(resolveCollision(ship, rock({ radius: 50, z: -100 }))).toBe(0);
    expect(ship.hull).toBe(100); expect(ship.velocity.x).toBe(20);
  });

  test('a fractured rock stops colliding', () => {
    const ship = createShip(); ship.position = { x: 20, y: 0 }; ship.velocity = { x: -20, y: 0 };
    expect(resolveCollision(ship, rock({ hp: 0 }))).toBe(0);
    expect(ship.velocity.x).toBe(-20);
  });

  test('the spatial grid finds every rock that could touch a query point, once each', () => {
    const rocks = createObstacles();
    const grid = new SpatialGrid(rocks);
    const rand = randomSeed(99);
    let probe = 0;
    for (let i = 0; i < 150; i++) {
      const x = (rand() - 0.5) * 5200, y = (rand() - 0.5) * 4200;
      const found = grid.near(x, y);
      expect(new Set(found).size).toBe(found.length);
      for (const candidate of rocks) {
        if (Math.hypot(candidate.x - x, candidate.y - y) < 260) {
          expect(found).toContain(candidate);
          probe++;
        }
      }
    }
    expect(probe).toBeGreaterThan(150);
  });

  test('removing and refiling keeps the grid honest', () => {
    const rocks = createObstacles();
    const grid = new SpatialGrid(rocks);
    const target = rocks[0];
    grid.remove(target);
    expect(grid.near(target.x, target.y)).not.toContain(target);
    grid.add(target);
    expect(grid.near(target.x, target.y)).toContain(target);
    const from = { x: target.x, y: target.y };
    target.x += 4000;
    grid.refile(target, from.x, from.y);
    expect(grid.near(from.x, from.y)).not.toContain(target);
    expect(grid.near(target.x, target.y)).toContain(target);
  });

  test('the hull stops against a rock instead of sinking into it', () => {
    const ship = createShip();
    const obstacle = rock({ radius: 40, x: 120, y: 0 });
    ship.position = { x: 0, y: 0 };
    ship.velocity = { x: 60, y: 0 };
    const grid = new SpatialGrid([obstacle]);
    let damage = 0;
    for (let i = 0; i < 240; i++) {
      ship.position.x += ship.velocity.x / 120;
      damage += resolveCollision(ship, obstacle);
    }
    expect(damage).toBeGreaterThan(0);
    // The drawn hull is ~118 m long, so its nose reaches the rock while the centre is still far off.
    expect(ship.position.x).toBeLessThan(120);
    expect(Math.hypot(ship.position.x - obstacle.x, ship.position.y - obstacle.y)).toBeGreaterThan(obstacle.radius);
  });

  test('solid bodies stop the ship at their surface, unless the station collar is open', () => {
    const ship = createShip();
    ship.position = { x: STATION.x - 260, y: STATION.y };
    ship.velocity = { x: 60, y: 0 };
    let damage = 0;
    for (let i = 0; i < 400; i++) {
      ship.position.x += ship.velocity.x / 120;
      damage += resolveBodies(ship, false);
    }
    expect(damage).toBeGreaterThan(0);
    // The hull is ~118 m long, so its nose meets the ring while the centre is still well outside.
    expect(ship.position.x).toBeLessThan(STATION.x - 78);
    expect(obbCircleOut(shipBox(ship), STATION.x, STATION.y, 78, scratch())).toBe(false);
    expect(ship.hull).toBeLessThan(100);

    const docking = createShip();
    docking.position = { x: STATION.x - 40, y: STATION.y }; docking.velocity = { x: 6, y: 0 };
    expect(resolveBodies(docking, true)).toBe(0);
    expect(docking.velocity.x).toBe(6);
  });

  test('the wreck is a solid hull the ship cannot fly through', () => {
    const ship = createShip();
    ship.position = { x: DERELICT.x, y: DERELICT.y - 300 };
    ship.velocity = { x: 0, y: 90 };
    let damage = 0;
    for (let i = 0; i < 400; i++) {
      ship.position.y += ship.velocity.y / 120;
      damage += resolveBodies(ship, false);
    }
    expect(damage).toBeGreaterThan(0);
    expect(ship.position.y).toBeLessThan(DERELICT.y);
  });

  test('salvage needs proximity, safe velocity and an unrecovered archive', () => {
    const ship = createShip(), cargo = createCargo()[0];
    expect(canRecover(ship, cargo)).toBe(false);
    ship.position = { ...cargo.position }; expect(canRecover(ship, cargo)).toBe(true);
    ship.velocity.x = 12; expect(canRecover(ship, cargo)).toBe(false);
    ship.velocity.x = 0; cargo.collected = true; expect(canRecover(ship, cargo)).toBe(false);
  });

  test('the blackbox retrieval arm reaches from outside the wreck collider', () => {
    const ship = createShip();
    const blackbox = createCargo().find(cargo => cargo.kind === 'blackbox')!;
    ship.position = { x: DERELICT.x - 150, y: DERELICT.y };
    ship.velocity = { x: 0, y: 0 };
    expect(recoveryRadius(ship, blackbox)).toBeGreaterThan(150);
    expect(canRecover(ship, blackbox)).toBe(true);
    expect(resolveBodies(ship, false)).toBe(0);
  });

  test('docking requires a low-speed approach to the station', () => {
    const ship = createShip(); expect(canDock(ship)).toBe(false);
    ship.position = { ...STATION }; expect(canDock(ship)).toBe(true);
    ship.velocity = { x: 8, y: 0 }; expect(canDock(ship)).toBe(false);
  });

  test('all stock hulls and a large custom hull can approach slowly outside physical station colliders', () => {
    setStationSpin(0);
    const custom = createShip('kestrel', buildSpec(presetBuild('patrol')), { halfLength: 120, halfWidth: 80 });
    for (const ship of [createShip('kestrel'), createShip('mule'), createShip('needle'), custom]) {
      const clearance = dockingRadius(ship);
      ship.position = { x: STATION.x - clearance + 1, y: STATION.y };
      ship.velocity = { x: 7.5, y: 0 };
      expect(canDock(ship)).toBe(true);
      expect(resolveBodies(ship, false)).toBe(0);
      expect(ship.hull).toBe(ship.spec.hull);
    }
  });

  test('station arm colliders follow station rotation while the wreck collider stays fixed', () => {
    const arm = SOLID_BODIES.find(body => body.id === 'station-arm-port');
    const wreck = SOLID_BODIES.find(body => body.id === 'derelict');
    if (!arm || arm.kind !== 'box' || !wreck || wreck.kind !== 'box') throw new Error('expected station arm and wreck boxes');
    setStationSpin(Math.PI / 2);
    try {
      const rotatedArm = solidBodyBox(arm);
      expect(rotatedArm.x).toBeCloseTo(STATION.x, 8);
      expect(rotatedArm.y).toBeCloseTo(STATION.y - 112, 8);
      expect(rotatedArm.angle).toBeCloseTo(Math.PI / 2, 8);
      const stationaryWreck = solidBodyBox(wreck);
      expect(stationaryWreck.x).toBeCloseTo(DERELICT.x, 8);
      expect(stationaryWreck.y).toBeCloseTo(DERELICT.y, 8);
      expect(stationaryWreck.angle).toBeCloseTo(0, 8);
    } finally {
      setStationSpin(0);
    }
  });
});
