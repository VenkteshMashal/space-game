/**
 * Arena descriptors and seeded rock generation (Plan B9). The descriptor is immutable per epoch and
 * travels in the baseline; rocks are generated from its seed on both sides and thereafter only
 * events may change the field. IDs derive from generator version, seed and index, so a saved sector
 * cannot be silently rewritten by a generator update.
 */

import { ROCKS } from '../shared/balance.ts';
import type { Id, MapDescriptor, Vec2 } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import { contentId } from '../shared/ids.ts';
import { createRng } from '../shared/rng.ts';

export interface MapDefinition {
  id: Id;
  name: string;
  description: string;
  boundsRadiusM: number;
  /** Physical rocks generated at start; the cap counts fragments too (B5). */
  rockCount: number;
  /** Non-colliding dressing rocks; they are decoration and never objectives. */
  sceneryCount: number;
  minRockRadiusM: number;
  maxRockRadiusM: number;
  /** Peak drift of a rock, m/s. Zero would make a static field; B9 forbids mixing seed and motion. */
  driftMS: number;
  clearingRadiusM: number;
}

export const MAP_DEFINITIONS: readonly MapDefinition[] = [
  {
    id: 'belt',
    name: 'Drift Belt',
    description: 'Broken outer belt. Plenty of cover, tight sight lines.',
    boundsRadiusM: 1500,
    rockCount: 110,
    sceneryCount: 26,
    minRockRadiusM: 7,
    maxRockRadiusM: 26,
    driftMS: 3.2,
    clearingRadiusM: 220,
  },
  {
    id: 'quarry',
    name: 'The Quarry',
    description: 'Worked-out extraction field. Dense, close, unforgiving.',
    boundsRadiusM: 1100,
    rockCount: 160,
    sceneryCount: 30,
    minRockRadiusM: 6,
    maxRockRadiusM: 22,
    driftMS: 2.1,
    clearingRadiusM: 180,
  },
  {
    id: 'expanse',
    name: 'Open Expanse',
    description: 'Sparse outer drift. Long approaches, little cover.',
    boundsRadiusM: 2200,
    rockCount: 55,
    sceneryCount: 40,
    minRockRadiusM: 9,
    maxRockRadiusM: 30,
    driftMS: 4.5,
    clearingRadiusM: 320,
  },
];

export function mapDefinition(mapId: Id): MapDefinition {
  return MAP_DEFINITIONS.find(definition => definition.id === mapId) ?? MAP_DEFINITIONS[0]!;
}

export interface GeneratedRock {
  contentId: Id;
  position: Vec2;
  velocity: Vec2;
  radiusM: number;
  renderSeed: number;
}

export const GENERATOR_VERSION = 1;

/** Spawn ring shared by every map: eight authored positions that clear the centre. */
export function spawnPositions(definition: MapDefinition): { id: Id; position: Vec2 }[] {
  const radius = Math.max(420, definition.clearingRadiusM * 2.2);
  return Array.from({ length: RELEASE.maxHumans }, (_, index) => {
    const angle = (index / RELEASE.maxHumans) * Math.PI * 2;
    return {
      id: `spawn-${index}`,
      position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
    };
  });
}

export function createMapDescriptor(mapId: Id, seed: number): MapDescriptor {
  const definition = mapDefinition(mapId);
  return {
    id: definition.id,
    schemaVersion: RELEASE.saveSchema,
    generatorVersion: GENERATOR_VERSION,
    contentVersion: RELEASE.contentVersion,
    seed: seed >>> 0,
    boundsRadiusM: definition.boundsRadiusM,
    sceneryIds: Array.from({ length: definition.sceneryCount }, (_, index) => `scenery-${index}`),
    stationIds: [],
    staticBodies: [],
    spawnSets: [{ id: 'respawn', positions: spawnPositions(definition).map(entry => entry.position) }],
    objectiveAnchors: [],
    navigationCorridors: [
      { id: 'north', points: [{ x: 0, y: definition.clearingRadiusM }, { x: 0, y: definition.boundsRadiusM * 0.7 }] },
      { id: 'south', points: [{ x: 0, y: -definition.clearingRadiusM }, { x: 0, y: -definition.boundsRadiusM * 0.7 }] },
      { id: 'east', points: [{ x: definition.clearingRadiusM, y: 0 }, { x: definition.boundsRadiusM * 0.7, y: 0 }] },
      { id: 'west', points: [{ x: -definition.clearingRadiusM, y: 0 }, { x: -definition.boundsRadiusM * 0.7, y: 0 }] },
    ],
    dirty: false,
  };
}

/**
 * Deterministic field: a jittered grid with the centre clearing removed and a hard minimum
 * separation, so no two rocks start overlapping and no pilot starts inside one.
 */
export function createRocks(mapId: Id, seed: number): GeneratedRock[] {
  const definition = mapDefinition(mapId);
  const rng = createRng(seed, 'storm');
  const rocks: GeneratedRock[] = [];
  const cell = Math.max(90, (definition.boundsRadiusM * 1.6) / Math.sqrt(definition.rockCount));
  let index = 0;
  for (let gx = -definition.boundsRadiusM; gx <= definition.boundsRadiusM && rocks.length < definition.rockCount; gx += cell) {
    for (let gy = -definition.boundsRadiusM; gy <= definition.boundsRadiusM && rocks.length < definition.rockCount; gy += cell) {
      const position = { x: gx + (rng.next() - 0.5) * cell * 0.85, y: gy + (rng.next() - 0.5) * cell * 0.85 };
      const distance = Math.hypot(position.x, position.y);
      if (distance > definition.boundsRadiusM * 0.94) continue;
      if (distance < definition.clearingRadiusM) continue;
      const radiusM = definition.minRockRadiusM + rng.next() * (definition.maxRockRadiusM - definition.minRockRadiusM);
      if (rocks.some(rock => Math.hypot(rock.position.x - position.x, rock.position.y - position.y) < rock.radiusM + radiusM + 6)) continue;
      const speed = rng.next() * definition.driftMS;
      const heading = rng.next() * Math.PI * 2;
      rocks.push({
        contentId: contentId(GENERATOR_VERSION, seed, index),
        position,
        velocity: { x: Math.cos(heading) * speed, y: Math.sin(heading) * speed },
        radiusM,
        renderSeed: (seed + index * 2654435761) >>> 0,
      });
      index += 1;
    }
  }
  return rocks;
}

/** Rocks must stay inside the arena; a drifting rock is reflected rather than removed (B5/B9). */
export function clampRockToBounds(position: Vec2, velocity: Vec2, boundsRadiusM: number): { position: Vec2; velocity: Vec2; bounced: boolean } {
  const distance = Math.hypot(position.x, position.y);
  const limit = boundsRadiusM * 0.96;
  if (distance <= limit) return { position, velocity, bounced: false };
  const scale = limit / distance;
  const normal = { x: position.x / distance, y: position.y / distance };
  const inward = velocity.x * normal.x + velocity.y * normal.y;
  return {
    position: { x: position.x * scale, y: position.y * scale },
    velocity: inward > 0 ? { x: velocity.x - 2 * inward * normal.x, y: velocity.y - 2 * inward * normal.y } : velocity,
    bounced: true,
  };
}

export function maxPhysicalRocks(): number {
  return ROCKS.maxPhysical;
}
