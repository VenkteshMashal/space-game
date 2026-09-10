/**
 * The one canonical slot transform table (Plan A4/B5). Hardpoint positions, inertia parallel-axis
 * terms, recoil lever arms and hangar placement all read this table; nothing may invent its own
 * offsets. Local frame: +X starboard beam axis, +Y forward, metres from hull centre.
 */

import type { Id, SlotKind, Vec2 } from './contracts.ts';

export interface SlotTransform {
  slotId: Id;
  kind: SlotKind;
  /** Index within the kind: weapon index 0..3, utility index 0..2. */
  index: number;
  offset: Vec2;
  /** Mounting angle in the local frame; guns are forward-facing, gimbal comes from behaviour. */
  angleRad: number;
  /** Slot size for weapon slots (from chassis.weaponSizes); 1 for everything else. */
  size: number;
}

export interface ChassisGeometry {
  id: Id;
  lengthM: number;
  beamM: number;
  weaponSizes: readonly number[];
  utilities: number;
}

/** Fractional offsets of length (L) and beam (B) per canonical slot. */
const WEAPON_SLOTS: readonly Vec2[] = [
  { x: 0.3, y: 0.16 },
  { x: -0.3, y: 0.16 },
  { x: 0.32, y: -0.14 },
  { x: -0.32, y: -0.14 },
];
const UTILITY_SLOTS: readonly Vec2[] = [
  { x: 0.36, y: -0.26 },
  { x: -0.36, y: -0.26 },
  { x: 0, y: -0.3 },
];
const SINGLE_SLOTS: Readonly<Record<'e1' | 'r1' | 'a1' | 's1', { kind: SlotKind; offset: Vec2 }>> = {
  e1: { kind: 'engine', offset: { x: 0, y: -0.44 } },
  r1: { kind: 'reactor', offset: { x: 0, y: -0.04 } },
  a1: { kind: 'armor', offset: { x: 0, y: 0.02 } },
  s1: { kind: 'sensor', offset: { x: 0, y: 0.42 } },
};

/** Slot ID canon: `w1..wN`, `e1`, `r1`, `a1`, `s1`, `u1..uM`. Frozen at C0. */
export function slotsForChassis(chassis: ChassisGeometry): readonly SlotTransform[] {
  const slots: SlotTransform[] = [];
  chassis.weaponSizes.forEach((size, index) => {
    slots.push({
      slotId: `w${index + 1}`,
      kind: 'weapon',
      index,
      offset: scale(WEAPON_SLOTS[index] ?? WEAPON_SLOTS[WEAPON_SLOTS.length - 1]!, chassis.beamM, chassis.lengthM),
      angleRad: 0,
      size,
    });
  });
  for (const slotId of ['e1', 'r1', 'a1', 's1'] as const) {
    const spec = SINGLE_SLOTS[slotId];
    slots.push({ slotId, kind: spec.kind, index: 0, offset: scale(spec.offset, chassis.beamM, chassis.lengthM), angleRad: 0, size: 1 });
  }
  for (let index = 0; index < chassis.utilities; index++) {
    slots.push({
      slotId: `u${index + 1}`,
      kind: 'utility',
      index,
      offset: scale(UTILITY_SLOTS[index] ?? UTILITY_SLOTS[UTILITY_SLOTS.length - 1]!, chassis.beamM, chassis.lengthM),
      angleRad: 0,
      size: 1,
    });
  }
  return slots;
}

function scale(offset: Vec2, beamM: number, lengthM: number): Vec2 {
  return { x: offset.x * beamM, y: offset.y * lengthM };
}

export function slotOffsetM(chassis: ChassisGeometry, slotId: Id): Vec2 | null {
  const slot = slotsForChassis(chassis).find(candidate => candidate.slotId === slotId);
  return slot ? slot.offset : null;
}

/**
 * Beam muzzles for a fitted weapon: the canonical slot offset plus the mount's forward extent, so
 * a 42 m Kestrel does not fire from inside its own hull.
 */
export function muzzleOffsetM(chassis: ChassisGeometry, slotId: Id): Vec2 {
  const offset = slotOffsetM(chassis, slotId) ?? { x: 0, y: 0 };
  return { x: offset.x, y: offset.y + chassis.lengthM * 0.06 };
}
