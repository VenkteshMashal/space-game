/**
 * Utility behaviour (Plan B6). A fitted utility is a *capability*, not a stat: the repair drone
 * spends stock to heal a hull point at a time, the tether applies a capped spring force to another
 * body and snaps past its break force, and the ECM bay spends a charge to open a decoy contest that
 * a seeker can still win. Nothing here is guaranteed — every effect is bounded, costs something, and
 * reports what it actually did.
 */

import { RECOVERY, SENSOR } from '../shared/balance.ts';
import type { FitDerivation, Id, NoticeCode, UtilitySlot } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';

export interface UtilityRuntime {
  slotId: Id;
  partId: Id;
  kind: UtilitySlot['kind'];
  /** Tick the effect stops on its own, 0 when it is not running. */
  activeUntilTick: number;
  cooldownUntilTick: number;
  charges: number;
  repairStock: number;
  /** Ship the effect is currently applied to, for the tether and the repair beam. */
  targetId: Id | null;
}

export function createUtilities(derived: FitDerivation): UtilityRuntime[] {
  return derived.utilities.map(slot => ({
    slotId: slot.slotId,
    partId: slot.partId,
    kind: slot.kind,
    activeUntilTick: 0,
    cooldownUntilTick: 0,
    charges: slot.kind === 'ecm' ? derived.ecmCharges : 0,
    repairStock: slot.kind === 'repair' ? derived.repairStock : 0,
    targetId: null,
  }));
}

export function utilityIn(runtimes: readonly UtilityRuntime[], slotId: Id): UtilityRuntime | null {
  return runtimes.find(runtime => runtime.slotId === slotId) ?? null;
}

export interface UtilityRequest {
  slotId: Id;
  targetId: Id | null;
  active: boolean;
  tick: number;
  derived: FitDerivation;
}

export type UtilityOutcome =
  | { ok: true; untilTick: number }
  | { ok: false; reason: NoticeCode };

/**
 * Start or stop one utility. Activation is the expensive moment: the ECM charge is spent here, and a
 * running effect is never silently restarted with a fresh duration.
 */
export function setUtility(runtime: UtilityRuntime, request: UtilityRequest): UtilityOutcome {
  const { derived } = request;
  if (!request.active) {
    runtime.activeUntilTick = 0;
    runtime.targetId = null;
    return { ok: true, untilTick: 0 };
  }
  if (runtime.cooldownUntilTick > request.tick) return { ok: false, reason: 'insufficient-power' };
  switch (runtime.kind) {
    case 'repair':
      if (runtime.repairStock <= 0) return { ok: false, reason: 'insufficient-power' };
      if (request.targetId === null) return { ok: false, reason: 'invalid-target' };
      runtime.targetId = request.targetId;
      runtime.activeUntilTick = request.tick + REPAIR_TICK_LIMIT;
      return { ok: true, untilTick: runtime.activeUntilTick };
    case 'tether':
      if (request.targetId === null) return { ok: false, reason: 'invalid-target' };
      if (derived.tetherRangeM <= 0) return { ok: false, reason: 'out-of-range' };
      runtime.targetId = request.targetId;
      runtime.activeUntilTick = request.tick + TETHER_TICK_LIMIT;
      return { ok: true, untilTick: runtime.activeUntilTick };
    case 'ecm':
      if (runtime.charges <= 0) return { ok: false, reason: 'insufficient-power' };
      if (derived.ecmDurationS <= 0) return { ok: false, reason: 'invalid-target' };
      runtime.charges -= 1;
      runtime.activeUntilTick = request.tick + Math.round(derived.ecmDurationS * RELEASE.physicsHz);
      runtime.cooldownUntilTick = runtime.activeUntilTick + Math.round(derived.ecmCooldownS * RELEASE.physicsHz);
      return { ok: true, untilTick: runtime.activeUntilTick };
    case 'radiator':
    case 'capacitor':
    case 'salvage':
      // Passive parts: they are already folded into the derivation and have nothing to switch on.
      return { ok: false, reason: 'invalid-target' };
  }
}

const REPAIR_TICK_LIMIT = 30 * RELEASE.physicsHz;
const TETHER_TICK_LIMIT = 30 * RELEASE.physicsHz;

export function isActive(runtime: UtilityRuntime, tick: number): boolean {
  return runtime.activeUntilTick > tick;
}

/** One second of repair: hull points healed, and the stock units that were consumed for them. */
export function repairStep(stock: number, hull: number, hullMax: number, repairHullS: number, dtSeconds: number): { healed: number; stockLeft: number } {
  if (stock <= 0 || hull >= hullMax || repairHullS <= 0) return { healed: 0, stockLeft: stock };
  // One stock unit per hull point (B6), so the bay runs out exactly when the hull is whole.
  const wanted = Math.min(hullMax - hull, repairHullS * dtSeconds);
  const healed = Math.min(wanted, stock);
  return { healed, stockLeft: stock - healed };
}

export interface TetherPull {
  forceN: number;
  /** True when the required force exceeded the tether's break force: the line parts. */
  broke: boolean;
}

/**
 * Capped spring-damper along the line between two bodies. The force is bounded by the tether's own
 * rating, and past its break force the line parts rather than hauling a heavy ship regardless.
 */
export function tetherPull(distanceM: number, closingSpeedMS: number, derived: FitDerivation): TetherPull | null {
  if (derived.tetherRangeM <= 0) return null;
  if (distanceM > derived.tetherRangeM) return null;
  // Tension grows with stretch past the rest length and falls as the pair closes on each other; a
  // fast separator raises it until the line parts rather than hauling a heavy ship regardless.
  const stretch = Math.max(0, distanceM - derived.tetherRangeM * 0.5);
  const tension = stretch * TETHER_SPRING_N_PER_M - closingSpeedMS * TETHER_DAMPING_NS_PER_M;
  if (tension > derived.tetherBreakForceN) return { forceN: 0, broke: true };
  return { forceN: Math.max(0, Math.min(tension, derived.tetherForceN)), broke: false };
}

const TETHER_SPRING_N_PER_M = 2000;
const TETHER_DAMPING_NS_PER_M = 4000;

/** Guided weapons fly their last course for a moment after losing a lock, then may reacquire. */
export function lockLostTicks(): number {
  return Math.round(SENSOR.ecmLoseSeconds * RELEASE.physicsHz);
}

export function recoveryRangeM(derived: FitDerivation): number {
  return derived.repairRangeM > 0 ? derived.repairRangeM : RECOVERY.repairRangeM;
}
