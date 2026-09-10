/**
 * B8 objective runtime. Pure state transitions: no socket, no DOM, no timer and no wall clock, so
 * the same event and tick sequence always produces the same mission state and a checkpoint can
 * resume from the last acknowledged tick.
 *
 * Three rules shape the predicates:
 *   - progress counts *unique item IDs* keyed by item slot, never button presses, so replaying a
 *     completion is a no-op and a concurrent duplicate recovery gets `already-recovered`;
 *   - sustained work (scan, repair, ...) is banked by `advance` from the contributors currently in
 *     range, at most twice the solo rate, and leaving clears the contribution and not the bank;
 *   - a bot contribution can finish work, but no objective completes without a human contribution
 *     (B7: bots cannot auto-complete objectives alone).
 *
 * `advance` allocates nothing: every array it touches is sized at creation and every scratch buffer
 * lives on the runtime.
 */

import { RELEASE } from '../../shared/contracts.ts';
import type { Id, ObjectiveView, Vec2 } from '../../shared/contracts.ts';
import type { Rng } from '../../shared/rng.ts';
import { createRng } from '../../shared/rng.ts';
import type { MissionDecision, MissionDefinition, MissionObjective, MissionOptionRef, ObjectiveState } from './missions.ts';
import { CAMPAIGN_TICK_RATE, SHARED_WORK_KINDS, missionDecision, missionDefinition, spawnEntityIds, stageCount } from './missions.ts';

/** Two pilots working the same node double the rate; nothing goes faster than that (B8). */
const MAX_SHARED_RATE = 2;
/** A pilot that stops reporting stops contributing; the work bank is never erased (B8). */
const CONTRIBUTOR_TTL_TICKS = CAMPAIGN_TICK_RATE;
/** Berth rules (B8): < 10 m/s, within 30 deg of the berth heading, clear berth, visible queue. */
const BERTH_MAX_SPEED_MS = 10;
const BERTH_HEADING_TOLERANCE_DEG = 30;
/** Contributors per objective: every seat plus the NPCs that can work one (B7 bots). */
const MAX_CONTRIBUTORS = RELEASE.maxHumans + RELEASE.maxPveEnemies;

export type CampaignOutcome = 'in-progress' | 'mission-complete' | 'mission-failed';

export type ObjectiveEventKind = 'observe' | 'depart' | 'item-lost' | 'fail';

/** One observation, loss or outcome from the authority. Facts only: the runtime never probes anyone. */
export interface ObjectiveEvent {
  objectiveId: Id;
  kind: ObjectiveEventKind;
  /** Unique item this observation is about; null for single-shot objectives. */
  itemId: Id | null;
  pilotId: Id | null;
  isBot: boolean;
  tick: number;
  distanceM: number;
  relativeSpeedMS: number;
  lineOfSight: boolean;
  targetAlive: boolean;
  pilotAlive: boolean;
  /** Absolute heading error to the berth heading in degrees; null when not docking. */
  headingErrorDeg: number | null;
  berthClear: boolean;
  queueVisible: boolean;
}

export type ObjectiveEventCode =
  | 'ok'
  | 'already-recovered'
  | 'already-complete'
  | 'locked'
  | 'failed'
  | 'unknown-objective'
  | 'wrong-item'
  | 'out-of-range'
  | 'too-fast'
  | 'no-line-of-sight'
  | 'target-lost'
  | 'target-alive'
  | 'pilot-dead'
  | 'no-pilot'
  | 'berth-blocked'
  | 'no-queue'
  | 'bad-heading'
  | 'item-away'
  | 'awaiting-decision'
  | 'recovery'
  | 'unrecoverable';

export interface ObjectiveEventResult {
  accepted: boolean;
  code: ObjectiveEventCode;
  objectiveId: Id;
  state: ObjectiveState;
  completed: number;
  required: number;
}

export interface ContributorSlot {
  pilotId: Id | null;
  itemIndex: number;
  lastTick: number;
}

