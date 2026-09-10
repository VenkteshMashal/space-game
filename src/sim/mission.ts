/**
 * Mission entities (Plan B5/B8). A campaign objective names *items* at authored anchors, and a berth
 * when docking is how it ends. Those become real bodies here: an archive drifts until someone picks
 * it up, and from that moment the carrier is heavier, so a loaded Mule lands differently than an
 * empty one and a pilot who loses the item leaves a recoverable beacon rather than a vanished goal.
 *
 * The mission *rules* live in `sim/campaign`; this module only carries the physical facts those rules
 * observe.
 */

import type { Id, Vec2 } from '../shared/contracts.ts';
import type { MissionDefinition, MissionObjective } from './campaign/missions.ts';

/** Mass of one mission item, in kg. A hypothesis for C2, like the catalog's part masses. */
export const MISSION_ITEM_MASS_KG = 2500;
/** How close a pilot must be for an item's own recovery beacon to stay reachable. */
export const ITEM_BEACON_RADIUS_M = 400;

export interface MissionItem {
  id: Id;
  objectiveId: Id;
  /** Index into the objective's `items`, which is what the runtime counts. */
  index: number;
  position: Vec2;
  velocity: Vec2;
  massKg: number;
  /** Pilot carrying it, or null while it drifts. */
  carriedBy: Id | null;
  /** Lost items wait at a reachable beacon instead of vanishing (B8 recovery). */
  lost: boolean;
}

export interface MissionBerth {
  id: Id;
  objectiveId: Id;
  position: Vec2;
  headingRad: number;
  radiusM: number;
}

export interface MissionEntities {
  items: Map<Id, MissionItem>;
  berths: MissionBerth[];
  /** Items already counted by the runtime, so a second recover of the same core cannot double-count. */
  recovered: Set<Id>;
}

export function createMissionEntities(mission: MissionDefinition): MissionEntities {
  const items = new Map<Id, MissionItem>();
  const berths: MissionBerth[] = [];
  for (const objective of mission.objectives) {
    objective.items.forEach((itemId, index) => {
      const anchor = objective.anchors[index] ?? objective.anchors[0] ?? { x: 0, y: 0 };
      items.set(itemId, {
        id: itemId,
        objectiveId: objective.id,
        index,
        position: { ...anchor },
        velocity: { x: 0, y: 0 },
        massKg: MISSION_ITEM_MASS_KG,
        carriedBy: null,
        lost: false,
      });
    });
    if (objective.requiresBerth) {
      const anchor = objective.anchors[0] ?? { x: 0, y: 0 };
      berths.push({
        id: `berth:${objective.id}`,
        objectiveId: objective.id,
        position: { ...anchor },
        headingRad: objective.berthHeadingRad ?? 0,
        radiusM: objective.maxDistanceM,
      });
    }
  }
  return { items, berths, recovered: new Set() };
}

/** Items a pilot is carrying; their mass is part of the ship's wet mass (B5). */
export function carriedMassKg(entities: MissionEntities | null, pilotId: Id): number {
  if (!entities) return 0;
  let mass = 0;
  for (const item of entities.items.values()) if (item.carriedBy === pilotId) mass += item.massKg;
  return mass;
}

export function itemsOfObjective(entities: MissionEntities, objectiveId: Id): MissionItem[] {
  const found: MissionItem[] = [];
  for (const item of entities.items.values()) if (item.objectiveId === objectiveId) found.push(item);
  return found.sort((a, b) => a.index - b.index);
}

export function berthForObjective(entities: MissionEntities, objectiveId: Id): MissionBerth | null {
  return entities.berths.find(berth => berth.objectiveId === objectiveId) ?? null;
}

/** Nearest free item of an objective, so `interact` does not need the pilot to name one. */
export function nearestFreeItem(entities: MissionEntities, objectiveId: Id, from: Vec2): MissionItem | null {
  let best: MissionItem | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of itemsOfObjective(entities, objectiveId)) {
    if (item.carriedBy !== null) continue;
    const distance = Math.hypot(item.position.x - from.x, item.position.y - from.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

export function advanceItems(entities: MissionEntities | null, dt: number): void {
  if (!entities) return;
  for (const item of entities.items.values()) {
    if (item.carriedBy !== null) continue;
    item.position = { x: item.position.x + item.velocity.x * dt, y: item.position.y + item.velocity.y * dt };
  }
}

/** A lost item is placed at a reachable beacon and marked, never deleted (B8). */
export function loseItem(entities: MissionEntities, itemId: Id, beacon: Vec2): MissionItem | null {
  const item = entities.items.get(itemId);
  if (!item) return null;
  item.carriedBy = null;
  item.lost = true;
  item.velocity = { x: 0, y: 0 };
  item.position = { ...beacon };
  return item;
}

/** Absolute heading error to a berth, in degrees, for the docking predicate (B8). */
export function headingErrorDeg(shipAngle: number, berthHeadingRad: number): number {
  const delta = Math.atan2(Math.sin(shipAngle - berthHeadingRad), Math.cos(shipAngle - berthHeadingRad));
  return Math.abs((delta * 180) / Math.PI);
}
