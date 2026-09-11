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

/** Returns the first normalized hit time for a point swept from (x0,y0) to (x1,y1). */
export function segmentCircleHit(
  x0: number, y0: number, x1: number, y1: number,
  circle: Circle,
  radius = circle.radius,
): number | undefined {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - circle.x, fy = y0 - circle.y;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return undefined;
  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const t = (-b - root) / (2 * a);
  return t >= 0 && t <= 1 ? t : undefined;
}

/** Returns the first normalized hit time for a point swept through an oriented box. */
export function segmentBoxHit(
  x0: number, y0: number, x1: number, y1: number,
  box: Box,
): number | undefined {
  const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
  const startX = (x0 - box.x) * cos + (y0 - box.y) * sin;
  const startY = -(x0 - box.x) * sin + (y0 - box.y) * cos;
  const deltaX = (x1 - x0) * cos + (y1 - y0) * sin;
  const deltaY = -(x1 - x0) * sin + (y1 - y0) * cos;
  let near = 0, far = 1;

  if (Math.abs(deltaX) < 1e-12) {
    if (Math.abs(startX) > box.halfWidth) return undefined;
  } else {
    let enter = (-box.halfWidth - startX) / deltaX;
    let exit = (box.halfWidth - startX) / deltaX;
    if (enter > exit) { const swap = enter; enter = exit; exit = swap; }
    near = Math.max(near, enter); far = Math.min(far, exit);
    if (near > far) return undefined;
  }
  if (Math.abs(deltaY) < 1e-12) {
    if (Math.abs(startY) > box.halfLength) return undefined;
  } else {
    let enter = (-box.halfLength - startY) / deltaY;
    let exit = (box.halfLength - startY) / deltaY;
    if (enter > exit) { const swap = enter; enter = exit; exit = swap; }
    near = Math.max(near, enter); far = Math.min(far, exit);
    if (near > far) return undefined;
  }
  return near >= 0 && near <= 1 ? near : undefined;
}

/** Hull colliders, taken from each model's drawn extents at the scene's ship scale. */
export const HULL_BOXES = {
  kestrel: { halfLength: 59, halfWidth: 34 },
  mule: { halfLength: 65, halfWidth: 43 },
  needle: { halfLength: 62, halfWidth: 27 },
} as const;
