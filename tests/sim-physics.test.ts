import { describe, expect, test } from 'bun:test';
import { CONTACT } from '../src/shared/balance.ts';
import type { CollisionShape, Vec2 } from '../src/shared/contracts.ts';
import { LAYER } from '../src/sim/types.ts';
import type { Aabb, RigidBody } from '../src/sim/types.ts';
import {
  DAMAGE_THRESHOLD_J,
  damageFromEnergy,
  integrateBody,
  massProperties,
  shapeRadiusM,
  stepContacts,
  sweepPair,
} from '../src/sim/physics.ts';
import { SpatialHash, aabbOverlap, cellSizeM, sweptAabb } from '../src/sim/spatial.ts';

const DT = 1 / 120;
const CAP = CONTACT.maxToiPerBodyPerTick;

interface BodySpec {
  id: number;
  shape: CollisionShape;
  massKg: number;
  position: Vec2;
  velocity?: Vec2;
  angle?: number;
  angularVelocity?: number;
  restitution?: number;
  layer?: number;
  collidable?: boolean;
}

function makeBody(spec: BodySpec): RigidBody {
  const { invMass, invInertia } = massProperties(spec.shape, spec.massKg);
  return {
    id: spec.id,
    generation: 0,
    contentId: `test-${spec.id}`,
    position: spec.position,
    velocity: spec.velocity ?? { x: 0, y: 0 },
    angle: spec.angle ?? 0,
    angularVelocity: spec.angularVelocity ?? 0,
    invMass,
    invInertia,
    shape: spec.shape,
    collidable: spec.collidable ?? true,
    restitution: spec.restitution ?? CONTACT.shipRestitution,
    friction: CONTACT.friction,
    layer: spec.layer ?? LAYER.ship,
  };
}

function momentum(bodies: readonly RigidBody[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const body of bodies) {
    const m = body.invMass > 0 ? 1 / body.invMass : 0;
    x += m * body.velocity.x;
    y += m * body.velocity.y;
  }
  return { x, y };
}

