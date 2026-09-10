/**
 * Simulation kernel interfaces (Plan B4/B5). Frozen at C0 so the kernel, the server and the tests
 * agree on one vocabulary. Positions are metres in XY; Z is appearance only.
 *
 * These are *authority* bodies: they carry the inverse mass and inverse inertia that make the
 * impulse solver cheap, and they are keyed by numeric id + generation because a destroyed body can
 * be replaced without confusing a stale reference for the new one.
 */

import type { CollisionShape, Id, Vec2 } from '../shared/contracts.ts';

export interface RigidBody {
  id: number;
  generation: number;
  /** Stable content id for logging, authored content and rendering correlation. */
  contentId: Id;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  invMass: number;
  invInertia: number;
  shape: CollisionShape;
  collidable: boolean;
  restitution: number;
  friction: number;
  /**
   * Category bits. `stepContacts` tests every pair it is handed; only pairs touching `LAYER.scenery`
   * are skipped, because scenery is the one layer that is never physical (B5). Callers select which
   * bodies participate — the world hands it ships, rocks and structure, never projectiles.
   */
  layer: number;
}

/** Broadphase layer bits. Static authored geometry and scenery are never in the dynamic index. */
export const LAYER = { ship: 1, rock: 2, structure: 4, projectile: 8, scenery: 16 } as const;

export interface Aabb { minX: number; minY: number; maxX: number; maxY: number }

export interface Contact {
  a: number;
  b: number;
  normal: Vec2;
  /** Penetration depth in metres along `normal`; positive means overlapping. */
  penetrationM: number;
  point: Vec2;
  /** Time of impact within the tick, 0 for resting contact. */
  toi: number;
  /** Speed lost to the impulse, converted to collision damage by the kernel. */
  lostEnergyJ: number;
  impulseN: number;
}

export interface SweepHit { toi: number; normal: Vec2; point: Vec2 }

/** Result of one integration step; the kernel consumes it to apply damage and culling rules. */
export interface StepContacts {
  contacts: readonly Contact[];
  /** Bodies that exhausted the per-body TOI budget this tick (B5: log, never tunnel silently). */
  exhausted: readonly number[];
}
