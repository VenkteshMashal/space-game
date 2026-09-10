/**
 * Aim and lead geometry (Plan A3). The lead indicator solves `|r + v·t| = muzzleSpeed·t` where `r`
 * is the target position minus the muzzle, and `v` is the target velocity minus the ship velocity
 * and the muzzle's own tangential velocity — so a shot from a turning hull leads correctly instead
 * of pointing where the barrel *would* have been.
 *
 * Shared, pure and tested here rather than in the HUD: the authority and the presentation must agree
 * on what "on target" means, and every degenerate case (near-linear coefficient, negative
 * discriminant, out of range, obstructed) has to resolve to a definite answer.
 */

import type { CollisionShape, Vec2, WeaponBehavior } from './contracts.ts';
import { lineOfSightBlocked } from './geometry.ts';

/** What the reticle should show for a weapon, so the reticle never promises a hit it cannot make. */
export type AimVisual = 'lead' | 'beam' | 'lock' | 'envelope' | 'none';

export function aimVisualFor(behavior: WeaponBehavior): AimVisual {
  switch (behavior) {
    case 'ballistic':
    case 'point-defense':
    case 'rail':
    case 'flak':
      return 'lead';
    case 'beam':
      return 'beam';
    case 'torpedo':
      return 'lock';
    case 'mine':
      return 'envelope';
  }
}

export interface LeadInput {
  /** Muzzle position in the world, already including the mount offset. */
  muzzle: Vec2;
  /** Projectile speed relative to the ship, m/s. */
  muzzleSpeedMS: number;
  targetPosition: Vec2;
  targetVelocity: Vec2;
  shipVelocity: Vec2;
  /** Optional mount tangential velocity from the hull's rotation about its centre. */
  muzzleTangential?: Vec2;
  /** Projectile lifetime in seconds; a solution beyond it is not a shot. */
  ttlSeconds?: number;
  /** Hard range limit; a solution beyond it is not a shot either. */
  maxRangeM?: number;
  /** Solids that can block the shot. */
  occluders?: readonly { position: Vec2; radiusM: number }[];
}

export type LeadResult =
  | { valid: true; timeS: number; point: Vec2; bearingRad: number }
  | { valid: false; reason: 'out-of-range' | 'no-solution' | 'expired' | 'obstructed' | 'stationary-target' };

const NEAR_LINEAR = 1e-6;

/**
 * Smallest positive intercept time, then the point the target will occupy and the bearing to it.
 * A target that is not moving relative to the shot gets the direct aim rather than a division by
 * zero, and an obstructed line reports `obstructed` instead of drawing through the rock.
 */
export function solveLead(input: LeadInput): LeadResult {
  const tangential = input.muzzleTangential ?? { x: 0, y: 0 };
  const relativeVelocity = {
    x: input.targetVelocity.x - input.shipVelocity.x - tangential.x,
    y: input.targetVelocity.y - input.shipVelocity.y - tangential.y,
  };
  const r = { x: input.targetPosition.x - input.muzzle.x, y: input.targetPosition.y - input.muzzle.y };
  const range = Math.hypot(r.x, r.y);
  const maxRange = input.maxRangeM ?? Number.POSITIVE_INFINITY;
  if (range > maxRange) return { valid: false, reason: 'out-of-range' };

  const speed = Math.max(0, input.muzzleSpeedMS);
  if (speed <= NEAR_LINEAR) return { valid: false, reason: 'stationary-target' };
  const a = relativeVelocity.x ** 2 + relativeVelocity.y ** 2 - speed ** 2;
  const b = 2 * (r.x * relativeVelocity.x + r.y * relativeVelocity.y);
  const c = r.x ** 2 + r.y ** 2;

  let time: number | null = null;
  if (Math.abs(a) < NEAR_LINEAR) {
    // The shot closes at the same rate the target recedes: the line meets only when the target is
    // actually coming towards the muzzle.
    if (b < -NEAR_LINEAR) time = -c / b;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return { valid: false, reason: 'no-solution' };
    const root = Math.sqrt(discriminant);
    const first = (-b - root) / (2 * a);
    const second = (-b + root) / (2 * a);
    const positive = [first, second].filter(value => value > 0).sort((x, y) => x - y);
    time = positive[0] ?? null;
  }
  // No positive root means the target outruns the shot: it is not a timing problem, it is impossible.
  if (time === null || time <= 0) return { valid: false, reason: 'no-solution' };

  const point = { x: r.x + relativeVelocity.x * time, y: r.y + relativeVelocity.y * time };
  const pointRange = Math.hypot(point.x, point.y);
  if ((input.ttlSeconds !== undefined && time > input.ttlSeconds) || pointRange > maxRange) {
    return { valid: false, reason: 'expired' };
  }
  const target = { x: input.muzzle.x + point.x, y: input.muzzle.y + point.y };
  if (input.occluders && input.occluders.length > 0 && lineOfSightBlocked(input.muzzle, target, input.occluders)) {
    return { valid: false, reason: 'obstructed' };
  }
  return { valid: true, timeS: time, point: target, bearingRad: Math.atan2(point.x, point.y) };
}

/** Mount tangential velocity for a hull spinning about its centre, so lead matches the real shot. */
export function muzzleTangentialVelocity(shipPosition: Vec2, muzzle: Vec2, angularVelocity: number): Vec2 {
  const lever = { x: muzzle.x - shipPosition.x, y: muzzle.y - shipPosition.y };
  return { x: -angularVelocity * lever.y, y: angularVelocity * lever.x };
}

/** World-space muzzle for a hull pose, from a local mount offset. */
export function muzzleWorld(position: Vec2, angle: number, local: Vec2): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: position.x + local.x * cos - local.y * sin, y: position.y + local.x * sin + local.y * cos };
}

/** Approximate solid radius for a collision shape, used when deciding what can block a shot. */
export function shapeRadius(shape: CollisionShape): number {
  return shape.kind === 'circle' ? shape.radiusM : shape.kind === 'capsule' ? shape.radiusM + shape.halfSegmentM : Math.max(...shape.vertices.map(vertex => Math.hypot(vertex.x, vertex.y)));
}