export interface ObjectiveRuntimeState {
  state: ObjectiveState;
  /** Unique counted item IDs per item slot; single-shot objectives use slot 0. */
  counted: (Id | null)[];
  countedCount: number;
  /** Banked work seconds per item slot for work kinds. */
  work: number[];
  workDone: boolean[];
  contributors: ContributorSlot[];
  /** True once a human contributed; without it the objective can never complete (B7). */
  humanContributed: boolean;
  /** Item slot -> tick it returns from a loss recovery (0 = available). */
  awayUntil: number[];
}

export interface SpawnRuntime {
  active: boolean;
  entityIds: readonly Id[];
  /** Mission-stream roll per entity: index into the group's chassis list, -1 for props. */
  chassisPicks: number[];
  spawnedAtTick: number | null;
}

export interface ItemReturnSlot {
  objectiveIndex: number;
  itemIndex: number;
  atTick: number;
}

export interface TowState {
  transportId: Id;
  autoTowAtTick: number;
  dispatched: boolean;
}

export interface MissionProgression {
  unlocks: readonly Id[];
  nextMissionId: Id | null;
  nextSectorId: Id | null;
  repeatable: boolean;
}

export interface CampaignRuntime {
  readonly mission: MissionDefinition;
  readonly seed: number;
  /** Mission RNG stream: wave/spawn composition now, checkpointed for save and replay (B9). */
  readonly rng: Rng;
  readonly objectiveIndex: Readonly<Record<Id, number>>;
  readonly states: ObjectiveRuntimeState[];
  readonly spawns: SpawnRuntime[];
  /** Advance scratch: per-item contributor counts, sized to the widest objective. */
  readonly itemCounts: number[];
  readonly returns: ItemReturnSlot[];
  readonly stageTotal: number;
  tick: number;
  stage: number;
  outcome: CampaignOutcome;
  completedAtTick: number | null;
  failedObjectiveId: Id | null;
  /** decisionId -> committed optionId; a decision is never re-opened (B8). */
  decisions: Map<Id, Id>;
  allyId: Id | null;
  cosmeticId: Id | null;
  rewardCredits: number;
  bonusCredits: number;
  receiptId: Id | null;
  progression: MissionProgression | null;
  beacons: Id[];
  optionalBonusLost: boolean;
  tow: TowState | null;
  wipeCount: number;
  lastWipeTick: number | null;
}

export interface DecisionCommit {
  committed: boolean;
  code: 'ok' | 'unknown-decision' | 'unknown-option' | 'already-decided' | 'not-active';
  optionId: Id | null;
}

export interface CheckpointReset {
  /** Stage the attempt restarted from. */
  stage: number;
  /** Objectives re-attempted; committed stages are untouched. */
  clearedObjectiveIds: readonly Id[];
}

function slotCountOf(def: MissionObjective): number {
  return def.items.length > 0 ? def.items.length : 1;
}

function newObjectiveState(def: MissionObjective): ObjectiveRuntimeState {
  const slots = slotCountOf(def);
  const contributors: ContributorSlot[] = [];
  for (let index = 0; index < MAX_CONTRIBUTORS; index++) contributors.push({ pilotId: null, itemIndex: 0, lastTick: 0 });
  return {
    state: 'locked',
    counted: new Array<Id | null>(slots).fill(null),
    countedCount: 0,
    work: new Array<number>(slots).fill(0),
    workDone: new Array<boolean>(slots).fill(false),
    contributors,
    humanContributed: false,
    awayUntil: new Array<number>(slots).fill(0),
  };
}

