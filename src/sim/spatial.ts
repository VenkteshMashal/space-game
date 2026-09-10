/**
 * Uniform spatial hash for the 120 Hz authority kernel (Plan B5). Bodies are inserted by their
 * swept AABB so a fast projectile is a broadphase candidate for everything along its path, and
 * pairs come back deduplicated in ascending id order so two identical runs produce identical
 * contact ordering on the server.
 *
 * B5 benchmarks 64/128/256 m cells; 128 m is the starting hypothesis and `cellSizeM` is exported
 * so the benchmark can vary it without touching a caller.
 */

import type { CollisionShape, Vec2 } from '../shared/contracts.ts';
import type { Aabb } from './types.ts';

export const cellSizeM = 128;

/** Cell index. Floors, so a shape sitting exactly on a boundary covers the cell it touches. */
const cellIndex = (value: number): number => Math.floor(value / cellSizeM);

/** World AABB of a shape at a pose. Circles ignore the angle; capsules and hulls rotate. */
export function aabbFromShape(shape: CollisionShape, position: Vec2, angle: number): Aabb {
  if (shape.kind === 'circle') {
    return {
      minX: position.x - shape.radiusM,
      maxX: position.x + shape.radiusM,
      minY: position.y - shape.radiusM,
      maxY: position.y + shape.radiusM,
    };
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (shape.kind === 'capsule') {
    // The hull axis is local +Y, so the segment ends are (∓halfSegment·sin, ±halfSegment·cos).
    const ox = Math.abs(shape.halfSegmentM * sin);
    const oy = Math.abs(shape.halfSegmentM * cos);
    const r = shape.radiusM;
    return {
      minX: position.x - ox - r,
      maxX: position.x + ox + r,
      minY: position.y - oy - r,
      maxY: position.y + oy + r,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of shape.vertices) {
    const x = position.x + v.x * cos - v.y * sin;
    const y = position.y + v.x * sin + v.y * cos;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** AABB grown by a margin on every side; used for the rotational part of a swept broadphase box. */
export function expandedAabb(aabb: Aabb, margin: number): Aabb {
  return {
    minX: aabb.minX - margin,
    maxX: aabb.maxX + margin,
    minY: aabb.minY - margin,
    maxY: aabb.maxY + margin,
  };
}

/** Conservative union of the box at t=0 and at t=dt under a constant linear velocity. */
export function sweptAabb(aabb: Aabb, velocity: Vec2, dt: number): Aabb {
  const dx = velocity.x * dt;
  const dy = velocity.y * dt;
  return {
    minX: dx < 0 ? aabb.minX + dx : aabb.minX,
    maxX: dx > 0 ? aabb.maxX + dx : aabb.maxX,
    minY: dy < 0 ? aabb.minY + dy : aabb.minY,
    maxY: dy > 0 ? aabb.maxY + dy : aabb.maxY,
  };
}

/** Touching boxes count as overlapping: the narrowphase decides whether the pair really meets. */
export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * Two-level cell map keyed by cell coordinates (floor(x/cellSizeM), floor(y/cellSizeM)). Two maps
 * instead of one packed key: no coordinate range is assumed and no string is allocated per cell.
 */
export class SpatialHash {
  private readonly columns = new Map<number, Map<number, number[]>>();
  private readonly boxes = new Map<number, Aabb>();

  clear(): void {
    this.columns.clear();
    this.boxes.clear();
  }

  /** One insert per id per frame; the box covers every cell the body can touch this tick. */
  insert(id: number, aabb: Aabb): void {
    this.boxes.set(id, aabb);
    const x0 = cellIndex(aabb.minX);
    const x1 = cellIndex(aabb.maxX);
    const y0 = cellIndex(aabb.minY);
    const y1 = cellIndex(aabb.maxY);
    for (let cx = x0; cx <= x1; cx++) {
      let column = this.columns.get(cx);
      if (column === undefined) {
        column = new Map();
        this.columns.set(cx, column);
      }
      for (let cy = y0; cy <= y1; cy++) {
        let cell = column.get(cy);
        if (cell === undefined) {
          cell = [];
          column.set(cy, cell);
        }
        cell.push(id);
      }
    }
  }

  /** Ids whose stored box overlaps `aabb`, each once. Written into and returned as `out`. */
  query(aabb: Aabb, out: number[]): number[] {
    out.length = 0;
    const seen = new Set<number>();
    const x0 = cellIndex(aabb.minX);
    const x1 = cellIndex(aabb.maxX);
    const y0 = cellIndex(aabb.minY);
    const y1 = cellIndex(aabb.maxY);
    for (let cx = x0; cx <= x1; cx++) {
      const column = this.columns.get(cx);
      if (column === undefined) continue;
      for (let cy = y0; cy <= y1; cy++) {
        const cell = column.get(cy);
        if (cell === undefined) continue;
        for (const id of cell) {
          if (seen.has(id)) continue;
          const box = this.boxes.get(id);
          if (box === undefined || !aabbOverlap(box, aabb)) continue;
          seen.add(id);
          out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * Candidate pairs as a flat `[a, b, a, b, …]` list, deduplicated (a pair sharing several cells is
   * reported once) and sorted ascending by (a, b) so the solver sees repeatable ordering.
   */
  pairs(out: number[]): number[] {
    out.length = 0;
    const seen = new Set<string>();
    const found: Array<[number, number]> = [];
    for (const column of this.columns.values()) {
      for (const cell of column.values()) {
        for (let i = 0; i < cell.length; i++) {
          const left = cell[i];
          const boxLeft = this.boxes.get(left);
          if (boxLeft === undefined) continue;
          for (let j = i + 1; j < cell.length; j++) {
            const right = cell[j];
            if (right === left) continue;
            const lo = left < right ? left : right;
            const hi = left < right ? right : left;
            const key = `${lo}:${hi}`;
            if (seen.has(key)) continue;
            const boxRight = this.boxes.get(right);
            if (boxRight === undefined || !aabbOverlap(boxLeft, boxRight)) continue;
            seen.add(key);
            found.push([lo, hi]);
          }
        }
      }
    }
    found.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [lo, hi] of found) {
      out.push(lo, hi);
    }
    return out;
  }
}
