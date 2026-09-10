/**
 * B7 campaign life and recovery: one destruction event per life, a recoverable wreck with a rescue
 * beacon, a loaner redeploy after 15 s, the shared wallet's recovery fee, and the attempt/checkpoint
 * reset that prevents farming while keeping already committed receipts.
 *
 * Nothing here decides mission outcomes; it produces the facts the authority and the mission runtime
 * consume. No wall clock: every deadline is an integer tick.
 */

import { RECOVERY } from '../../shared/balance.ts';
import type { Id, Vec2 } from '../../shared/contracts.ts';
import { CAMPAIGN_TICK_RATE } from './missions.ts';
import type { VoteResolution, VoteState } from './votes.ts';
import { openVote, resolveVote } from './votes.ts';

/** Recovery fee after the pilot's free one on this mission (B7). */
export const RECOVERY_COST_CREDITS = RECOVERY.recoveryCostCredits;

/** How long a wreck waits for a salvage run before its modules come back damaged (authored). */
export const WRECK_LIFETIME_SECONDS = 60;

/** All-humans-destroyed vote: 20 s, conservative default is retrying the checkpoint (B7). */
export const RECOVERY_VOTE = {
  id: 'recovery-after-wipe',
  seconds: 20,
  defaultOptionId: 'retry-checkpoint',
  options: [
    { id: 'retry-checkpoint', label: 'Retry from the checkpoint' },
    { id: 'return-carrier', label: 'Return to the carrier' },
  ],
} as const;

export interface OwnedModule {
  instanceId: Id;
  partId: Id;
  replacementCostCredits: number;
}

export interface Wreck {
  id: Id;
  pilotId: Id;
  tick: number;
  position: Vec2;
  modules: readonly OwnedModule[];
}

export interface RescueBeacon {
  id: Id;
  wreckId: Id;
  position: Vec2;
  reachable: boolean;
}

export interface RedeploySchedule {
  pilotId: Id;
  wreckId: Id;
  atTick: number;
}

/** Module that came back without a salvage run: damaged, with the repair priced at 25% (B7). */
export interface DamagedInventory {
  instanceId: Id;
  partId: Id;
  health: number;
  repairPriceCredits: number;
}

export interface AttemptSnapshot {
  /** Repair kits, tugs and similar consumables available at the checkpoint. */
  consumables: number;
  /** Optional loot collected since the checkpoint; a reset drops it. */
  optionalLoot: Id[];
}

export interface RecoveryState {
  missionId: Id;
  credits: number;
  wreckLifetimeTicks: number;
  nextWreckNumber: number;
  wrecks: Wreck[];
  beacons: RescueBeacon[];
  redeploys: RedeploySchedule[];
  /** Pilots destroyed and not yet redeployed; also the "one destruction event" guard. */
  downed: Set<Id>;
  /** Pilots that already spent their free recovery on this mission. */
  freeRecoveriesUsed: Set<Id>;
  /** instanceId -> damaged inventory returned by an unrecovered wreck. */
  damaged: Map<Id, DamagedInventory>;
  /** cargoId -> beaconId; critical cargo is never sold or permanently destroyed. */
  criticalCargo: Map<Id, Id>;
  /** cargoId -> wreckId; waiting for a reachable beacon, never lost. */
  pendingCargo: Map<Id, Id>;
  /** receiptId -> credits; committed exactly once, never revoked by a reset. */
  receipts: Map<Id, number>;
  checkpoint: AttemptSnapshot;
  attempt: AttemptSnapshot;
  vote: VoteState | null;
}

export function createRecoveryState(missionId: Id, credits: number): RecoveryState {
  return {
    missionId,
    credits,
    wreckLifetimeTicks: WRECK_LIFETIME_SECONDS * CAMPAIGN_TICK_RATE,
    nextWreckNumber: 1,
    wrecks: [],
    beacons: [],
    redeploys: [],
    downed: new Set(),
    freeRecoveriesUsed: new Set(),
    damaged: new Map(),
    criticalCargo: new Map(),
    pendingCargo: new Map(),
    receipts: new Map(),
    checkpoint: { consumables: 0, optionalLoot: [] },
    attempt: { consumables: 0, optionalLoot: [] },
    vote: null,
  };
}