export function createCampaignRuntime(missionId: Id, seed: number, tick: number): CampaignRuntime {
  const mission = missionDefinition(missionId);
  if (mission === null) throw new RangeError(`unknown campaign mission: ${missionId}`);

  const objectiveIndex: Record<Id, number> = {};
  const states: ObjectiveRuntimeState[] = [];
  let widest = 1;
  for (let index = 0; index < mission.objectives.length; index++) {
    const def = mission.objectives[index]!;
    objectiveIndex[def.id] = index;
    states.push(newObjectiveState(def));
    widest = Math.max(widest, slotCountOf(def));
  }

  const spawns: SpawnRuntime[] = mission.spawnGroups.map(group => ({
    active: false,
    entityIds: spawnEntityIds(group),
    chassisPicks: new Array<number>(group.count).fill(-1),
    spawnedAtTick: null,
  }));

  const returns: ItemReturnSlot[] = [];
  for (let index = 0; index < 8; index++) returns.push({ objectiveIndex: 0, itemIndex: 0, atTick: 0 });

  const runtime: CampaignRuntime = {
    mission,
    seed,
    rng: createRng(seed, 'mission'),
    objectiveIndex,
    states,
    spawns,
    itemCounts: new Array<number>(widest).fill(0),
    returns,
    stageTotal: stageCount(mission),
    tick,
    stage: 0,
    outcome: 'in-progress',
    completedAtTick: null,
    failedObjectiveId: null,
    decisions: new Map(),
    allyId: null,
    cosmeticId: null,
    rewardCredits: 0,
    bonusCredits: 0,
    receiptId: null,
    progression: null,
    beacons: [],
    optionalBonusLost: false,
    tow: null,
    wipeCount: 0,
    lastWipeTick: null,
  };
  activateStage(runtime, 0);
  return runtime;
}

/** A branch gate only opens for the committed option; an uncommitted decision locks its branches. */
function branchAllows(runtime: CampaignRuntime, ref: MissionOptionRef | null): boolean {
  return ref === null || runtime.decisions.get(ref.decisionId) === ref.optionId;
}

function activateStage(runtime: CampaignRuntime, stage: number): void {
  runtime.stage = stage;
  for (let index = 0; index < runtime.mission.objectives.length; index++) {
    const def = runtime.mission.objectives[index]!;
    if (def.stage !== stage) continue;
    runtime.states[index]!.state = branchAllows(runtime, def.requiresOption) ? 'active' : 'locked';
  }
  activateSpawns(runtime);
}

/** Spawn groups appear on their stage, and only once their trigger objective counted enough items. */
function activateSpawns(runtime: CampaignRuntime): void {
  for (let index = 0; index < runtime.spawns.length; index++) {
    const spawn = runtime.spawns[index]!;
    if (spawn.active) continue;
    const group = runtime.mission.spawnGroups[index]!;
    if (group.fromStage > runtime.stage) continue;
    if (group.triggerObjectiveId !== null) {
      const trigger = runtime.objectiveIndex[group.triggerObjectiveId] ?? -1;
      if (trigger < 0 || runtime.states[trigger]!.countedCount < group.afterItems) continue;
    }
    spawn.active = true;
    spawn.spawnedAtTick = runtime.tick;
    for (let entity = 0; entity < spawn.chassisPicks.length; entity++) {
      spawn.chassisPicks[entity] = group.chassisIds.length === 0 ? -1 : runtime.rng.int(group.chassisIds.length);
    }
  }
}

function stageSatisfied(runtime: CampaignRuntime, stage: number): boolean {
  for (let index = 0; index < runtime.mission.objectives.length; index++) {
    const def = runtime.mission.objectives[index]!;
    if (def.stage !== stage) continue;
    if (!branchAllows(runtime, def.requiresOption)) continue;
    if (runtime.states[index]!.state !== 'complete') return false;
  }
  return true;
}

function completeObjective(runtime: CampaignRuntime, index: number): void {
  runtime.states[index]!.state = 'complete';
}

/** Objective is done only when a human contributed and every item slot is satisfied (B7). */
function objectiveComplete(def: MissionObjective, state: ObjectiveRuntimeState): boolean {
  if (!state.humanContributed) return false;
  if (def.kind === 'decision') return false;
  if (def.workSeconds > 0) {
    for (let slot = 0; slot < state.workDone.length; slot++) if (!state.workDone[slot]) return false;
    return true;
  }
  return state.countedCount >= slotCountOf(def);
}

/** Commit a stage boundary, open the next stage, or settle the mission. */
function settleStage(runtime: CampaignRuntime): void {
  if (runtime.outcome !== 'in-progress') return;
  for (let guard = 0; guard <= runtime.stageTotal; guard++) {
    if (!stageSatisfied(runtime, runtime.stage)) return;
    if (runtime.stage + 1 >= runtime.stageTotal) {
      completeMission(runtime);
      return;
    }
    activateStage(runtime, runtime.stage + 1);
  }
}

