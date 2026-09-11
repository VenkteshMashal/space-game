import { expect, test } from 'bun:test';
import { combatTargets, sortieEarnings } from '../src/sortie';
import { createShip, SpatialGrid, stepOre } from '../src/physics';
import { Rounds, stepRounds, WEAPONS } from '../src/combat';

test('the live combat roster allows player hits and escort damage without friendly fire', () => {
  const player = createShip(); player.position = { x: 0, y: -200 };
  const enemy = createShip(); enemy.position = { x: 0, y: 100 };
  const escort = createShip('mule'); escort.position = { x: 300, y: 100 };
  const targets = combatTargets(player, [{ state: enemy }], [{ state: escort, lost: false }]);
  const rounds = new Rounds(), grid = new SpatialGrid([]);
  rounds.spawn(0, 0, 0, 10000, WEAPONS.ac20, 0);
  rounds.spawn(300, 0, 0, 10000, WEAPONS.ac20, 1);
  stepRounds(rounds, grid, targets, 0.02);
  expect(enemy.hull).toBe(enemy.spec.hull - WEAPONS.ac20.damage);
  expect(escort.hull).toBe(escort.spec.hull - WEAPONS.ac20.damage);
  expect(player.hull).toBe(player.spec.hull);
  enemy.hull = 0;
  expect(combatTargets(player, [{ state: enemy }], [{ state: escort, lost: true }], targets)).toHaveLength(1);
});

test('salvage debrief pays the 4200 credit black box bonus exactly once', () => {
  const earnings = sortieEarnings(2800, 7000, 120, 1400);
  expect(earnings).toEqual({ payout: 2800, bonus: 4200, ore: 120, bounty: 1400 });
  expect(Object.values(earnings).reduce((sum, value) => sum + value, 0)).toBe(8520);
});

test('filling the hold leaves the uncollected part of an ore chunk available', () => {
  const ship = createShip();
  const ore = [{ id: 1, x: 0, y: 0, vx: 0, vy: 0, amount: 80, life: 90 }];
  expect(stepOre(ore, ship, 1 / 120, 62, 12)).toBe(12);
  expect(ore[0].amount).toBe(68);
  expect(stepOre(ore, ship, 1 / 120, 62, 100)).toBe(68);
  expect(ore).toHaveLength(0);
});
