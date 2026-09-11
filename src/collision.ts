import type { Vec2 } from './physics';

/** A circle in the navigation plane, in world metres. */
export type Circle = { x: number; y: number; radius: number };
/** An oriented box: halfLength runs along the local forward axis (+y rotated by `angle`). */
export type Box = { x: number; y: number; halfLength: number; halfWidth: number; angle: number };

export const scratch = (): Vec2 => ({ x: 0, y: 0 });

/**
 * Minimum translation that pushes the circle out of the box.
 * Writes into `out` and returns true when they overlap. Allocation-free: every caller owns one scratch.
 */
export function obbCircleOut(box: Box, cx: number, cy: number, radius: number, out: Vec2): boolean {
  const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
  const dx = cx - box.x, dy = cy - box.y;
  // Circle centre in box-local space: local +y is forward, local +x is starboard.
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const clampX = localX < -box.halfWidth ? -box.halfWidth : localX > box.halfWidth ? box.halfWidth : localX;
  const clampY = localY < -box.halfLength ? -box.halfLength : localY > box.halfLength ? box.halfLength : localY;
  let nx = localX - clampX, ny = localY - clampY;
  let distance = Math.hypot(nx, ny);
  let push: number;
  if (distance > 1e-6) {
    if (distance >= radius) return false;
    push = radius - distance;
    nx /= distance; ny /= distance;
  } else {
    // Centre is inside the box: leave along the shallowest face.
    const overshootX = box.halfWidth - Math.abs(localX);
    const overshootY = box.halfLength - Math.abs(localY);
    if (overshootX < overshootY) {
      nx = localX < 0 ? -1 : 1; ny = 0; push = overshootX + radius;
    } else {
      nx = 0; ny = localY < 0 ? -1 : 1; push = overshootY + radius;
    }
  }
  // Back to world space. Local->world is the transpose of the rotation used above.
  out.x = (nx * cos - ny * sin) * push;
  out.y = (nx * sin + ny * cos) * push;
  return true;
}

/**
 * Minimum translation that pushes box `b` out of box `a` (separating axis theorem, 2D).
 * Returns false when they are apart. `out` receives the world-space push for `b`.
 */
export function obbObbOut(a: Box, b: Box, out: Vec2): boolean {
  const axes = [
    { x: Math.cos(a.angle), y: Math.sin(a.angle) },
    { x: -Math.sin(a.angle), y: Math.cos(a.angle) },
    { x: Math.cos(b.angle), y: Math.sin(b.angle) },
    { x: -Math.sin(b.angle), y: Math.cos(b.angle) },
  ];
  const dx = b.x - a.x, dy = b.y - a.y;
  let best = Infinity, bestX = 0, bestY = 0;
  for (const axis of axes) {
    const extentA = projectExtent(a, axis.x, axis.y);
    const extentB = projectExtent(b, axis.x, axis.y);
    const distance = dx * axis.x + dy * axis.y;
    const overlap = extentA + extentB - Math.abs(distance);
    if (overlap <= 0) return false;
    if (overlap < best) {
      best = overlap;
      const sign = distance < 0 ? -1 : 1;
      bestX = axis.x * sign; bestY = axis.y * sign;
    }
  }
  out.x = bestX * best; out.y = bestY * best;
  return true;
}

function projectExtent(box: Box, axisX: number, axisY: number) {
  const forward = Math.abs(-Math.sin(box.angle) * axisX + Math.cos(box.angle) * axisY) * box.halfLength;
  const starboard = Math.abs(Math.cos(box.angle) * axisX + Math.sin(box.angle) * axisY) * box.halfWidth;
  return forward + starboard;
}

export function pointInCircle(circle: Circle, x: number, y: number): boolean {
  return Math.hypot(x - circle.x, y - circle.y) <= circle.radius;
}

export function pointInBox(box: Box, x: number, y: number): boolean {
  const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
  const dx = x - box.x, dy = y - box.y;
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  return Math.abs(localX) <= box.halfWidth && Math.abs(localY) <= box.halfLength;
}

/** Hull colliders, taken from each model's drawn extents at the scene's ship scale. */
export const HULL_BOXES = {
  kestrel: { halfLength: 59, halfWidth: 30 },
  mule: { halfLength: 59, halfWidth: 39 },
  needle: { halfLength: 59, halfWidth: 23 },
} as const;