function completeMission(runtime: CampaignRuntime): void {
  const mission = runtime.mission;
  let bonus = 0;
  for (let index = 0; index < mission.decisions.length; index++) {
    const decision = mission.decisions[index]!;
    const chosen = runtime.decisions.get(decision.id);
    if (chosen === undefined) continue;
    for (let option = 0; option < decision.options.length; option++) {
      if (decision.options[option]!.id === chosen) bonus += decision.options[option]!.bonusCredits;
    }
  }
  runtime.outcome = 'mission-complete';
  runtime.completedAtTick = runtime.tick;
  runtime.rewardCredits = mission.rewardCredits;
  runtime.bonusCredits = bonus;
  runtime.receiptId = mission.receiptId;
  runtime.progression = {
    unlocks: mission.unlocks,
    nextMissionId: mission.transitions.nextMissionId,
    nextSectorId: mission.transitions.nextSectorId,
    repeatable: mission.transitions.repeatable,
  };
}

/** Advance one tick. Monotonic ticks only; allocates nothing. */
export function advance(runtime: CampaignRuntime, tick: number): void {
  if (!Number.isInteger(tick) || tick <= runtime.tick) return;
  const seconds = (tick - runtime.tick) / CAMPAIGN_TICK_RATE;
  runtime.tick = tick;

  // Recovery timers survive a settlement so a returning cell is never stuck in limbo.
  for (let index = 0; index < runtime.returns.length; index++) {
    const slot = runtime.returns[index]!;
    if (slot.atTick === 0 || tick < slot.atTick) continue;
    slot.atTick = 0;
    runtime.states[slot.objectiveIndex]!.awayUntil[slot.itemIndex] = 0;
  }
  if (runtime.tow !== null && !runtime.tow.dispatched && tick >= runtime.tow.autoTowAtTick) runtime.tow.dispatched = true;
  if (runtime.outcome !== 'in-progress') return;

  for (let index = 0; index < runtime.mission.objectives.length; index++) {
    const def = runtime.mission.objectives[index]!;
    const state = runtime.states[index]!;
    if (state.state !== 'active' || def.workSeconds <= 0) continue;
    const slots = slotCountOf(def);
    const counts = runtime.itemCounts;
    for (let slot = 0; slot < slots; slot++) counts[slot] = 0;
    for (let contributor = 0; contributor < state.contributors.length; contributor++) {
      const entry = state.contributors[contributor]!;
      if (entry.pilotId === null) continue;
      if (tick - entry.lastTick > CONTRIBUTOR_TTL_TICKS) {
        entry.pilotId = null;
        continue;
      }
      if (entry.itemIndex < slots) counts[entry.itemIndex] += 1;
    }
    const cap = SHARED_WORK_KINDS.includes(def.kind) ? MAX_SHARED_RATE : 1;
    for (let slot = 0; slot < slots; slot++) {
      if (state.workDone[slot] === true) continue;
      const present = counts[slot]!;
      if (present === 0) continue;
      const rate = present < cap ? present : cap;
      const bank = state.work[slot]! + seconds * rate;
      if (bank >= def.workSeconds) {
        state.work[slot] = def.workSeconds;
        state.workDone[slot] = true;
      } else {
        state.work[slot] = bank;
      }
    }
    if (objectiveComplete(def, state)) completeObjective(runtime, index);
  }
  settleStage(runtime);
}

function objectiveResult(
  runtime: CampaignRuntime,
  index: number,
  code: ObjectiveEventCode,
  accepted: boolean,
): ObjectiveEventResult {
  const def = runtime.mission.objectives[index]!;
  const state = runtime.states[index]!;
  return {
    accepted,
    code,
    objectiveId: def.id,
    state: state.state,
    completed: state.countedCount,
    required: slotCountOf(def),
  };
}

function itemSlot(def: MissionObjective, itemId: Id | null): number {
  if (def.items.length === 0) return 0;
  return itemId === null ? -1 : def.items.indexOf(itemId);
}

function itemCounted(state: ObjectiveRuntimeState, slot: number): boolean {
  return state.counted[slot] !== null || state.workDone[slot] === true;
}

