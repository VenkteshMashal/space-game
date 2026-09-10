import { describe, expect, test } from 'bun:test';
import { canDock, canRecover, createCargo, createShip, emptyInput, length, resolveCollision, SHIPS, STATION, stepShip } from '../src/physics';

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

  test('attitude hold arrests spin and does not slow linear motion', () => {
    const ship = createShip(); ship.angularVelocity = 0.5; ship.velocity.x = 25;
    advance(ship, emptyInput(), 2);
    expect(Math.abs(ship.angularVelocity)).toBeLessThan(0.0001);
    expect(ship.velocity.x).toBe(25);
  });
});

describe('collision and recovery boundaries', () => {
  test('high-speed impacts damage the hull and rebound from the surface', () => {
    const ship = createShip(); ship.position = { x: 20, y: 0 }; ship.velocity = { x: -25, y: 0 };
    const damage = resolveCollision(ship, { x: 0, y: 0, radius: 20, z: 0, seed: 1 });
    expect(damage).toBeGreaterThan(0); expect(ship.hull).toBeLessThan(100); expect(ship.velocity.x).toBeGreaterThan(0);
    expect(ship.position.x).toBeGreaterThan(30);
  });

  test('background rocks never cause planar collisions', () => {
    const ship = createShip(); ship.velocity.x = 20;
    expect(resolveCollision(ship, { x: 0, y: 0, radius: 50, z: -100, seed: 1 })).toBe(0);
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
