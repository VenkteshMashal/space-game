import { describe, expect, test } from 'bun:test';
import { canDock, canRecover, createCargo, createShip, emptyInput, length, resolveCollision, rockHp, rockMass, ROCK_MIN_R, SHIPS, splitRock, STATION, stepShip } from '../src/physics';
import type { Rock, ShipState } from '../src/physics';

function advance(ship: ShipState, input = emptyInput(), seconds = 1) {
  for (let i = 0; i < seconds * 120; i++) stepShip(ship, input, 1 / 120);
}

const makeRock = (radius: number, over: Partial<Rock> = {}): Rock =>
  ({ id: 1, x: 0, y: 0, vx: 0, vy: 0, radius, hp: rockHp(radius), mass: rockMass(radius), seed: 1, z: 0, ...over });

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

  test('attitude hold arrests spin and does not slow linear motion', () => {
    const ship = createShip(); ship.angularVelocity = 0.5; ship.velocity.x = 25;
    advance(ship, emptyInput(), 2);
    expect(Math.abs(ship.angularVelocity)).toBeLessThan(0.0001);
    expect(ship.velocity.x).toBe(25);
  });
});

describe('collision and recovery boundaries', () => {
  test('high-speed impacts damage the hull and leave the ship clear of the surface', () => {
    const ship = createShip(); ship.position = { x: 20, y: 0 }; ship.velocity = { x: -25, y: 0 };
    const rock = makeRock(20);
    const damage = resolveCollision(ship, rock);
    expect(damage).toBeGreaterThan(0); expect(ship.hull).toBeLessThan(100); expect(ship.velocity.x).toBeGreaterThan(0);
    expect(ship.position.x).toBeGreaterThan(20);                                            // the ship is pushed outward
    expect(rock.x).toBeLessThan(0);                                                         // and the rock recoils the other way
    expect(Math.hypot(ship.position.x - rock.x, ship.position.y - rock.y)).toBeGreaterThan(rock.radius * 0.83);
  });

  test('a light rock is thrown aside by a heavy ship while a heavy rock is not', () => {
    const pebble = makeRock(4, { id: 2 });
    const light = createShip(); light.position = { x: 15, y: 0 }; light.velocity = { x: -20, y: 0 };
    resolveCollision(light, pebble);

    const monolith = makeRock(60, { id: 3 });
    const heavy = createShip(); heavy.position = { x: 20, y: 0 }; heavy.velocity = { x: -20, y: 0 };
    resolveCollision(heavy, monolith);

    expect(pebble.vx).toBeLessThan(-10);
    expect(Math.abs(monolith.vx)).toBeLessThan(0.5);
    expect(Math.abs(pebble.vx)).toBeGreaterThan(Math.abs(monolith.vx) * 10);
  });

  test('splitting conserves the centre of mass and roughly conserves area', () => {
    const parent = makeRock(30, { id: 9, vx: 7, vy: -4 });
    let next = 100;
    const children = splitRock(parent, 0, () => next++);
    expect(children).toHaveLength(3);
    expect(children.map(c => c.id)).toEqual([100, 101, 102]);

    const totalMass = children.reduce((sum, c) => sum + c.mass, 0);
    expect(totalMass).toBeLessThan(parent.mass);                       // area loss is the dust the shot made
    expect(totalMass).toBeGreaterThan(parent.mass * 0.75);
    // Evenly spaced kicks cancel, so the debris cloud keeps the parent's velocity.
    expect(children.reduce((sum, c) => sum + c.mass * c.vx, 0) / totalMass).toBeCloseTo(parent.vx, 6);
    expect(children.reduce((sum, c) => sum + c.mass * c.vy, 0) / totalMass).toBeCloseTo(parent.vy, 6);

    const areaRatio = children.reduce((sum, c) => sum + c.radius * c.radius, 0) / (parent.radius * parent.radius);
    expect(areaRatio).toBeGreaterThanOrEqual(0.75);
    expect(areaRatio).toBeLessThanOrEqual(1);
    expect(children.every(c => c.hp > 0 && c.mass > 0 && c.z === 0)).toBe(true);
  });

  test('a rock too small to fracture turns to dust instead', () => {
    const dust = makeRock(ROCK_MIN_R / 0.62 - 1);
    expect(splitRock(dust, 0, () => 1)).toEqual([]);
  });

  test('background rocks never cause planar collisions', () => {
    const ship = createShip(); ship.velocity.x = 20;
    expect(resolveCollision(ship, makeRock(50, { z: -100 }))).toBe(0);
    expect(ship.hull).toBe(100); expect(ship.velocity.x).toBe(20);
  });

  test('salvage needs proximity, safe velocity and an unrecovered archive', () => {
    const ship = createShip(), cargo = createCargo()[0];
    expect(canRecover(ship, cargo)).toBe(false);
    ship.position = { ...cargo.position }; expect(canRecover(ship, cargo)).toBe(true);
    ship.velocity.x = 12; expect(canRecover(ship, cargo)).toBe(false);
    ship.velocity.x = 0; cargo.collected = true; expect(canRecover(ship, cargo)).toBe(false);
  });

  test('docking requires a low-speed approach to the station', () => {
    const ship = createShip(); expect(canDock(ship)).toBe(false);
    ship.position = { ...STATION }; expect(canDock(ship)).toBe(true);
    ship.velocity = { x: 8, y: 0 }; expect(canDock(ship)).toBe(false);
  });
});
