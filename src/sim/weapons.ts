/**
 * Weapon runtime (Plan B6). The authority owns ammo, reload, cooldown, charge, resources and
 * module damage; saves them; and is the only thing that decides whether a shot happens. Clients
 * predict cosmetic shots and correct them on the resulting `shot` event — they never decide hits.
 *
 * Every function here is pure state transition plus arithmetic so the 120 Hz loop stays allocation
 * free: no weapon is created or discarded during a tick.
 */

import { HEAT, WEAPONS } from '../shared/balance.ts';
import type { FitDerivation, Id, NoticeCode, Vec2, WeaponSlot } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import type { RigidBody } from './types.ts';

/** Why a weapon will not fire: `cooldown` is normal pacing and never a user-facing error. */
export type FireBlock = NoticeCode | 'cooldown';

export interface WeaponRuntime {
  slotId: Id;
  partId: Id;
  spec: WeaponSlot;
  /** Fire group index, or null when the weapon is not in a group (then it never fires manually). */
  group: number | null;
  magazine: number | null;
  reserve: number | null;
  /** Tick the weapon becomes ready again (cooldown, or reload completion). */
  readyAtTick: number;
  reloadEndsAtTick: number | null;
  chargeStartTick: number | null;
  chargeFraction: number;
  /** Rail reserves its energy at charge start and returns the unused part on cancellation. */
  reservedMJ: number;
  chargeHeld: boolean;
  /** Auto-defence PDC may not also fire manually in the same tick. */
  firedThisTick: boolean;
  blockedReason: FireBlock | null;
  shotsFired: number;
}

export interface FireContext {
  tick: number;
  heatMJ: number;
  heatMaxMJ: number;
  capacitorMJ: number;
  /** False when the power priority left this group browned out this tick (B6). */
  groupPowered: boolean;
  /** Fire groups currently held, as a bit mask (bit 0 = group 1). */
  fireMask: number;
  /** True inside a station service volume, where firing is denied (B6). */
  insideServiceVolume: boolean;
  /** Slots whose module is destroyed; a destroyed weapon cannot fire at all (B6). */
  disabledSlots: ReadonlySet<Id>;
}

export function weaponGroupMask(group: number | null): number {
  return group === null ? 0 : 1 << group;
}

export function createWeapons(derived: FitDerivation, fireGroups: readonly (readonly Id[])[]): WeaponRuntime[] {
  const groupBySlot = new Map<Id, number>();
  fireGroups.forEach((group, index) => {
    for (const slotId of group) groupBySlot.set(slotId, index);
  });
  return derived.weaponSlots.map(spec => ({
    slotId: spec.slotId,
    partId: spec.partId,
    spec,
    // Point-defence is automatic: it is never wired to a manual fire group (B6).
    group: spec.behavior === 'point-defense' ? null : groupBySlot.get(spec.slotId) ?? null,
    magazine: spec.magazine,
    reserve: spec.reserve,
    readyAtTick: 0,
    reloadEndsAtTick: null,
    chargeStartTick: null,
    chargeFraction: 0,
    reservedMJ: 0,
    chargeHeld: false,
    firedThisTick: false,
    blockedReason: null,
    shotsFired: 0,
  }));
}

export function heatBlocked(heatMJ: number, heatMaxMJ: number): boolean {
  return heatMaxMJ > 0 && heatMJ >= heatMaxMJ * HEAT.block;
}

/** Heat gate for "hot" weapons; beams and drives are gated by the same rule. */
export function heatWarned(heatMJ: number, heatMaxMJ: number): boolean {
  return heatMaxMJ > 0 && heatMJ >= heatMaxMJ * HEAT.warn;
}

export function canFire(weapon: WeaponRuntime, context: FireContext): { ok: true } | { ok: false; reason: FireBlock } {
  const { spec } = weapon;
  if (context.insideServiceVolume) return { ok: false, reason: 'not-docked' };
  if (context.disabledSlots.has(weapon.slotId)) return { ok: false, reason: 'module-disabled' };
  if (!context.groupPowered) return { ok: false, reason: 'insufficient-power' };
  if (weapon.reloadEndsAtTick !== null) return { ok: false, reason: 'reloading' };
  if (weapon.readyAtTick > context.tick) return { ok: false, reason: 'cooldown' };
  if (spec.behavior === 'beam') return { ok: true };
  if (weapon.magazine !== null && weapon.magazine <= 0) {
    if (weapon.reserve !== null && weapon.reserve > 0) return { ok: false, reason: 'no-ammo' };
    return { ok: false, reason: 'no-ammo' };
  }
  if (spec.behavior === 'rail') {
    if (context.capacitorMJ < spec.energyShotMJ) return { ok: false, reason: 'insufficient-power' };
    return { ok: true };
  }
  if (heatBlocked(context.heatMJ, context.heatMaxMJ)) return { ok: false, reason: 'thermal-limit' };
  return { ok: true };
}

