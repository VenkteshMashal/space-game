/**
 * Rock fracture (Plan B5). A fractured body hands its motion to two children plus dust; the dust
 * carries whatever mass and momentum the children did not take, so nothing is created or lost by a
 * split. The physical rock cap is a rule, not a render budget: when a split would exceed it the
 * coarse body stays visible and cracked with reduced hull until a split is safe.
 */

import { ROCKS } from '../shared/balance.ts';
import type { Id, Vec2 } from '../shared/contracts.ts';
import { splitChildId } from '../shared/ids.ts';

export interface RockState {
  bodyId: number;
  generation: number;
  contentId: Id;
  renderSeed: number;
  radiusM: number;
  massKg: number;
  hull: number;
  hullMax: number;
  /** Depth from the authored parent; children of children are capped after the last level. */
  splitDepth: number;
  /** Visibly cracked and holding reduced hull because the field was at its cap. */
  cracked: boolean;
}

/** 2D body with a thickness of one diameter, so a rock is a lump of the same material in any axis. */
export function rockMassKg(radiusM: number): number {
  return ROCKS.densityKgM3 * Math.PI * radiusM * radiusM * radiusM * 2;
}

export function rockHull(radiusM: number, massKg = rockMassKg(radiusM)): number {
  return Math.max(1, Math.round(Math.cbrt(massKg) * 0.06));
}

export function createRockState(bodyId: number, contentId: Id, radiusM: number, renderSeed: number, splitDepth = 0): RockState {
  const massKg = rockMassKg(radiusM);
  const hullMax = rockHull(radiusM, massKg);
  return { bodyId, generation: 1, contentId, renderSeed, radiusM, massKg, hull: hullMax, hullMax, splitDepth, cracked: false };
}

export type FractureOutcome =
  | { kind: 'split'; children: { contentId: Id; radiusM: number; massKg: number; velocity: Vec2; position: Vec2; renderSeed: number }[]; dustMassKg: number; dustMomentum: Vec2 }
  | { kind: 'retained'; crackedHull: number };

export interface FractureInput {
  rock: RockState;
  position: Vec2;
  velocity: Vec2;
  /** Direction the parent was struck from, used as the split axis. */
  impactNormal: Vec2;
  /** Live physical rocks *excluding* this one. */
  liveRockCount: number;
  tick: number;
  /** Deepest level that still produces children; beyond it a rock crumbles to dust only. */
  maxSplitDepth?: number;
}

const CHILD_FRACTIONS = [0.62, 0.51] as const;
const MAX_SPLIT_DEPTH = 3;

/**
 * Plan a fracture. Deterministic: the same rock, impact and tick always produce the same children,
 * so two authorities replaying the same events agree without shipping child state on the wire.
 */
export function planFracture(input: FractureInput): FractureOutcome {
  const { rock, liveRockCount, position, velocity, impactNormal } = input;
  const maxDepth = input.maxSplitDepth ?? MAX_SPLIT_DEPTH;
  const radii = CHILD_FRACTIONS.map(fraction => rock.radiusM * fraction);
  const splittable = rock.splitDepth < maxDepth && radii.every(radius => radius >= ROCKS.minRadiusM);

  if (!splittable || liveRockCount + 2 > ROCKS.maxPhysical) {
    // The cap is on physical rocks including fragments, so a field at the cap keeps this body
    // intact and visibly cracked rather than deleting an obstacle to make room.
    return { kind: 'retained', crackedHull: Math.max(1, rock.hullMax * ROCKS.crackedHullFraction) };
  }

  const axis = normalize(impactNormal);
  const kickMS = Math.min(40, Math.hypot(velocity.x, velocity.y) * 0.25 + 6);
  const children = radii.map((radiusM, index) => {
    const massKg = rockMassKg(radiusM);
    const side = index === 0 ? 1 : -1;
    const seed = (rock.renderSeed * 31 + index * 17 + input.tick) >>> 0;
    return {
      contentId: splitChildId(rock.contentId, index),
      radiusM,
      massKg,
      position: {
        x: position.x + axis.x * side * radiusM * 0.6,
        y: position.y + axis.y * side * radiusM * 0.6,
      },
      velocity: {
        x: velocity.x + axis.x * side * kickMS,
        y: velocity.y + axis.y * side * kickMS,
      },
      renderSeed: seed,
    };
  });

  const childMass = children.reduce((sum, child) => sum + child.massKg, 0);
  const dustMassKg = Math.max(0, rock.massKg - childMass);
  // Dust carries exactly the momentum the children did not take, so the pair conserves mass and
  // momentum together even though only two bodies survive.
  const childMomentum = children.reduce(
    (sum, child) => ({ x: sum.x + child.massKg * child.velocity.x, y: sum.y + child.massKg * child.velocity.y }),
    { x: 0, y: 0 },
  );
  return {
    kind: 'split',
    children,
    dustMassKg,
    dustMomentum: { x: rock.massKg * velocity.x - childMomentum.x, y: rock.massKg * velocity.y - childMomentum.y },
  };
}

function normalize(vector: Vec2): Vec2 {
  const length = Math.hypot(vector.x, vector.y);
  return length > 1e-6 ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 1 };
}

/** Settled fragments may fade, but never while they hold an objective or overlap another body. */
export function decayEligible(rock: RockState, speedMS: number, holdsObjective: boolean, overlapping: boolean): boolean {
  return rock.splitDepth > 0 && rock.radiusM <= ROCKS.minRadiusM * 2 && speedMS < 1 && !holdsObjective && !overlapping;
}