/** Contact rules: alive, in range, slow enough, in sight, and the right berth facts (B8). */
function checkObservation(def: MissionObjective, event: ObjectiveEvent): ObjectiveEventCode | null {
  if (!event.pilotAlive) return 'pilot-dead';
  if (!event.lineOfSight) return 'no-line-of-sight';
  if (def.kind === 'withdraw') return event.distanceM >= def.minDistanceM ? null : 'out-of-range';
  if (event.distanceM > def.maxDistanceM) return 'out-of-range';
  if (event.relativeSpeedMS > def.maxRelativeSpeedMS) return 'too-fast';
  const wantsDestroyed = def.kind === 'clear';
  if (wantsDestroyed === event.targetAlive) return wantsDestroyed ? 'target-alive' : 'target-lost';
  if (def.requiresBerth) {
    if (event.relativeSpeedMS >= BERTH_MAX_SPEED_MS) return 'too-fast';
    if (event.headingErrorDeg === null || Math.abs(event.headingErrorDeg) > BERTH_HEADING_TOLERANCE_DEG) return 'bad-heading';
    if (!event.berthClear) return 'berth-blocked';
    if (!event.queueVisible) return 'no-queue';
  }
  return null;
}

function upsertContributor(state: ObjectiveRuntimeState, event: ObjectiveEvent, itemIndex: number): void {
  let free = -1;
  for (let index = 0; index < state.contributors.length; index++) {
    const entry = state.contributors[index]!;
    if (entry.pilotId === event.pilotId) {
      entry.itemIndex = itemIndex;
      entry.lastTick = event.tick;
      return;
    }
    if (free < 0 && (entry.pilotId === null || event.tick - entry.lastTick > CONTRIBUTOR_TTL_TICKS)) free = index;
  }
  if (free < 0) return;
  const entry = state.contributors[free]!;
  entry.pilotId = event.pilotId;
  entry.itemIndex = itemIndex;
  entry.lastTick = event.tick;
}

/** Leaving clears the rate contribution and never the work already banked (B8). */
function clearContributor(state: ObjectiveRuntimeState, pilotId: Id | null): void {
  if (pilotId === null) return;
  for (let index = 0; index < state.contributors.length; index++) {
    const entry = state.contributors[index]!;
    if (entry.pilotId === pilotId) entry.pilotId = null;
  }
}

function registerReturn(runtime: CampaignRuntime, objectiveIndex: number, itemIndex: number, atTick: number): void {
  for (let index = 0; index < runtime.returns.length; index++) {
    const slot = runtime.returns[index]!;
    if (slot.atTick !== 0) continue;
    slot.objectiveIndex = objectiveIndex;
    slot.itemIndex = itemIndex;
    slot.atTick = atTick;
    return;
  }
}

function addBeacon(runtime: CampaignRuntime, itemId: Id): void {
  if (!runtime.beacons.includes(itemId)) runtime.beacons.push(itemId);
}

/** Mission recovery column (B8): a lost item becomes a beacon, a cell comes back, a hull is towed. */
function applyRecoveryRule(runtime: CampaignRuntime, def: MissionObjective, event: ObjectiveEvent): boolean {
  if (event.itemId === null) return false;
  const recovery = runtime.mission.transitions.recovery;
  for (let index = 0; index < recovery.length; index++) {
    const rule = recovery[index]!;
    switch (rule.kind) {
      case 'lost-item-beacon':
      case 'backup-route':
        if (rule.itemIds.includes(event.itemId)) {
          addBeacon(runtime, event.itemId);
          return true;
        }
        break;
      case 'pods-on-loss':
        if (rule.transportIds.includes(event.itemId)) {
          addBeacon(runtime, event.itemId);
          runtime.optionalBonusLost = true;
          return true;
        }
        break;
      case 'cell-return': {
        const slot = def.items.indexOf(event.itemId);
        if (slot < 0) break;
        const atTick = event.tick + rule.delaySeconds * CAMPAIGN_TICK_RATE;
        runtime.states[runtime.objectiveIndex[def.id]!]!.awayUntil[slot] = atTick;
        registerReturn(runtime, runtime.objectiveIndex[def.id]!, slot, atTick);
        return true;
      }
      case 'zero-hull-tow':
        if (rule.transportId === event.itemId) {
          runtime.tow = { transportId: event.itemId, autoTowAtTick: event.tick + rule.autoTowSeconds * CAMPAIGN_TICK_RATE, dispatched: false };
          return true;
        }
        break;
      case 'wipe-checkpoint':
        break;
    }
  }
  return false;
}