/** Snapshot the attempt at a safe objective transition; `resetAttempt` restores exactly this. */
export function setCheckpoint(state: RecoveryState): void {
  state.checkpoint = { consumables: state.attempt.consumables, optionalLoot: [...state.attempt.optionalLoot] };
}

export interface DestructionInput {
  pilotId: Id;
  tick: number;
  position: Vec2;
  modules: readonly OwnedModule[];
  /** Mission-critical cargo: transferred whole to a reachable beacon, never destroyed. */
  criticalCargo: readonly Id[];
  /** Whether the ejected beacon is reachable from the wreck; false leaves cargo pending. */
  beaconReachable: boolean;
}

export interface DestructionResult {
  code: 'destroyed' | 'already-destroyed';
  wreckId: Id;
  beaconId: Id;
  redeployAtTick: number;
}

export function recordDestruction(state: RecoveryState, input: DestructionInput): DestructionResult {
  const existing = state.redeploys.find(entry => entry.pilotId === input.pilotId);
  if (state.downed.has(input.pilotId) && existing !== undefined) {
    return { code: 'already-destroyed', wreckId: existing.wreckId, beaconId: `${existing.wreckId}-beacon`, redeployAtTick: existing.atTick };
  }

  const position: Vec2 = { x: input.position.x, y: input.position.y };
  const wreckId = `wreck-${state.nextWreckNumber}`;
  const beaconId = `${wreckId}-beacon`;
  state.nextWreckNumber++;
  state.wrecks.push({ id: wreckId, pilotId: input.pilotId, tick: input.tick, position, modules: [...input.modules] });
  state.beacons.push({ id: beaconId, wreckId, position, reachable: input.beaconReachable });
  state.downed.add(input.pilotId);

  const atTick = input.tick + RECOVERY.redeploySeconds * CAMPAIGN_TICK_RATE;
  state.redeploys.push({ pilotId: input.pilotId, wreckId, atTick });
  for (const cargoId of input.criticalCargo) {
    if (input.beaconReachable) state.criticalCargo.set(cargoId, beaconId);
    else state.pendingCargo.set(cargoId, wreckId);
  }
  return { code: 'destroyed', wreckId, beaconId, redeployAtTick: atTick };
}

/** A beacon that becomes reachable takes its wreck's pending critical cargo, all of it or none. */
export function markBeaconReachable(state: RecoveryState, beaconId: Id): readonly Id[] {
  const beacon = state.beacons.find(entry => entry.id === beaconId);
  if (beacon === undefined) return [];
  beacon.reachable = true;
  const moved: Id[] = [];
  for (const [cargoId, wreckId] of state.pendingCargo) {
    if (wreckId !== beacon.wreckId) continue;
    state.criticalCargo.set(cargoId, beaconId);
    state.pendingCargo.delete(cargoId);
    moved.push(cargoId);
  }
  return moved;
}

export interface RedeployResult {
  code: 'deployed' | 'early' | 'no-wreck';
  /** True when this was the pilot's free recovery on this mission. */
  free: boolean;
  paidCredits: number;
  /** True when the fee was unaffordable and the pilot's optional cargo was forfeited instead. */
  forfeitedOptionalCargo: boolean;
  atTick: number;
}

export function redeploy(state: RecoveryState, pilotId: Id, tick: number): RedeployResult {
  const index = state.redeploys.findIndex(entry => entry.pilotId === pilotId);
  if (index < 0) return { code: 'no-wreck', free: false, paidCredits: 0, forfeitedOptionalCargo: false, atTick: tick };
  const schedule = state.redeploys[index]!;
  if (tick < schedule.atTick) return { code: 'early', free: false, paidCredits: 0, forfeitedOptionalCargo: false, atTick: schedule.atTick };

  state.redeploys.splice(index, 1);
  state.downed.delete(pilotId);
  const free = !state.freeRecoveriesUsed.has(pilotId);
  if (free) {
    state.freeRecoveriesUsed.add(pilotId);
    return { code: 'deployed', free: true, paidCredits: 0, forfeitedOptionalCargo: false, atTick: schedule.atTick };
  }
  if (state.credits >= RECOVERY_COST_CREDITS) {
    state.credits -= RECOVERY_COST_CREDITS;
    return { code: 'deployed', free: false, paidCredits: RECOVERY_COST_CREDITS, forfeitedOptionalCargo: false, atTick: schedule.atTick };
  }
  // Insolvency never blocks play: the loaner flies anyway and optional loot is left behind (B7).
  state.attempt.optionalLoot = [];
  return { code: 'deployed', free: false, paidCredits: 0, forfeitedOptionalCargo: true, atTick: schedule.atTick };
}

