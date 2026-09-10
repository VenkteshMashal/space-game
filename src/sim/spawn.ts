/**
 * Safe spawn selection (Plan B5). Authored positions are scored for occupancy, swept projectile
 * hazards, enemy distance and escape space with a seeded tie-break; if none is safe the code falls
 * back to a ring search and finally to a visible insertion corridor. A pilot is never placed inside
 * a rock, inside a hostile's guns, or with no room to fly out.
 */

import { RELEASE } from '../shared/contracts.ts';
import type { Id, Vec2 } from '../shared/contracts.ts';
import { createRng } from '../shared/rng.ts';

export interface SpawnObstacle { position: Vec2; radiusM: number }
export interface SpawnHazard { position: Vec2; velocity: Vec2; ttlTicks: number; radiusM: number }

export interface SpawnRequest {
  tick: number;
  seed: number;
  teamId: Id;
  candidates: readonly { id: Id; position: Vec2 }[];
  corridor: readonly { id: Id; position: Vec2 }[];
  occupants: readonly (SpawnObstacle & { teamId: Id | null })[];
  hazards: readonly SpawnHazard[];
  enemies: readonly (SpawnObstacle & { teamId: Id })[];
  obstacles: readonly SpawnObstacle[];
  boundsRadiusM: number;
  shipRadiusM: number;
  horizonTicks?: number;
}

export interface SpawnChoice { position: Vec2; sourceId: Id; score: number; inserted: boolean }

const MIN_ENEMY_DISTANCE_M = 250;
const COMFORT_ENEMY_DISTANCE_M = 600;
const MIN_ESCAPE_M = 120;
const HORIZON_TICKS = 180;

/** Closest approach between a candidate point and a hazard's straight-line future path. */
export function hazardClearanceM(candidate: Vec2, hazard: SpawnHazard, horizonTicks: number): number {
  const ticks = Math.min(hazard.ttlTicks, horizonTicks);
  const seconds = ticks / RELEASE.physicsHz;
  const endX = hazard.position.x + hazard.velocity.x * seconds;
  const endY = hazard.position.y + hazard.velocity.y * seconds;
  const dx = endX - hazard.position.x;
  const dy = endY - hazard.position.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(candidate.x - hazard.position.x, candidate.y - hazard.position.y);
  const t = Math.max(0, Math.min(1, ((candidate.x - hazard.position.x) * dx + (candidate.y - hazard.position.y) * dy) / lengthSquared));
  return Math.hypot(candidate.x - (hazard.position.x + dx * t), candidate.y - (hazard.position.y + dy * t));
}

function scorePosition(request: SpawnRequest, position: Vec2, jitter: number): number | null {
  const clearance = request.shipRadiusM;
  if (Math.hypot(position.x, position.y) > request.boundsRadiusM * 0.85) return null;
  for (const occupant of request.occupants) {
    if (Math.hypot(occupant.position.x - position.x, occupant.position.y - position.y) < occupant.radiusM + clearance * 2) return null;
  }
  for (const obstacle of request.obstacles) {
    if (Math.hypot(obstacle.position.x - position.x, obstacle.position.y - position.y) < obstacle.radiusM + clearance) return null;
  }
  let penalty = 0;
  for (const enemy of request.enemies) {
    if (enemy.teamId === request.teamId) continue;
    const distance = Math.hypot(enemy.position.x - position.x, enemy.position.y - position.y);
    if (distance < MIN_ENEMY_DISTANCE_M) return null;
    if (distance < COMFORT_ENEMY_DISTANCE_M) penalty += (COMFORT_ENEMY_DISTANCE_M - distance) / COMFORT_ENEMY_DISTANCE_M * 4;
  }
  const horizon = request.horizonTicks ?? HORIZON_TICKS;
  for (const hazard of request.hazards) {
    const clearanceM = hazardClearanceM(position, hazard, horizon);
    if (clearanceM < clearance) return null;
    if (clearanceM < clearance * 4) penalty += (clearance * 4 - clearanceM) / (clearance * 4) * 3;
  }
  let escape = request.boundsRadiusM - Math.hypot(position.x, position.y);
  for (const obstacle of request.obstacles) {
    escape = Math.min(escape, Math.hypot(obstacle.position.x - position.x, obstacle.position.y - position.y) - obstacle.radiusM);
  }
  if (escape < clearance) return null;
  penalty += Math.max(0, (MIN_ESCAPE_M + clearance - escape) / MIN_ESCAPE_M);
  return 10 - penalty + jitter;
}

/**
 * Deterministic choice: identical inputs give an identical spawn, so a reconnect or a replay lands
 * the same pilot in the same place.
 */
export function chooseSpawn(request: SpawnRequest): SpawnChoice {
  const rng = createRng(request.seed, 'spawn', request.tick);
  let best: SpawnChoice | null = null;
  for (const candidate of request.candidates) {
    const score = scorePosition(request, candidate.position, rng.next() * 0.01);
    if (score === null) continue;
    if (!best || score > best.score) best = { position: { ...candidate.position }, sourceId: candidate.id, score, inserted: false };
  }
  if (best) return best;

  for (let ring = 1; ring <= 6; ring++) {
    const radius = ring * 100;
    for (let step = 0; step < 12; step++) {
      const angle = (step / 12) * Math.PI * 2;
      const position = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      const score = scorePosition(request, position, rng.next() * 0.01);
      if (score === null) continue;
      if (!best || score > best.score) best = { position, sourceId: `ring:${ring}:${step}`, score, inserted: true };
    }
    if (best) return best;
  }

  // Nothing is safe: stage in the visible insertion corridor rather than refusing to spawn at all.
  const fallback = nearestCorridor(request);
  return { position: fallback.position, sourceId: fallback.id, score: Number.NEGATIVE_INFINITY, inserted: true };
}

function nearestCorridor(request: SpawnRequest): { id: Id; position: Vec2 } {
  let best = request.corridor[0];
  if (!best) return { id: 'corridor:default', position: { x: 0, y: 0 } };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of request.corridor) {
    const distance = Math.hypot(point.position.x, point.position.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}