function observeContact(runtime: CampaignRuntime, index: number, def: MissionObjective, state: ObjectiveRuntimeState, event: ObjectiveEvent): ObjectiveEventResult {
  const slot = def.items.length > 0 ? itemSlot(def, event.itemId) : 0;
  if (def.items.length > 0 && slot < 0) return objectiveResult(runtime, index, 'wrong-item', false);
  if (state.awayUntil[slot] > event.tick) return objectiveResult(runtime, index, 'item-away', false);
  if (itemCounted(state, slot)) return alreadyRecovered(runtime, index, state, event);
  const rejected = checkObservation(def, event);
  if (rejected !== null) return objectiveResult(runtime, index, rejected, false);

  state.counted[slot] = event.itemId ?? def.id;
  state.countedCount++;
  if (!event.isBot) state.humanContributed = true;
  if (objectiveComplete(def, state)) completeObjective(runtime, index);
  settleStage(runtime);
  return objectiveResult(runtime, index, 'ok', true);
}

function observeWork(runtime: CampaignRuntime, index: number, def: MissionObjective, state: ObjectiveRuntimeState, event: ObjectiveEvent): ObjectiveEventResult {
  const slot = def.items.length > 0 ? itemSlot(def, event.itemId) : 0;
  if (def.items.length > 0 && slot < 0) return objectiveResult(runtime, index, 'wrong-item', false);
  if (state.awayUntil[slot] > event.tick) return objectiveResult(runtime, index, 'item-away', false);
  if (state.workDone[slot] === true) return alreadyRecovered(runtime, index, state, event);
  const rejected = checkObservation(def, event);
  if (rejected !== null) {
    clearContributor(state, event.pilotId);
    return objectiveResult(runtime, index, rejected, false);
  }
  if (event.pilotId === null) return objectiveResult(runtime, index, 'no-pilot', false);
  upsertContributor(state, event, slot);
  if (!event.isBot) state.humanContributed = true;
  return objectiveResult(runtime, index, 'ok', true);
}

/**
 * A human touching an item a bot already finished records the human contribution the completion
 * gate needs without counting the item twice: bots may do the work, never finish alone (B7).
 */
function alreadyRecovered(runtime: CampaignRuntime, index: number, state: ObjectiveRuntimeState, event: ObjectiveEvent): ObjectiveEventResult {
  if (!event.isBot) {
    state.humanContributed = true;
    const def = runtime.mission.objectives[index]!;
    if (state.state === 'active' && objectiveComplete(def, state)) {
      completeObjective(runtime, index);
      settleStage(runtime);
    }
  }
  return objectiveResult(runtime, index, 'already-recovered', false);
}

export function applyObjectiveEvent(runtime: CampaignRuntime, event: ObjectiveEvent): ObjectiveEventResult {
  const index = runtime.objectiveIndex[event.objectiveId] ?? -1;
  if (index < 0) return { accepted: false, code: 'unknown-objective', objectiveId: event.objectiveId, state: 'locked', completed: 0, required: 0 };
  const def = runtime.mission.objectives[index]!;
  const state = runtime.states[index]!;

  if (state.state === 'complete') return objectiveResult(runtime, index, 'already-complete', false);
  if (state.state === 'failed') return objectiveResult(runtime, index, 'failed', false);
  if (state.state === 'locked') return objectiveResult(runtime, index, 'locked', false);

  if (event.kind === 'depart') {
    clearContributor(state, event.pilotId);
    return objectiveResult(runtime, index, 'ok', true);
  }
  if (event.kind === 'item-lost') {
    // No authored rule means the item simply stays lost; the authority decides what the crew sees.
    return objectiveResult(runtime, index, applyRecoveryRule(runtime, def, event) ? 'recovery' : 'unrecoverable', false);
  }
  if (event.kind === 'fail') {
    state.state = 'failed';
    if (def.stage === runtime.stage) {
      runtime.outcome = 'mission-failed';
      runtime.failedObjectiveId = def.id;
    }
    return objectiveResult(runtime, index, 'failed', true);
  }
  if (def.kind === 'decision') return objectiveResult(runtime, index, 'awaiting-decision', false);
  if (event.pilotId === null) return objectiveResult(runtime, index, 'no-pilot', false);
  return def.workSeconds > 0 ? observeWork(runtime, index, def, state, event) : observeContact(runtime, index, def, state, event);
}

