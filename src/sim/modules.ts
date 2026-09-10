/**
 * Module health and hull zones (Plan B6). An impact lands somewhere on the hull, and that place
 * decides which modules take damage — never a client claim. A damaged module keeps working at
 * reduced output, a destroyed one stops working entirely, and the penalty is always applied *from
 * base* so repeated hits cannot compound a penalty into nonsense.
 *
 * Four zones, mapped to slots by the canonical transform table, so the hangar can show the same
 * layout the authority damages.
 */

import { MODULE } from '../shared/balance.ts';
import { CATALOG } from '../shared/catalog.ts';
import type { Fit, Id, Vec2 } from '../shared/contracts.ts';
import { slotsForChassis, type ChassisGeometry } from '../shared/slots.ts';

/** Bow, starboard, stern, port — the four hit zones a 2D hull presents. */
export type HullZone = 'bow' | 'starboard' | 'stern' | 'port';

export const HULL_ZONES: readonly HullZone[] = ['bow', 'starboard', 'stern', 'port'];

export interface ModuleState {
  slotId: Id;
  partId: Id;
  zone: HullZone;
  health: number;
  maxHealth: number;
  /** 0..1 multiplier applied from base, never compounded per tick. */
  output: number;
  disabled: boolean;
}

export interface ModuleSet {
  modules: readonly ModuleState[];
  bySlot: ReadonlyMap<Id, ModuleState>;
  zones: Readonly<Record<HullZone, readonly Id[]>>;
}

/** Module hit points come from the part's own mass: a heavier, denser module survives longer. */
export function moduleMaxHealth(partId: Id, massKg: number): number {
  return Math.max(8, Math.round(6 + massKg ** 0.5 * 0.8));
}

/**
 * Which zone an impact lands in. The hull's local frame has +Y forward and +X starboard; a blow on
 * the centre line is resolved by whichever axis it is furthest along, with the bow taking priority
 * so a head-on hit never routes to a random side.
 */
export function zoneForImpact(local: Vec2, lengthM: number, beamM: number): HullZone {
  const forward = local.y / Math.max(1, lengthM * 0.5);
  const lateral = local.x / Math.max(1, beamM * 0.5);
  if (forward >= 0.35 && forward >= Math.abs(lateral)) return 'bow';
  if (forward <= -0.35 && -forward >= Math.abs(lateral)) return 'stern';
  return lateral >= 0 ? 'starboard' : 'port';
}

/** World-space impact point in the hull's local frame, given the hull pose. */
export function toLocal(point: Vec2, position: Vec2, angle: number): Vec2 {
  const dx = point.x - position.x;
  const dy = point.y - position.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

export function createModuleSet(fit: Fit, chassis: ChassisGeometry): ModuleSet {
  const transforms = slotsForChassis(chassis);
  const modules: ModuleState[] = [];
  const zones: Record<HullZone, Id[]> = { bow: [], starboard: [], stern: [], port: [] };
  for (const transform of transforms) {
    const partId = fit.slots[transform.slotId];
    if (!partId) continue;
    const maxHealth = moduleMaxHealth(partId, partMass(partId));
    const zone = zoneForImpact(transform.offset, chassis.lengthM, chassis.beamM);
    zones[zone].push(transform.slotId);
    modules.push({ slotId: transform.slotId, partId, zone, health: maxHealth, maxHealth, output: 1, disabled: false });
  }
  return { modules, bySlot: new Map(modules.map(module => [module.slotId, module])), zones };
}

/** A heavier, denser part survives longer; an unknown part gets the lightest module's durability. */
function partMass(partId: Id): number {
  return CATALOG.partById.get(partId)?.massKg ?? 1000;
}

/** Output from *base*: 1 above the damage threshold, half below it, zero when destroyed. */
export function outputFor(health: number, maxHealth: number): number {
  if (maxHealth <= 0 || health <= 0) return 0;
  return health / maxHealth < MODULE.damagedBelow ? MODULE.damagedOutput : 1;
}

export interface ModuleDamageResult { zone: HullZone; slots: readonly Id[]; disabled: readonly Id[]; damaged: boolean }

/**
 * Apply damage that landed at `local` on the hull. Only the struck zone's modules take the hit, and
 * the module nearest the impact absorbs the worst of it, so a hit does not uniformly sandpaper the
 * whole ship.
 */
export function damageAt(set: ModuleSet, local: Vec2, lengthM: number, beamM: number, damage: number): ModuleDamageResult {
  const zone = zoneForImpact(local, lengthM, beamM);
  const slots = set.zones[zone];
  const disabled: Id[] = [];
  if (slots.length === 0 || damage <= 0) return { zone, slots, disabled, damaged: false };
  const share = damage / slots.length;
  for (const slotId of slots) {
    const module = set.bySlot.get(slotId);
    if (!module) continue;
    module.health = Math.max(0, module.health - share);
    module.output = outputFor(module.health, module.maxHealth);
    if (module.output === 0 && !module.disabled) {
      module.disabled = true;
      disabled.push(slotId);
    }
  }
  return { zone, slots, disabled, damaged: true };
}

/** Repair restores health and re-enables a module that was knocked out (B6 dock repair). */
export function repairModule(module: ModuleState, hullPoints: number): number {
  const before = module.health;
  module.health = Math.min(module.maxHealth, module.health + hullPoints);
  module.output = outputFor(module.health, module.maxHealth);
  module.disabled = module.output === 0;
  return module.health - before;
}

export function slotOutput(set: ModuleSet, slotId: Id): number {
  return set.bySlot.get(slotId)?.output ?? 1;
}

export function disabledSlots(set: ModuleSet): readonly Id[] {
  return set.modules.filter(module => module.disabled).map(module => module.slotId);
}

/** Fields the checkpoint stores (B9): health only, since output is derived from it. */
export function moduleSave(set: ModuleSet): readonly { slotId: Id; health: number }[] {
  return set.modules.map(module => ({ slotId: module.slotId, health: module.health }));
}

export function restoreModules(set: ModuleSet, saved: readonly { slotId: Id; health: number }[]): void {
  for (const entry of saved) {
    const module = set.bySlot.get(entry.slotId);
    if (!module) continue;
    module.health = Math.max(0, Math.min(module.maxHealth, entry.health));
    module.output = outputFor(module.health, module.maxHealth);
    module.disabled = module.output === 0;
  }
}
