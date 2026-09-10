/**
 * Pure geometry shared by the authority, the sensors and the presentation. These functions depend on
 * nothing but their arguments, so they belong under `shared` rather than inside the kernel: the HUD
 * needs the same answers the authority gives without importing the simulation.
 */

import type { Vec2 } from './contracts.ts';

export interface Disc { position: Vec2; radiusM: number }

/** True when any disc covers the segment between two points, i.e. line of sight is broken. */
export function lineOfSightBlocked(from: Vec2, to: Vec2, occluders: readonly Disc[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return false;
  for (const occluder of occluders) {
    const t = ((occluder.position.x - from.x) * dx + (occluder.position.y - from.y) * dy) / lengthSquared;
    if (t <= 0 || t >= 1) continue;
    const closestX = from.x + dx * t;
    const closestY = from.y + dy * t;
    if (Math.hypot(closestX - occluder.position.x, closestY - occluder.position.y) <= occluder.radiusM) return true;
  }
  return false;
}

/** Closest approach of a straight-line path to a point, used for hazard and spawn clearance. */
export function pathClearanceM(point: Vec2, from: Vec2, velocity: Vec2, seconds: number): number {
  const endX = from.x + velocity.x * seconds;
  const endY = from.y + velocity.y * seconds;
  const dx = endX - from.x;
  const dy = endY - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}