/** Rail charge: reserve the capacitor energy up front so two rails cannot spend the same MJ. */
export function beginCharge(weapon: WeaponRuntime, context: FireContext): boolean {
  if (weapon.spec.behavior !== 'rail' || weapon.chargeStartTick !== null) return false;
  if (context.capacitorMJ < weapon.spec.energyShotMJ) {
    weapon.blockedReason = 'insufficient-power';
    return false;
  }
  weapon.chargeStartTick = context.tick;
  weapon.reservedMJ = weapon.spec.energyShotMJ;
  return true;
}

export function cancelCharge(weapon: WeaponRuntime): number {
  const returned = weapon.reservedMJ;
  weapon.chargeStartTick = null;
  weapon.chargeFraction = 0;
  weapon.reservedMJ = 0;
  return returned;
}

export interface ShotPlan {
  /** Rounds consumed from the magazine, 0 for a beam. */
  rounds: number;
  energyMJ: number;
  heatMJ: number;
}

/**
 * Commit one shot. Returns null when the weapon may not shoot; the caller has already established
 * that through `canFire`, so a null here means the tick raced a reload and nothing is spent.
 */
export function commitShot(weapon: WeaponRuntime, context: FireContext): ShotPlan | null {
  const { spec } = weapon;
  if (weapon.reloadEndsAtTick !== null || weapon.readyAtTick > context.tick) return null;
  if (spec.behavior === 'beam') return { rounds: 0, energyMJ: 0, heatMJ: spec.heatShotMJ };
  if (weapon.magazine !== null && weapon.magazine <= 0) return null;
  const energyMJ = spec.behavior === 'rail' ? weapon.reservedMJ : spec.energyShotMJ;
  weapon.reservedMJ = 0;
  weapon.chargeStartTick = null;
  weapon.chargeFraction = 0;
  if (weapon.magazine !== null) weapon.magazine -= 1;
  weapon.readyAtTick = context.tick + Math.max(1, Math.round(spec.cooldownS * RELEASE.physicsHz));
  weapon.shotsFired += 1;
  weapon.firedThisTick = true;
  return { rounds: 1, energyMJ, heatMJ: spec.heatShotMJ };
}

/** Reload begins explicitly or when the trigger is held on empty; it pauses while disabled. */
export function beginReload(weapon: WeaponRuntime, tick: number): boolean {
  const { spec } = weapon;
  if (spec.behavior === 'beam' || spec.reloadS === null) return false;
  if (weapon.reloadEndsAtTick !== null) return false;
  if (weapon.reserve === null || weapon.reserve <= 0) return false;
  if (weapon.magazine !== null && spec.magazine !== null && weapon.magazine >= spec.magazine) return false;
  weapon.reloadEndsAtTick = tick + Math.max(1, Math.round(spec.reloadS * RELEASE.physicsHz));
  return true;
}

export function tickWeapons(weapons: readonly WeaponRuntime[], tick: number): void {
  for (const weapon of weapons) {
    weapon.firedThisTick = false;
    if (weapon.reloadEndsAtTick !== null && tick >= weapon.reloadEndsAtTick) {
      const want = weapon.spec.magazine ?? 0;
      const have = weapon.magazine ?? 0;
      const available = Math.min(weapon.reserve ?? 0, Math.max(0, want - have));
      weapon.magazine = have + available;
      weapon.reserve = (weapon.reserve ?? 0) - available;
      weapon.reloadEndsAtTick = null;
      weapon.readyAtTick = tick;
    }
    if (weapon.chargeStartTick !== null) {
      const elapsed = tick - weapon.chargeStartTick;
      weapon.chargeFraction = weapon.spec.chargeS > 0 ? Math.min(1, elapsed / (weapon.spec.chargeS * RELEASE.physicsHz)) : 1;
    }
  }
}