export interface SalvageResult {
  code: 'ok' | 'unknown-wreck';
  modules: readonly OwnedModule[];
}

/** A crewmate reaching the wreck recovers its modules whole; the wreck is then gone. */
export function salvageWreck(state: RecoveryState, wreckId: Id): SalvageResult {
  const index = state.wrecks.findIndex(entry => entry.id === wreckId);
  if (index < 0) return { code: 'unknown-wreck', modules: [] };
  const wreck = state.wrecks[index]!;
  state.wrecks.splice(index, 1);
  state.beacons = state.beacons.filter(beacon => beacon.wreckId !== wreckId);
  return { code: 'ok', modules: wreck.modules };
}

/** Expire wrecks: unrecovered modules return as damaged inventory at 25% replacement price (B7). */
export function advanceRecovery(state: RecoveryState, tick: number): readonly DamagedInventory[] {
  const returned: DamagedInventory[] = [];
  for (let index = state.wrecks.length - 1; index >= 0; index--) {
    const wreck = state.wrecks[index]!;
    if (tick - wreck.tick < state.wreckLifetimeTicks) continue;
    for (const module of wreck.modules) {
      const entry: DamagedInventory = {
        instanceId: module.instanceId,
        partId: module.partId,
        health: 1 - RECOVERY.moduleRepairFraction,
        repairPriceCredits: module.replacementCostCredits * RECOVERY.moduleRepairFraction,
      };
      state.damaged.set(entry.instanceId, entry);
      returned.push(entry);
    }
    state.wrecks.splice(index, 1);
    state.beacons = state.beacons.filter(beacon => beacon.wreckId !== wreck.id);
  }
  return returned;
}

/** Shared wallet receipt: one commit per receipt ID, so a replay cannot pay twice (B9). */
export function awardReceipt(state: RecoveryState, receiptId: Id, credits: number): boolean {
  if (state.receipts.has(receiptId)) return false;
  state.receipts.set(receiptId, credits);
  state.credits += credits;
  return true;
}

/**
 * All-humans-destroyed vote. Elibility is humans only: bots can never ballot and can never complete
 * a mission objective, so an empty roster resolves to the conservative default instead.
 */
export function openRecoveryVote(state: RecoveryState, eligibleHumanPilotIds: readonly Id[], tick: number): VoteState {
  state.vote = openVote({
    id: RECOVERY_VOTE.id,
    kind: 'recovery',
    options: RECOVERY_VOTE.options,
    defaultOptionId: RECOVERY_VOTE.defaultOptionId,
    eligiblePilotIds: eligibleHumanPilotIds,
    tick,
    seconds: RECOVERY_VOTE.seconds,
  });
  return state.vote;
}

export function resolveRecoveryVote(state: RecoveryState, tick: number): VoteResolution {
  if (state.vote === null) return { committed: false, optionId: null, reason: 'open' };
  return resolveVote(state.vote, tick);
}

export interface ResetResult {
  /** Optional loot dropped by the reset (uncommitted only). */
  droppedLoot: readonly Id[];
  /** Receipts retained, in commit order. */
  retainedReceipts: readonly Id[];
}

/** Restore attempt resources to the checkpoint; committed receipts and credits stay (B7 farming). */
export function resetAttempt(state: RecoveryState): ResetResult {
  const droppedLoot = state.attempt.optionalLoot.filter(id => !state.checkpoint.optionalLoot.includes(id));
  state.attempt = { consumables: state.checkpoint.consumables, optionalLoot: [...state.checkpoint.optionalLoot] };
  return { droppedLoot, retainedReceipts: [...state.receipts.keys()] };
}
