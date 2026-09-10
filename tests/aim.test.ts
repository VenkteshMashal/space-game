/**
 * Lead geometry (Plan A3). Every degenerate case the plan names is pinned here — near-linear
 * coefficient, negative discriminant, no solution in range or lifetime, obstruction — because the
 * reticle must never promise a hit the shot cannot make.
 */

import { describe, expect, test } from 'bun:test';
import { aimVisualFor, muzzleTangentialVelocity, muzzleWorld, shapeRadius, solveLead } from '../src/shared/aim.ts';
import { pathClearanceM } from '../src/shared/geometry.ts';

const base = {
  muzzle: { x: 0, y: 0 },
  muzzleSpeedMS: 700,
  targetPosition: { x: 0, y: 700 },
  targetVelocity: { x: 0, y: 0 },
  shipVelocity: { x: 0, y: 0 },
} as const;

describe('lead solution', () => {
  test('a stationary target straight ahead is hit immediately', () => {
    const lead = solveLead(base);
    expect(lead.valid).toBe(true);
    if (!lead.valid) return;
    expect(lead.timeS).toBeCloseTo(1, 6);
    expect(lead.point.x).toBeCloseTo(0, 6);
    expect(lead.point.y).toBeCloseTo(700, 6);
  });

  test('a crossing target is led ahead of its position', () => {
    const lead = solveLead({ ...base, targetPosition: { x: 0, y: 400 }, targetVelocity: { x: 120, y: 0 } });
    expect(lead.valid).toBe(true);
    if (!lead.valid) return;
    // The shot takes time to arrive, so the aim point leads the target's motion.
    expect(lead.point.x).toBeGreaterThan(0);
    expect(lead.timeS).toBeGreaterThan(0.5);
    // And the lead is a real intercept: the distance the shot covers equals speed × time.
    expect(Math.hypot(lead.point.x, lead.point.y)).toBeCloseTo(700 * lead.timeS, 3);
  });

  test("the ship's own velocity and the mount's rotation both change the lead", () => {
    const still = solveLead({ ...base, targetPosition: { x: 0, y: 400 }, targetVelocity: { x: 100, y: 0 } });
    const moving = solveLead({ ...base, targetPosition: { x: 0, y: 400 }, targetVelocity: { x: 100, y: 0 }, shipVelocity: { x: 100, y: 0 } });
    expect(still.valid && moving.valid).toBe(true);
    if (!still.valid || !moving.valid) return;
    // Closing on the target shortens the flight, so the aim point leads less.
    expect(moving.point.x).toBeLessThan(still.point.x);

    const tangent = muzzleTangentialVelocity({ x: 0, y: 0 }, { x: 0, y: 20 }, 0.5);
    expect(tangent).toEqual({ x: -10, y: 0 });
    const rotated = solveLead({ ...base, targetPosition: { x: 0, y: 400 }, targetVelocity: { x: 100, y: 0 }, muzzleTangential: tangent });
    expect(rotated.valid && still.valid).toBe(true);
    if (rotated.valid && still.valid) expect(rotated.point.x).toBeGreaterThan(still.point.x);
  });

  test('a target out of range or beyond the projectile lifetime reports why', () => {
    expect(solveLead({ ...base, maxRangeM: 500 })).toEqual({ valid: false, reason: 'out-of-range' });
    const far = solveLead({ ...base, targetPosition: { x: 0, y: 5000 }, maxRangeM: 6000, ttlSeconds: 2 });
    expect(far).toEqual({ valid: false, reason: 'expired' });
  });

  test('a target outrunning the shot has no solution rather than a fictional one', () => {
    const fleeing = solveLead({ ...base, targetPosition: { x: 0, y: 400 }, targetVelocity: { x: 0, y: 900 } });
    expect(fleeing).toEqual({ valid: false, reason: 'no-solution' });
  });

  test('a target closing at the muzzle speed is the near-linear case, not a division by zero', () => {
    const matching = solveLead({ ...base, targetPosition: { x: 0, y: 1400 }, targetVelocity: { x: 0, y: -700 } });
    expect(matching.valid).toBe(true);
    if (matching.valid) expect(matching.timeS).toBeCloseTo(1, 6);
    const receding = solveLead({ ...base, targetPosition: { x: 0, y: 1400 }, targetVelocity: { x: 0, y: 700 } });
    expect(receding).toEqual({ valid: false, reason: 'no-solution' });
  });

  test('a muzzle with no projectile speed is the degenerate case, not an outrun target', () => {
    expect(solveLead({ ...base, muzzleSpeedMS: 0 })).toEqual({ valid: false, reason: 'stationary-target' });
  });

  test('a rock between the muzzle and the lead point reports an obstruction', () => {
    const blocked = solveLead({
      ...base,
      targetPosition: { x: 0, y: 700 },
      occluders: [{ position: { x: 0, y: 350 }, radiusM: 60 }],
    });
    expect(blocked).toEqual({ valid: false, reason: 'obstructed' });
    const clear = solveLead({
      ...base,
      targetPosition: { x: 0, y: 700 },
      occluders: [{ position: { x: 300, y: 350 }, radiusM: 60 }],
    });
    expect(clear.valid).toBe(true);
  });

  test('a target already on top of the muzzle does not produce a nonsense root', () => {
    const overlapping = solveLead({ ...base, targetPosition: { x: 1, y: 0 } });
    expect(overlapping.valid === false || overlapping.timeS > 0).toBe(true);
  });
});

describe('reticle choice', () => {
  test('each weapon behaviour gets the cue that matches how it flies', () => {
    expect(aimVisualFor('ballistic')).toBe('lead');
    expect(aimVisualFor('rail')).toBe('lead');
    expect(aimVisualFor('point-defense')).toBe('lead');
    expect(aimVisualFor('flak')).toBe('lead');
    expect(aimVisualFor('beam')).toBe('beam');
    expect(aimVisualFor('torpedo')).toBe('lock');
    expect(aimVisualFor('mine')).toBe('envelope');
  });

  test('a muzzle offset follows the hull pose, and shape radii are finite', () => {
    const muzzle = muzzleWorld({ x: 10, y: 20 }, Math.PI / 2, { x: 5, y: 0 });
    expect(muzzle.x).toBeCloseTo(10, 6);
    expect(muzzle.y).toBeCloseTo(25, 6);
    expect(shapeRadius({ kind: 'circle', radiusM: 4 })).toBe(4);
    expect(shapeRadius({ kind: 'capsule', radiusM: 4, halfSegmentM: 10 })).toBe(14);
    expect(shapeRadius({ kind: 'convex', vertices: [{ x: 3, y: 4 }, { x: -3, y: 4 }] })).toBe(5);
  });

  test('path clearance measures the closest approach of a hazard track', () => {
    expect(pathClearanceM({ x: 0, y: 0 }, { x: 400, y: 0 }, { x: -400, y: 0 }, 1)).toBeLessThan(1);
    expect(pathClearanceM({ x: 200, y: 200 }, { x: 400, y: 0 }, { x: -400, y: 0 }, 1)).toBeCloseTo(200, 6);
  });
});