/** Deterministic placements for the broadphase test; no wall clock, no global randomness. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHIP_HULL: CollisionShape = { kind: 'capsule', radiusM: 1, halfSegmentM: 4 };
const BALL: CollisionShape = { kind: 'circle', radiusM: 1 };

describe('body integration and mass properties', () => {
  test('inertia follows the documented hull approximation and the angle stays wrapped', () => {
    const circle = massProperties({ kind: 'circle', radiusM: 2 }, 10);
    expect(1 / circle.invInertia).toBeCloseTo((10 * 4) / 2, 9);

    const capsule = massProperties({ kind: 'capsule', radiusM: 1, halfSegmentM: 4 }, 12);
    // length 10 m, beam 2 m: m(length² + beam²) / 12.
    expect(1 / capsule.invInertia).toBeCloseTo((12 * (100 + 4)) / 12, 9);

    const hull = massProperties({ kind: 'convex', vertices: [{ x: -1, y: -3 }, { x: 1, y: -3 }, { x: 1, y: 3 }, { x: -1, y: 3 }] }, 12);
    expect(1 / hull.invInertia).toBeCloseTo((12 * (36 + 4)) / 12, 9);

    const body = makeBody({ id: 1, shape: BALL, massKg: 4, position: { x: 0, y: 0 }, velocity: { x: 12, y: 0 }, angle: 3.2 });
    integrateBody(body, DT);
    expect(body.position.x).toBeCloseTo(0.1, 9);
    expect(body.angle).toBeCloseTo(3.2 - 2 * Math.PI, 9);
    expect(Math.abs(body.angle)).toBeLessThanOrEqual(Math.PI);
    expect(shapeRadiusM(SHIP_HULL)).toBe(5);
    expect(shapeRadiusM({ kind: 'convex', vertices: [{ x: 3, y: 4 }] })).toBe(5);
  });
});

describe('impulse solver', () => {
  test('equal-mass head-on ships rebound with momentum conserved and no interpenetration', () => {
    const a = makeBody({ id: 1, shape: SHIP_HULL, massKg: 100_000, position: { x: -5.2, y: 0 }, velocity: { x: 60, y: 0 }, angle: -Math.PI / 2 });
    const b = makeBody({ id: 2, shape: SHIP_HULL, massKg: 100_000, position: { x: 5.2, y: 0 }, velocity: { x: -20, y: 0 }, angle: -Math.PI / 2 });
    const before = momentum([a, b]);

    const step = stepContacts([a, b], DT, CAP);

    expect(step.contacts.length).toBe(1);
    expect(b.velocity.x).toBeGreaterThan(a.velocity.x);
    const after = momentum([a, b]);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1e-6 * Math.abs(before.x) + 1e-9);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1e-6 * Math.abs(before.x) + 1e-9);
    expect(Math.abs(b.position.x - a.position.x)).toBeGreaterThanOrEqual(2 * (4 + 1) - 1e-6);

    const contact = step.contacts[0];
    expect(contact.impulseN).toBeGreaterThan(0);
    expect(contact.lostEnergyJ).toBeGreaterThan(0);
    expect(damageFromEnergy(contact.lostEnergyJ, 1000)).toBeGreaterThan(0);
  });

  test('heavy versus light splits the impulse by inverse mass', () => {
    const heavy = makeBody({ id: 1, shape: { kind: 'circle', radiusM: 2 }, massKg: 1_000_000, position: { x: 0, y: 0 }, velocity: { x: 20, y: 0 } });
    const light = makeBody({ id: 2, shape: BALL, massKg: 1_000, position: { x: 3.1, y: 0 } });
    const before = momentum([heavy, light]);

    const step = stepContacts([heavy, light], DT, CAP);

    expect(step.contacts.length).toBe(1);
    // e = 0.15: light leaves at (1 + e)·u·mHeavy/(mHeavy + mLight) ≈ 22.98 m/s, the heavy barely slows.
    expect(light.velocity.x).toBeCloseTo(22.98, 1);
    expect(heavy.velocity.x).toBeLessThan(20);
    expect(heavy.velocity.x).toBeGreaterThan(19.9);
    const after = momentum([heavy, light]);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1e-6 * Math.abs(before.x) + 1e-9);
  });

  test('a spawned overlap separates by at most slop, rests without jitter and gains no energy', () => {
    const a = makeBody({ id: 1, shape: BALL, massKg: 1_000, position: { x: 0, y: 0 } });
    const b = makeBody({ id: 2, shape: BALL, massKg: 1_000, position: { x: 1.96, y: 0 } });

    let restedAt = 0;
    for (let tick = 0; tick < 60; tick++) {
      const step = stepContacts([a, b], DT, CAP);
      expect(step.contacts.length).toBe(1);
      expect(step.contacts[0].lostEnergyJ).toBe(0);
      expect(damageFromEnergy(step.contacts[0].lostEnergyJ, 100)).toBe(0);
      if (tick === 1) restedAt = b.position.x;
    }

    expect(b.position.x).toBe(restedAt);
    expect(a.velocity.x).toBe(0);
    expect(b.velocity.x).toBe(0);
    expect(a.angularVelocity).toBe(0);
    const overlap = 2 - (b.position.x - a.position.x);
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThanOrEqual(CONTACT.slopM + 1e-9);
  });
});

describe('swept collision', () => {
  test('a 22.5 m-per-tick projectile cannot tunnel through a 2 m target', () => {
    const projectile = makeBody({ id: 1, shape: { kind: 'circle', radiusM: 0.05 }, massKg: 2, position: { x: 0, y: 0 }, velocity: { x: 2700, y: 0 } });
    const target = makeBody({ id: 2, shape: BALL, massKg: 5_000, position: { x: 10, y: 0 } });
    // 22.5 m of travel per tick: end-point integration would put the round 12.5 m past the target.

    const hit = sweepPair(projectile, target, DT);
    expect(hit).not.toBeNull();
    expect(hit!.toi).toBeGreaterThan(0);
    expect(hit!.toi).toBeLessThan(DT);

    const inbound = makeBody({ id: 3, shape: { kind: 'circle', radiusM: 0.05 }, massKg: 2, position: { x: 0, y: 0 }, velocity: { x: 2700, y: 0 } });
    const charging = makeBody({ id: 4, shape: BALL, massKg: 5_000, position: { x: 10, y: 0 }, velocity: { x: -2700, y: 0 } });
    const closing = sweepPair(inbound, charging, DT);
    expect(closing).not.toBeNull();
    expect(closing!.toi).toBeLessThan(hit!.toi);

    const step = stepContacts([inbound, charging], DT, CAP);
    expect(step.contacts.length).toBe(1);
    expect(inbound.position.x).toBeLessThan(charging.position.x);
  });

  test('a high-spin capsule sweeps into a thin target instead of passing through it', () => {
    const spinner = makeBody({
      id: 1,
      shape: { kind: 'capsule', radiusM: 1, halfSegmentM: 8 },
      massKg: 50_000,
      position: { x: 0, y: 0 },
      angularVelocity: Math.PI / 2 / DT,
    });
    const plate = makeBody({ id: 2, shape: { kind: 'circle', radiusM: 0.5 }, massKg: 100, position: { x: -8.5, y: 0 } });

    const hit = sweepPair(spinner, plate, DT);
    expect(hit).not.toBeNull();
    expect(hit!.toi).toBeGreaterThan(0);
    expect(hit!.toi).toBeLessThan(DT);

    // Without the spin the same pose never reaches the plate, so rotation is what the sweep caught.
    const frozen = makeBody({ id: 3, shape: { kind: 'capsule', radiusM: 1, halfSegmentM: 8 }, massKg: 50_000, position: { x: 0, y: 0 } });
    expect(sweepPair(frozen, plate, DT)).toBeNull();

    const step = stepContacts([spinner, plate], DT, CAP);
    expect(step.contacts.length).toBe(1);
  });

  test('a grazing pass scores no hit while a strike does', () => {
    const clear = makeBody({ id: 2, shape: BALL, massKg: 5_000, position: { x: 10, y: 1.4 } });
    const bullet = makeBody({ id: 1, shape: { kind: 'circle', radiusM: 0.05 }, massKg: 2, position: { x: 0, y: 0 }, velocity: { x: 2700, y: 0 } });
    expect(sweepPair(bullet, clear, DT)).toBeNull();
    const step = stepContacts([bullet, clear], DT, CAP);
    expect(step.contacts.length).toBe(0);
    expect(bullet.position.x).toBeGreaterThan(10);

    const struck = makeBody({ id: 4, shape: BALL, massKg: 5_000, position: { x: 10, y: 1.0 } });
    const shot = makeBody({ id: 3, shape: { kind: 'circle', radiusM: 0.05 }, massKg: 2, position: { x: 0, y: 0 }, velocity: { x: 2700, y: 0 } });
    expect(sweepPair(shot, struck, DT)).not.toBeNull();
  });

  test('a body that exhausts its per-tick TOI budget is reported instead of tunnelling', () => {
    const projectile = makeBody({ id: 1, shape: { kind: 'circle', radiusM: 0.05 }, massKg: 2, position: { x: 0, y: 0 }, velocity: { x: 2700, y: 0 } });
    const rocks = [5, 8, 11, 14, 17, 20].map((x, index) =>
      makeBody({ id: 10 + index, shape: { kind: 'circle', radiusM: 0.5 }, massKg: 1_000_000, position: { x, y: 0 } }),
    );

    const step = stepContacts([projectile, ...rocks], DT, CAP);

    // Six rocks lie inside the 22.5 m path, four contacts fit the budget, the rest is exhausted.
    expect(step.exhausted).toEqual([1]);
    expect(projectile.position.x).toBeLessThan(17);
  });
});

describe('collision damage', () => {
  test('damage is zero below the threshold, monotonic and finite', () => {
    expect(damageFromEnergy(0, 100)).toBe(0);
    expect(damageFromEnergy(DAMAGE_THRESHOLD_J, 100)).toBe(0);
    expect(damageFromEnergy(Number.NaN, 100)).toBe(0);

    let previous = -1;
    for (const energy of [0, 100, DAMAGE_THRESHOLD_J, DAMAGE_THRESHOLD_J + 1, 5_000, 1e5, 1e6, 1e9]) {
      const damage = damageFromEnergy(energy, 100);
      expect(Number.isFinite(damage)).toBe(true);
      expect(damage).toBeGreaterThanOrEqual(previous);
      expect(damage).toBeLessThanOrEqual(100);
      previous = damage;
    }
    expect(damageFromEnergy(Infinity, 100)).toBe(100);
  });
});

describe('broadphase', () => {
  test('pairs are deduplicated, cover every real overlap and are stable across runs', () => {
    expect(cellSizeM).toBe(128);

    const boxes: Array<[number, Aabb]> = [];
    const rand = seeded(0x5eed);
    for (let i = 0; i < 48; i++) {
      const half = 5 + rand() * 35;
      const x = -250 + rand() * 500;
      const y = -250 + rand() * 500;
      boxes.push([i + 1, { minX: x - half, maxX: x + half, minY: y - half, maxY: y + half }]);
    }
    // One wide box spans several 128 m cells, so multi-cell insertion has to hold up too.
    boxes.push([99, { minX: -300, maxX: 300, minY: -30, maxY: 30 }]);

    const build = (): SpatialHash => {
      const hash = new SpatialHash();
      for (const [id, box] of boxes) hash.insert(id, box);
      return hash;
    };
    const first = build().pairs([]);
    const second = build().pairs([]);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);

    const reported = new Set<string>();
    for (let i = 0; i < first.length; i += 2) {
      expect(first[i]).toBeLessThan(first[i + 1]);
      const key = `${first[i]}:${first[i + 1]}`;
      expect(reported.has(key)).toBe(false);
      reported.add(key);
      if (i > 0) {
        const ascending = first[i] > first[i - 2] || (first[i] === first[i - 2] && first[i + 1] > first[i - 1]);
        expect(ascending).toBe(true);
      }
    }

    const brute = new Set<string>();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (!aabbOverlap(boxes[i][1], boxes[j][1])) continue;
        const lo = Math.min(boxes[i][0], boxes[j][0]);
        const hi = Math.max(boxes[i][0], boxes[j][0]);
        brute.add(`${lo}:${hi}`);
      }
    }
    expect(reported).toEqual(brute);
  });

  test('a swept box makes a fast body a candidate along its whole path', () => {
    const round: Aabb = { minX: -0.05, maxX: 0.05, minY: -0.05, maxY: 0.05 };
    const atEnd: Aabb = { minX: 22, maxX: 22.2, minY: -1, maxY: 1 };
    const swept = new SpatialHash();
    swept.insert(1, sweptAabb(round, { x: 2700, y: 0 }, DT));
    expect(swept.query(atEnd, [])).toEqual([1]);

    const parked = new SpatialHash();
    parked.insert(1, round);
    expect(parked.query(atEnd, [])).toEqual([]);
  });

  test('scenery and the collidable flag gate the dynamic contact set', () => {
    const contact = (shipLayer: number, rockLayer: number, collidable = true): number =>
      stepContacts(
        [
          makeBody({ id: 1, shape: BALL, massKg: 1_000, position: { x: 0, y: 0 }, velocity: { x: 10, y: 0 }, layer: shipLayer }),
          makeBody({ id: 2, shape: BALL, massKg: 1_000, position: { x: 1.9, y: 0 }, layer: rockLayer, collidable }),
        ],
        DT,
        CAP,
      ).contacts.length;

    // The authority authors one category bit per body (world.ts: ship 1, rock 2) and picks index
    // membership itself, so ship versus rock must still collide.
    expect(contact(LAYER.ship, LAYER.rock)).toBe(1);
    expect(contact(LAYER.ship, LAYER.structure)).toBe(1);
    expect(contact(LAYER.ship, LAYER.scenery)).toBe(0);
    expect(contact(LAYER.ship, LAYER.rock, false)).toBe(0);
  });

  test('an accelerating ship rests on a rock instead of sinking into it', () => {
    const ship = makeBody({
      id: 1,
      shape: { kind: 'capsule', radiusM: 5.12, halfSegmentM: 15.88 },
      massKg: 250_000,
      position: { x: 0, y: -800 },
      layer: LAYER.ship,
    });
    const rock = makeBody({ id: 2, shape: { kind: 'circle', radiusM: 30 }, massKg: 4e9, position: { x: 0, y: -600 }, layer: LAYER.rock });

    for (let tick = 0; tick < 600; tick++) {
      ship.velocity = { x: ship.velocity.x, y: ship.velocity.y + 133 * DT };
      stepContacts([ship, rock], DT, CAP);
    }

    // The rock is massive but not immovable, so the surface is measured where the rock ended up.
    const tipY = ship.position.y + 5.12 + 15.88;
    expect(ship.position.y).toBeLessThan(rock.position.y);
    expect(tipY - (rock.position.y + 30)).toBeLessThanOrEqual(CONTACT.slopM);
  });
});