/** Record a decision once. A later commit for the same decision is refused, not overridden (B8). */
export function commitDecision(runtime: CampaignRuntime, decisionId: Id, optionId: Id): DecisionCommit {
  const decision = missionDecision(runtime.mission, decisionId);
  if (decision === null) return { committed: false, code: 'unknown-decision', optionId: null };
  const existing = runtime.decisions.get(decisionId);
  if (existing !== undefined) return { committed: false, code: 'already-decided', optionId: existing };
  const option = decision.options.find(candidate => candidate.id === optionId);
  if (option === undefined) return { committed: false, code: 'unknown-option', optionId: null };
  const index = runtime.objectiveIndex[decision.objectiveId] ?? -1;
  if (index < 0 || runtime.states[index]!.state !== 'active') return { committed: false, code: 'not-active', optionId: null };

  runtime.decisions.set(decisionId, optionId);
  runtime.allyId = option.allyId;
  runtime.cosmeticId = option.cosmeticId;
  runtime.states[index]!.countedCount = 1;
  completeObjective(runtime, index);
  settleStage(runtime);
  return { committed: true, code: 'ok', optionId };
}

function blankObjective(state: ObjectiveRuntimeState): void {
  state.state = 'locked';
  state.counted.fill(null);
  state.countedCount = 0;
  state.work.fill(0);
  state.workDone.fill(false);
  state.humanContributed = false;
  state.awayUntil.fill(0);
  for (let index = 0; index < state.contributors.length; index++) state.contributors[index]!.pilotId = null;
}

/**
 * Wipe recovery (B8/B7): restart the attempt at the committed stage boundary. Earlier stages stay
 * complete — those receipts are already committed and must not be farmable — while everything in
 * the current and later stages is re-attempted.
 */
export function resetToCheckpoint(runtime: CampaignRuntime): CheckpointReset {
  const cleared: Id[] = [];
  if (runtime.outcome === 'mission-complete') return { stage: runtime.stage, clearedObjectiveIds: cleared };
  for (let index = 0; index < runtime.mission.objectives.length; index++) {
    const def = runtime.mission.objectives[index]!;
    if (def.stage < runtime.stage) continue;
    blankObjective(runtime.states[index]!);
    cleared.push(def.id);
  }
  for (let index = 0; index < runtime.returns.length; index++) runtime.returns[index]!.atTick = 0;
  if (runtime.tow !== null) runtime.tow.dispatched = false;
  runtime.outcome = 'in-progress';
  runtime.failedObjectiveId = null;
  runtime.wipeCount++;
  runtime.lastWipeTick = runtime.tick;
  activateStage(runtime, runtime.stage);
  return { stage: runtime.stage, clearedObjectiveIds: cleared };
}

export function viewObjectives(runtime: CampaignRuntime): ObjectiveView[] {
  const views: ObjectiveView[] = [];
  for (let index = 0; index < runtime.mission.objectives.length; index++) {
    const def = runtime.mission.objectives[index]!;
    const state = runtime.states[index]!;
    const slots = slotCountOf(def);
    let completed: number;
    let required: number;
    if (def.workSeconds > 0) {
      required = def.workSeconds * slots;
      let banked = 0;
      for (let slot = 0; slot < slots; slot++) banked += Math.min(state.work[slot]!, def.workSeconds);
      completed = Math.min(required, Math.floor(banked));
    } else {
      required = def.items.length > 0 ? def.items.length : 1;
      completed = state.countedCount;
    }
    let marker: Vec2 | null = null;
    if (state.state === 'active') {
      let slot = 0;
      while (slot < slots - 1 && itemCounted(state, slot)) slot++;
      marker = def.anchors[Math.min(slot, def.anchors.length - 1)]!;
    }
    views.push({ id: def.id, title: def.title, state: state.state, completed, required, marker });
  }
  return views;
}