/** Guided projectiles are capped per owner so a torpedo volley cannot starve the shared pool. */
export function guidedInFlight(projectiles: readonly { ownerPilotId: Id; behavior: string }[], pilotId: Id, behavior: string): number {
  let count = 0;
  for (const projectile of projectiles) if (projectile.ownerPilotId === pilotId && projectile.behavior === behavior) count += 1;
  return count;
}

/** Admission control for the shared projectile pool (B6). Ammo is not spent on rejection. */
export function admitProjectile(activeCount: number, guidedCount: number, behavior: string): { ok: true } | { ok: false; reason: NoticeCode } {
  if (activeCount >= WEAPONS.maxProjectiles) return { ok: false, reason: 'weapon-traffic-limit' };
  if ((behavior === 'torpedo' || behavior === 'mine') && guidedCount >= WEAPONS.reservedGuidedSlots) {
    return { ok: false, reason: 'weapon-traffic-limit' };
  }
  return { ok: true };
}

export interface MuzzleSolution {
  position: Vec2;
  velocity: Vec2;
  state: 'unarmed' | 'armed' | 'burning' | 'coasting';
  armTick: number;
  expiresAtTick: number;
  behavior: WeaponSlot['behavior'];
}

/**
 * Muzzle velocity inherits the ship's velocity and the mount's tangential velocity, so a shot from
 * a turning hull leaves along the barrel instead of along the hull's centre-line (B5).
 */
export function solveMuzzle(
  weapon: WeaponRuntime,
  ship: RigidBody,
  muzzleWorld: Vec2,
  tick: number,
): MuzzleSolution {
  const { spec } = weapon;
  const forward = { x: -Math.sin(ship.angle), y: Math.cos(ship.angle) };
  const lever = { x: muzzleWorld.x - ship.position.x, y: muzzleWorld.y - ship.position.y };
  const tangential = { x: -ship.angularVelocity * lever.y, y: ship.angularVelocity * lever.x };
  const inherited = { x: ship.velocity.x + tangential.x, y: ship.velocity.y + tangential.y };
  const armTick = spec.armS > 0 ? tick + Math.max(1, Math.round(spec.armS * RELEASE.physicsHz)) : tick;
  const expiresAtTick = tick + Math.max(1, Math.round(spec.ttlS * RELEASE.physicsHz));
  if (spec.behavior === 'mine') {
    return {
      position: muzzleWorld,
      velocity: { x: inherited.x - forward.x * spec.speedMS, y: inherited.y - forward.y * spec.speedMS },
      state: 'unarmed',
      armTick,
      expiresAtTick,
      behavior: spec.behavior,
    };
  }
  const muzzleSpeed = spec.speedMS;
  const ballistic = {
    position: muzzleWorld,
    velocity: { x: inherited.x + forward.x * muzzleSpeed, y: inherited.y + forward.y * muzzleSpeed },
  };
  if (spec.behavior === 'torpedo') {
    return { ...ballistic, state: 'burning', armTick, expiresAtTick, behavior: spec.behavior };
  }
  const unarmed = spec.armS > 0;
  return { ...ballistic, state: unarmed ? 'unarmed' : 'armed', armTick, expiresAtTick, behavior: spec.behavior };
}

/** Recoil acts at the hardpoint, changing linear and angular momentum together (B5). */
export function recoilFor(weapon: WeaponRuntime, leverWorld: Vec2, ship: RigidBody): { force: Vec2; torque: number } {
  const magnitude = weapon.spec.impulseNS;
  if (magnitude === 0) return { force: { x: 0, y: 0 }, torque: 0 };
  const forward = { x: -Math.sin(ship.angle), y: Math.cos(ship.angle) };
  const force = { x: -forward.x * magnitude, y: -forward.y * magnitude };
  return { force, torque: leverWorld.x * force.y - leverWorld.y * force.x };
}

/**
 * Standard-mapping fire decision. Level-triggered: a held trigger fires whenever the weapon is
 * ready, so a dropped or duplicated input packet can never fire twice or fail to fire.
 */
export function wantsToFire(weapon: WeaponRuntime, context: FireContext): boolean {
  if (weapon.spec.behavior === 'point-defense') return false;
  return (context.fireMask & weaponGroupMask(weapon.group)) !== 0;
}
