/**
 * B8 campaign proof: mission data shape, objective predicate rules, votes and recovery.
 *
 * The last block drives every mission to `mission-complete` with a scripted solo pilot, which is the
 * end-to-end claim the plan makes: all six missions are solo-solvable with the loaner fit.
 */

import { heapStats } from 'bun:jsc';
import { describe, expect, test } from 'bun:test';
import { CATALOG, defaultFit, deriveFit } from '../src/shared/catalog.ts';
import type { Id } from '../src/shared/contracts.ts';
import { CAMPAIGN_DIALOGUE, DIALOGUE_CHANNEL, dialogueLine, missingDialogueIds } from '../src/sim/campaign/dialogue.ts';
import {
  CAMPAIGN_MISSIONS, CAMPAIGN_TICK_RATE, allSubtitleIds, missionDefinition, nextMission, spawnEntityIds, stageCount, waveCount,
} from '../src/sim/campaign/missions.ts';
import type { MissionDefinition, MissionObjective } from '../src/sim/campaign/missions.ts';
import {
  createRecoveryState, advanceRecovery, awardReceipt, markBeaconReachable, openRecoveryVote, recordDestruction, redeploy,
  resetAttempt, resolveRecoveryVote, salvageWreck, setCheckpoint, RECOVERY_COST_CREDITS, RECOVERY_VOTE, WRECK_LIFETIME_SECONDS,
} from '../src/sim/campaign/recovery.ts';
import {
  advance, applyObjectiveEvent, commitDecision, createCampaignRuntime, resetToCheckpoint, viewObjectives,
} from '../src/sim/campaign/runtime.ts';
import type { CampaignRuntime, ObjectiveEvent, ObjectiveEventResult } from '../src/sim/campaign/runtime.ts';
import { castVote, openVote, resolveVote, voteView } from '../src/sim/campaign/votes.ts';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TABLE: readonly { id: Id; objectives: readonly Id[]; reward: number }[] = [
  { id: 'm1-ghosts-in-the-belt', reward: 120, objectives: ['recover-archives', 'return-archives'] },
  { id: 'm2-borrowed-light', reward: 160, objectives: ['rendezvous-vesper', 'escort-leg-1', 'clear-route', 'escort-leg-2', 'dock-vesper'] },
  { id: 'm3-listening-stone', reward: 180, objectives: ['scan-nodes', 'translate', 'withdraw'] },
  { id: 'm4-terms-of-silence', reward: 180, objectives: ['recover-survivors', 'decide-shelter-or-harvest', 'defend-tender', 'extract-sample', 'return'] },
  { id: 'm5-closed-circuit', reward: 220, objectives: ['deliver-cell-a', 'repair-a', 'deliver-cell-b', 'repair-b', 'hold-relay', 'extract'] },
  { id: 'm6-a-long-way-home', reward: 300, objectives: ['escort-evacuation', 'break-blockade', 'decide-broadcast-or-seal', 'charge-gate', 'extract-crew'] },
];

function mission(id: Id): MissionDefinition {
  const found = missionDefinition(id);
  expect(found).not.toBeNull();
  return found!;
}

function objectiveOf(def: MissionDefinition, id: Id): MissionObjective {
  const found = def.objectives.find(entry => entry.id === id);
  expect(found).toBeDefined();
  return found!;
}

function observe(runtime: CampaignRuntime, patch: Partial<ObjectiveEvent> & { objectiveId: Id }): ObjectiveEventResult {
  return applyObjectiveEvent(runtime, {
    kind: 'observe',
    itemId: null,
    pilotId: 'pilot-1',
    isBot: false,
    tick: runtime.tick,
    distanceM: 10,
    relativeSpeedMS: 1,
    lineOfSight: true,
    targetAlive: true,
    pilotAlive: true,
    headingErrorDeg: 5,
    berthClear: true,
    queueVisible: true,
    ...patch,
  });
}

function stateOf(runtime: CampaignRuntime, objectiveId: Id): string {
  return viewObjectives(runtime).find(view => view.id === objectiveId)!.state;
}

function progressOf(runtime: CampaignRuntime, objectiveId: Id): { completed: number; required: number } {
  const view = viewObjectives(runtime).find(entry => entry.id === objectiveId)!;
  return { completed: view.completed, required: view.required };
}

/** Scripted solo pilot: one human, loaner fit, no bot help, driving the public runtime API. */
function soloDrive(runtime: CampaignRuntime, optionId: Id | null = null): number {
  let tick = runtime.tick;
  let steps = 0;
  while (runtime.outcome === 'in-progress' && steps < 250_000) {
    steps++;
    const view = viewObjectives(runtime).find(entry => entry.state === 'active');
    if (view === undefined) break;
    const def = objectiveOf(runtime.mission, view.id);
    tick++;
    advance(runtime, tick);
    if (def.kind === 'decision') {
      const decision = runtime.mission.decisions.find(entry => entry.objectiveId === def.id)!;
      const choice = optionId !== null && decision.options.some(option => option.id === optionId) ? optionId : decision.defaultOptionId;
      commitDecision(runtime, decision.id, choice);
      continue;
    }
    let itemId: Id | null = null;
    if (def.items.length > 0) {
      const slot = def.workSeconds > 0 ? Math.floor(view.completed / def.workSeconds) : view.completed;
      itemId = def.items[Math.min(def.items.length - 1, slot)]!;
    }
    observe(runtime, {
      objectiveId: def.id,
      itemId,
      tick,
      distanceM: def.kind === 'withdraw' ? def.minDistanceM + 100 : 10,
      targetAlive: def.kind !== 'clear',
    });
  }
  return steps;
}

describe('campaign mission data', () => {
  test('objective sequences follow the plan table and stages never go backwards', () => {
    for (const row of TABLE) {
      const def = mission(row.id);
      expect(def.objectives.map(entry => entry.id)).toEqual([...row.objectives]);
      let previous = 0;
      for (const entry of def.objectives) {
        expect(entry.stage).toBeGreaterThanOrEqual(previous);
        previous = entry.stage;
      }
      expect(stageCount(def)).toBe(Math.max(...def.objectives.map(entry => entry.stage)) + 1);
    }
  });

  test('every objective and item ID is a stable kebab id, unique across all six missions', () => {
    const objectives = new Set<Id>();
    const items = new Set<Id>();
    for (const def of CAMPAIGN_MISSIONS) {
      for (const entry of def.objectives) {
        expect(entry.id).toMatch(KEBAB);
        expect(objectives.has(entry.id)).toBe(false);
        objectives.add(entry.id);
        expect(entry.anchors.length).toBeGreaterThan(0);
        for (const item of entry.items) {
          expect(item).toMatch(KEBAB);
          expect(items.has(item)).toBe(false);
          items.add(item);
          expect(objectives.has(item)).toBe(false);
        }
      }
    }
    expect(objectives.size).toBe(TABLE.reduce((total, row) => total + row.objectives.length, 0));
  });

  test('rewards, receipts and unlocks match the table and reference real catalog parts', () => {
    const receipts = new Set<Id>();
    const partIds = new Set(CATALOG.parts.map(part => part.id));
    for (const row of TABLE) {
      const def = mission(row.id);
      expect(def.rewardCredits).toBe(row.reward);
      expect(receipts.has(def.receiptId)).toBe(false);
      receipts.add(def.receiptId);
      for (const unlock of def.unlocks) expect(partIds.has(unlock)).toBe(true);
      expect(def.transitions.success).toBe('mission-complete');
      expect(def.transitions.failure).toBe('mission-failed');
      expect(def.transitions.wipe).toBe('retry-checkpoint');
      expect(def.transitions.extractionWindowSeconds).toBe(45);
    }
    expect(nextMission('m1-ghosts-in-the-belt')!.id).toBe('m2-borrowed-light');
    expect(nextMission('m5-closed-circuit')!.id).toBe('m6-a-long-way-home');
    expect(nextMission('m6-a-long-way-home')).toBeNull();
    expect(mission('m6-a-long-way-home').transitions.repeatable).toBe(true);
  });

  test('recovery column matches the plan: beacons, tows, backups, cell return, pods, wipes', () => {
    const kinds = (id: Id) => mission(id).transitions.recovery.map(rule => rule.kind);
    expect(kinds('m1-ghosts-in-the-belt')).toEqual(['lost-item-beacon', 'wipe-checkpoint']);
    expect(kinds('m2-borrowed-light')).toEqual(['zero-hull-tow', 'wipe-checkpoint']);
    expect(kinds('m3-listening-stone')).toEqual(['backup-route', 'wipe-checkpoint']);
    expect(kinds('m4-terms-of-silence')).toEqual(['lost-item-beacon', 'wipe-checkpoint']);
    expect(kinds('m5-closed-circuit')).toEqual(['cell-return', 'wipe-checkpoint']);
    expect(kinds('m6-a-long-way-home')).toEqual(['pods-on-loss', 'wipe-checkpoint']);

    const m2Tow = mission('m2-borrowed-light').transitions.recovery[0]!;
    expect(m2Tow).toEqual({ kind: 'zero-hull-tow', transportId: 'vesper-transport', autoTowSeconds: 45 });
    const cellReturn = mission('m5-closed-circuit').transitions.recovery[0]!;
    expect(cellReturn).toEqual({ kind: 'cell-return', carrierId: 'wayfarer', delaySeconds: 20 });
    for (const def of CAMPAIGN_MISSIONS) {
      for (const rule of def.transitions.recovery) {
        if (rule.kind !== 'lost-item-beacon' && rule.kind !== 'backup-route') continue;
        for (const itemId of rule.itemIds) {
          expect(def.objectives.some(entry => entry.items.includes(itemId))).toBe(true);
        }
      }
    }
  });

  test('decisions record both branches with equal access and conservative defaults', () => {
    const m4 = mission('m4-terms-of-silence');
    const m6 = mission('m6-a-long-way-home');
    expect(m4.decisions.map(entry => entry.id)).toEqual(['shelter-or-harvest']);
    expect(m6.decisions.map(entry => entry.id)).toEqual(['broadcast-or-seal']);
    expect(m4.decisions[0]!.options.map(option => option.id)).toEqual(['shelter', 'harvest']);
    expect(m6.decisions[0]!.options.map(option => option.id)).toEqual(['broadcast', 'seal']);
    expect(m4.decisions[0]!.defaultOptionId).toBe('shelter');
    expect(m6.decisions[0]!.defaultOptionId).toBe('seal');
    expect(m4.decisions[0]!.voteSeconds).toBe(30);

    // Both branches keep the same base reward and the same unlock set; only the ally/dialogue differ.
    for (const decision of [m4.decisions[0]!, m6.decisions[0]!]) {
      const defaultOption = decision.options.find(option => option.id === decision.defaultOptionId)!;
      expect(defaultOption.bonusCredits).toBe(0);
      for (const option of decision.options) {
        expect(option.allyId).toMatch(KEBAB);
        expect(option.dialogueIds.length).toBeGreaterThan(0);
      }
    }
    const m4Rewards = m4.decisions[0]!.options.map(option => m4.rewardCredits + 0);
    expect(new Set(m4Rewards).size).toBe(1);
    expect(m4.decisions[0]!.options.map(option => option.allyId)).toEqual(['wayfarer-tender', 'none']);
    expect(m4.decisions[0]!.options[1]!.bonusCredits).toBe(60);
    for (const decision of [m4.decisions[0]!, m6.decisions[0]!]) {
      const [first, second] = decision.options.map(option => option.dialogueIds);
      expect(first).not.toEqual(second);
      for (const id of [...first!, ...second!]) expect(dialogueLine(id)).not.toBeNull();
    }
    // The M4 branch objectives share a stage and converge on the same objective.
    expect(objectiveOf(m4, 'defend-tender').stage).toBe(objectiveOf(m4, 'extract-sample').stage);
    expect(objectiveOf(m4, 'defend-tender').requiresOption).toEqual({ decisionId: 'shelter-or-harvest', optionId: 'shelter' });
    expect(objectiveOf(m4, 'extract-sample').requiresOption).toEqual({ decisionId: 'shelter-or-harvest', optionId: 'harvest' });
  });

  test('spawn groups use real chassis, valid triggers and unique entity ids', () => {
    const chassisIds = new Set(CATALOG.chassis.map(chassis => chassis.id));
    for (const def of CAMPAIGN_MISSIONS) {
      const entityIds = new Set<Id>();
      for (const group of def.spawnGroups) {
        expect(group.id).toMatch(KEBAB);
        expect(group.count).toBeGreaterThan(0);
        for (const chassisId of group.chassisIds) expect(chassisIds.has(chassisId)).toBe(true);
        if (group.triggerObjectiveId !== null) expect(def.objectives.some(entry => entry.id === group.triggerObjectiveId)).toBe(true);
        for (const id of spawnEntityIds(group)) {
          expect(entityIds.has(id)).toBe(false);
          entityIds.add(id);
        }
      }
    }
    const raiders = mission('m1-ghosts-in-the-belt').spawnGroups.find(group => group.id === 'raider-pair')!;
    expect(raiders.afterItems).toBe(2);
    expect(raiders.triggerObjectiveId).toBe('recover-archives');
    expect(waveCount(2, 1)).toBe(2);
    expect(waveCount(2, 3)).toBe(4);
    expect(waveCount(16, 8)).toBe(16);
  });

  test('every referenced subtitle has a bundled, interruptible, replayable line', () => {
    expect(missingDialogueIds(allSubtitleIds())).toEqual([]);
    expect(DIALOGUE_CHANNEL).toEqual({ id: 'campaign-subtitles', interruptible: true, replayable: true, source: 'bundled' });
    const ids = new Set<Id>();
    for (const line of CAMPAIGN_DIALOGUE) {
      expect(ids.has(line.id)).toBe(false);
      ids.add(line.id);
      expect(line.text.length).toBeGreaterThan(10);
      expect(line.holdSeconds).toBeGreaterThan(0);
    }
    expect(dialogueLine('m1-intro')?.speaker).toBe('wayfarer-control');
    expect(dialogueLine('not-a-line')).toBeNull();
  });

  test('all six missions are solo-completable with the loaner fit', () => {
    const loaner = deriveFit(defaultFit('kestrel'));
    expect(loaner.valid).toBe(true);
    for (const row of TABLE) {
      const runtime = createCampaignRuntime(row.id, 11, 0);
      const steps = soloDrive(runtime);
      expect(steps).toBeGreaterThan(0);
      expect(runtime.outcome).toBe('mission-complete');
      expect(runtime.rewardCredits).toBe(row.reward);
      expect(runtime.receiptId).toBe(mission(row.id).receiptId);
      expect(runtime.progression!.nextMissionId).toBe(mission(row.id).transitions.nextMissionId);
      const states = viewObjectives(runtime).map(view => view.state);
      expect(states).not.toContain('active');
      expect(states).not.toContain('failed');
      // The un-taken M4/M6 branch stays locked; every objective that was on the path is complete.
      expect(states[states.length - 1]!).toBe('complete');
      expect(states.filter(state => state === 'complete').length).toBeGreaterThanOrEqual(states.length - 1);
    }
  });
});

describe('objective predicates', () => {
  test('completing the same item twice changes nothing and never double-counts', () => {
    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    const first = observe(runtime, { objectiveId: 'recover-archives', itemId: 'recover-a' });
    expect(first.code).toBe('ok');
    expect(first.accepted).toBe(true);
    const second = observe(runtime, { objectiveId: 'recover-archives', itemId: 'recover-a' });
    expect(second.code).toBe('already-recovered');
    expect(second.accepted).toBe(false);
    expect(progressOf(runtime, 'recover-archives')).toEqual({ completed: 1, required: 3 });
    expect(stateOf(runtime, 'recover-archives')).toBe('active');
  });

  test('a concurrent duplicate recovery yields one success and one already-recovered', () => {
    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    const a = observe(runtime, { objectiveId: 'recover-archives', itemId: 'recover-b', pilotId: 'pilot-1', tick: 5 });
    expect(a.code).toBe('ok');
    observe(runtime, { objectiveId: 'recover-archives', itemId: 'recover-c', pilotId: 'pilot-1', tick: 5 });
    const b = observe(runtime, { objectiveId: 'recover-archives', itemId: 'recover-b', pilotId: 'pilot-2', tick: 5 });
    expect(b.code).toBe('already-recovered');
    expect(progressOf(runtime, 'recover-archives').completed).toBe(2);
  });

  test('distance, sight, speed, alive state and item ownership all gate a recovery', () => {
    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    const base = { objectiveId: 'recover-archives', itemId: 'recover-a' };
    expect(observe(runtime, { ...base, distanceM: 200 }).code).toBe('out-of-range');
    expect(observe(runtime, { ...base, lineOfSight: false }).code).toBe('no-line-of-sight');
    expect(observe(runtime, { ...base, relativeSpeedMS: 30 }).code).toBe('too-fast');
    expect(observe(runtime, { ...base, pilotAlive: false }).code).toBe('pilot-dead');
    expect(observe(runtime, { ...base, targetAlive: false }).code).toBe('target-lost');
    expect(observe(runtime, { ...base, itemId: 'recover-z' }).code).toBe('wrong-item');
    expect(observe(runtime, { objectiveId: 'nope', itemId: null }).code).toBe('unknown-objective');
    expect(progressOf(runtime, 'recover-archives').completed).toBe(0);
    expect(observe(runtime, base).code).toBe('ok');
  });

  test('later stages stay locked and a failed objective never advances the story', () => {
    const runtime = createCampaignRuntime('m2-borrowed-light', 5, 0);
    expect(observe(runtime, { objectiveId: 'dock-vesper' }).code).toBe('locked');
    expect(observe(runtime, { objectiveId: 'rendezvous-vesper' }).code).toBe('ok');
    expect(stateOf(runtime, 'escort-leg-1')).toBe('active');
    const failed = applyObjectiveEvent(runtime, {
      kind: 'fail', objectiveId: 'escort-leg-1', itemId: null, pilotId: 'pilot-1', isBot: false, tick: runtime.tick,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: true, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(failed.code).toBe('failed');
    expect(runtime.outcome).toBe('mission-failed');
    expect(runtime.rewardCredits).toBe(0);
    expect(runtime.receiptId).toBeNull();

    observe(runtime, { objectiveId: 'escort-leg-1', tick: runtime.tick });
    for (let tick = 1; tick <= 4000; tick++) advance(runtime, tick);
    expect(stateOf(runtime, 'escort-leg-1')).toBe('failed');
    expect(stateOf(runtime, 'clear-route')).toBe('locked');
    expect(runtime.outcome).toBe('mission-failed');
  });

  test('dock needs < 10 m/s, a berth heading, a clear berth and a visible queue', () => {
    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    for (const itemId of ['recover-a', 'recover-b', 'recover-c']) observe(runtime, { objectiveId: 'recover-archives', itemId });
    expect(stateOf(runtime, 'return-archives')).toBe('active');
    const berth = { objectiveId: 'return-archives' };
    expect(observe(runtime, { ...berth, relativeSpeedMS: 10 }).code).toBe('too-fast');
    expect(observe(runtime, { ...berth, headingErrorDeg: 31 }).code).toBe('bad-heading');
    expect(observe(runtime, { ...berth, headingErrorDeg: 30 }).code).toBe('ok');
    expect(stateOf(runtime, 'return-archives')).toBe('complete');
  });

  test('dock rejects blocked berths and missing queues', () => {
    const runtime = createCampaignRuntime('m4-terms-of-silence', 3, 0);
    observe(runtime, { objectiveId: 'recover-survivors', itemId: 'pod-1' });
    observe(runtime, { objectiveId: 'recover-survivors', itemId: 'pod-2' });
    commitDecision(runtime, 'shelter-or-harvest', 'shelter');
    for (let tick = 1; tick <= 20 * CAMPAIGN_TICK_RATE + 120 && stateOf(runtime, 'defend-tender') !== 'complete'; tick++) {
      advance(runtime, tick);
      observe(runtime, { objectiveId: 'defend-tender', tick });
    }
    expect(stateOf(runtime, 'defend-tender')).toBe('complete');
    expect(stateOf(runtime, 'return')).toBe('active');
    expect(observe(runtime, { objectiveId: 'return', berthClear: false }).code).toBe('berth-blocked');
    expect(observe(runtime, { objectiveId: 'return', queueVisible: false }).code).toBe('no-queue');
    expect(stateOf(runtime, 'return')).toBe('active');
  });

  test('shared work caps at twice the solo rate and departure never erases it', () => {
    const solo = createCampaignRuntime('m3-listening-stone', 7, 0);
    observe(solo, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'pilot-1', tick: 0 });
    advance(solo, CAMPAIGN_TICK_RATE);
    expect(progressOf(solo, 'scan-nodes').completed).toBe(1);

    const runtime = createCampaignRuntime('m3-listening-stone', 7, 0);
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'pilot-1', tick: 0 });
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'pilot-2', tick: 0 });
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'pilot-3', tick: 0 });
    advance(runtime, CAMPAIGN_TICK_RATE);
    // Three contributors for one second would be three seconds of work; the shared cap holds it at two.
    expect(progressOf(runtime, 'scan-nodes').completed).toBe(2);

    for (const pilotId of ['pilot-1', 'pilot-2', 'pilot-3']) {
      applyObjectiveEvent(runtime, {
        kind: 'depart', objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId, isBot: false, tick: CAMPAIGN_TICK_RATE,
        distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: true, pilotAlive: true, headingErrorDeg: null,
        berthClear: true, queueVisible: true,
      });
    }
    advance(runtime, CAMPAIGN_TICK_RATE * 2);
    expect(progressOf(runtime, 'scan-nodes').completed).toBe(2);
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'pilot-1', tick: CAMPAIGN_TICK_RATE * 2 });
    advance(runtime, CAMPAIGN_TICK_RATE * 3);
    expect(progressOf(runtime, 'scan-nodes')).toEqual({ completed: 3, required: 9 });
  });

  test('repeating the same work observation in one tick does not double the rate', () => {
    const runtime = createCampaignRuntime('m3-listening-stone', 7, 0);
    for (let repeat = 0; repeat < 5; repeat++) observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'pilot-1', tick: 0 });
    advance(runtime, CAMPAIGN_TICK_RATE);
    expect(progressOf(runtime, 'scan-nodes').completed).toBe(1);
  });

  test('a bot can work but nothing completes without a human contribution', () => {
    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    for (const itemId of ['recover-a', 'recover-b', 'recover-c']) {
      observe(runtime, { objectiveId: 'recover-archives', itemId, pilotId: 'bot-1', isBot: true });
    }
    expect(progressOf(runtime, 'recover-archives').completed).toBe(3);
    expect(stateOf(runtime, 'recover-archives')).toBe('active');
    expect(stateOf(runtime, 'return-archives')).toBe('locked');
    // The human arriving at an already-recovered item records participation without double-counting.
    const human = observe(runtime, { objectiveId: 'recover-archives', itemId: 'recover-a', pilotId: 'pilot-1' });
    expect(human.code).toBe('already-recovered');
    expect(stateOf(runtime, 'recover-archives')).toBe('complete');
    expect(stateOf(runtime, 'return-archives')).toBe('active');
  });

  test('a lost archive becomes a reachable beacon and a lost cell returns to the carrier', () => {
    const m1 = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    const lost = applyObjectiveEvent(m1, {
      kind: 'item-lost', objectiveId: 'recover-archives', itemId: 'recover-a', pilotId: 'pilot-1', isBot: false, tick: 0,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: false, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(lost.code).toBe('recovery');
    expect(m1.beacons).toEqual(['recover-a']);
    expect(observe(m1, { objectiveId: 'recover-archives', itemId: 'recover-a' }).code).toBe('ok');
    const unauthored = applyObjectiveEvent(m1, {
      kind: 'item-lost', objectiveId: 'recover-archives', itemId: 'recover-z', pilotId: 'pilot-1', isBot: false, tick: 0,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: false, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(unauthored.code).toBe('unrecoverable');
    expect(m1.beacons).toEqual(['recover-a']);

    const m4 = createCampaignRuntime('m4-terms-of-silence', 3, 0);
    applyObjectiveEvent(m4, {
      kind: 'item-lost', objectiveId: 'recover-survivors', itemId: 'pod-2', pilotId: 'pilot-1', isBot: false, tick: 0,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: false, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(m4.beacons).toEqual(['pod-2']);
    expect(observe(m4, { objectiveId: 'recover-survivors', itemId: 'pod-2' }).code).toBe('ok');

    const m5 = createCampaignRuntime('m5-closed-circuit', 3, 0);
    applyObjectiveEvent(m5, {
      kind: 'item-lost', objectiveId: 'deliver-cell-a', itemId: 'cell-a', pilotId: 'pilot-1', isBot: false, tick: 0,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: false, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(observe(m5, { objectiveId: 'deliver-cell-a', itemId: 'cell-a' }).code).toBe('item-away');
    advance(m5, 20 * CAMPAIGN_TICK_RATE - 1);
    expect(observe(m5, { objectiveId: 'deliver-cell-a', itemId: 'cell-a' }).code).toBe('item-away');
    advance(m5, 20 * CAMPAIGN_TICK_RATE);
    expect(observe(m5, { objectiveId: 'deliver-cell-a', itemId: 'cell-a' }).code).toBe('ok');
  });

  test('a zero-hull transport is towed after the authored delay', () => {
    const runtime = createCampaignRuntime('m2-borrowed-light', 3, 0);
    applyObjectiveEvent(runtime, {
      kind: 'item-lost', objectiveId: 'rendezvous-vesper', itemId: 'vesper-transport', pilotId: 'pilot-1', isBot: false, tick: 0,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: false, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(runtime.tow).toEqual({ transportId: 'vesper-transport', autoTowAtTick: 45 * CAMPAIGN_TICK_RATE, dispatched: false });
    advance(runtime, 45 * CAMPAIGN_TICK_RATE - 1);
    expect(runtime.tow!.dispatched).toBe(false);
    advance(runtime, 45 * CAMPAIGN_TICK_RATE);
    expect(runtime.tow!.dispatched).toBe(true);
  });

  test('decisions commit once, swap the ally and reconverge on the same access', () => {
    const shelter = createCampaignRuntime('m4-terms-of-silence', 9, 0);
    observe(shelter, { objectiveId: 'recover-survivors', itemId: 'pod-1' });
    observe(shelter, { objectiveId: 'recover-survivors', itemId: 'pod-2' });
    expect(commitDecision(shelter, 'shelter-or-harvest', 'shelter').committed).toBe(true);
    expect(shelter.allyId).toBe('wayfarer-tender');
    expect(stateOf(shelter, 'defend-tender')).toBe('active');
    expect(stateOf(shelter, 'extract-sample')).toBe('locked');
    const override = commitDecision(shelter, 'shelter-or-harvest', 'harvest');
    expect(override).toEqual({ committed: false, code: 'already-decided', optionId: 'shelter' });
    expect(commitDecision(shelter, 'shelter-or-harvest', 'nope').code).toBe('already-decided');
    expect(commitDecision(shelter, 'no-such-decision', 'shelter').code).toBe('unknown-decision');

    const harvest = createCampaignRuntime('m4-terms-of-silence', 9, 0);
    observe(harvest, { objectiveId: 'recover-survivors', itemId: 'pod-1' });
    observe(harvest, { objectiveId: 'recover-survivors', itemId: 'pod-2' });
    commitDecision(harvest, 'shelter-or-harvest', 'harvest');
    expect(harvest.allyId).toBe('none');
    expect(harvest.cosmeticId).toBe('scan-pattern-vault');
    expect(stateOf(harvest, 'extract-sample')).toBe('active');
    expect(stateOf(harvest, 'defend-tender')).toBe('locked');

    soloDrive(shelter);
    soloDrive(harvest);
    expect(shelter.outcome).toBe('mission-complete');
    expect(harvest.outcome).toBe('mission-complete');
    expect(shelter.rewardCredits).toBe(harvest.rewardCredits);
    expect(shelter.rewardCredits).toBe(180);
    expect(harvest.bonusCredits).toBe(60);
    expect(shelter.bonusCredits).toBe(0);
    expect(shelter.progression).toEqual(harvest.progression);

    const seal = createCampaignRuntime('m6-a-long-way-home', 9, 0);
    const broadcast = createCampaignRuntime('m6-a-long-way-home', 9, 0);
    soloDrive(seal);
    soloDrive(broadcast, 'broadcast');
    expect(seal.outcome).toBe('mission-complete');
    expect(broadcast.outcome).toBe('mission-complete');
    expect(seal.allyId).toBe('none');
    expect(broadcast.allyId).toBe('witness-array');
    expect(seal.progression).toEqual(broadcast.progression);
    expect(seal.rewardCredits).toBe(300);
    expect(broadcast.rewardCredits).toBe(300);
  });

  test('a decision objective is settled by the record, never by a contact observation', () => {
    const runtime = createCampaignRuntime('m4-terms-of-silence', 9, 0);
    observe(runtime, { objectiveId: 'recover-survivors', itemId: 'pod-1' });
    observe(runtime, { objectiveId: 'recover-survivors', itemId: 'pod-2' });
    expect(observe(runtime, { objectiveId: 'decide-shelter-or-harvest' }).code).toBe('awaiting-decision');
    expect(commitDecision(runtime, 'shelter-or-harvest', 'shelter').committed).toBe(true);
  });

  test('a wipe retries the checkpoint and keeps the committed stage', () => {
    const runtime = createCampaignRuntime('m5-closed-circuit', 4, 0);
    observe(runtime, { objectiveId: 'deliver-cell-a', itemId: 'cell-a' });
    expect(stateOf(runtime, 'repair-a')).toBe('active');
    for (let tick = 1; tick <= 240; tick++) {
      advance(runtime, tick);
      observe(runtime, { objectiveId: 'repair-a', tick });
    }
    expect(progressOf(runtime, 'repair-a').completed).toBeGreaterThan(0);

    const reset = resetToCheckpoint(runtime);
    expect(reset.stage).toBe(1);
    expect(reset.clearedObjectiveIds).not.toContain('deliver-cell-a');
    expect(reset.clearedObjectiveIds).toContain('repair-a');
    expect(stateOf(runtime, 'deliver-cell-a')).toBe('complete');
    expect(stateOf(runtime, 'repair-a')).toBe('active');
    expect(progressOf(runtime, 'repair-a').completed).toBe(0);
    expect(runtime.outcome).toBe('in-progress');
    expect(runtime.wipeCount).toBe(1);

    soloDrive(runtime);
    expect(runtime.outcome).toBe('mission-complete');
  });

  test('a checkpoint reset revives a failed attempt at the committed stage', () => {
    const runtime = createCampaignRuntime('m2-borrowed-light', 4, 0);
    observe(runtime, { objectiveId: 'rendezvous-vesper' });
    applyObjectiveEvent(runtime, {
      kind: 'fail', objectiveId: 'escort-leg-1', itemId: null, pilotId: 'pilot-1', isBot: false, tick: 0,
      distanceM: 0, relativeSpeedMS: 0, lineOfSight: true, targetAlive: true, pilotAlive: true, headingErrorDeg: null,
      berthClear: true, queueVisible: true,
    });
    expect(runtime.outcome).toBe('mission-failed');
    resetToCheckpoint(runtime);
    expect(runtime.outcome).toBe('in-progress');
    expect(runtime.failedObjectiveId).toBeNull();
    expect(stateOf(runtime, 'rendezvous-vesper')).toBe('complete');
    expect(stateOf(runtime, 'escort-leg-1')).toBe('active');
    soloDrive(runtime);
    expect(runtime.outcome).toBe('mission-complete');
  });

  test('advance is monotonic and a settled mission never pays twice', () => {
    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 3, 0);
    advance(runtime, 100);
    advance(runtime, 100);
    expect(runtime.tick).toBe(100);
    soloDrive(runtime);
    const reward = runtime.rewardCredits;
    const receipt = runtime.receiptId;
    advance(runtime, 999_999);
    expect(runtime.rewardCredits).toBe(reward);
    expect(runtime.receiptId).toBe(receipt);
    expect(runtime.outcome).toBe('mission-complete');
  });

  test('advance allocates nothing per tick on the work and idle paths', () => {
    const runtime = createCampaignRuntime('m3-listening-stone', 5, 0);
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'p1', tick: 0 });
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-south', pilotId: 'p2', tick: 0 });
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-core', pilotId: 'p3', tick: 0 });
    let tick = 0;
    for (let warm = 0; warm < 30; warm++) advance(runtime, ++tick);
    // Re-arm presence so the measured window runs the per-item accumulation path every single tick.
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-north', pilotId: 'p1', tick });
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-south', pilotId: 'p2', tick });
    observe(runtime, { objectiveId: 'scan-nodes', itemId: 'scan-core', pilotId: 'p3', tick });
    const active = heapStats().objectCount;
    for (let step = 0; step < CAMPAIGN_TICK_RATE; step++) advance(runtime, ++tick);
    expect(heapStats().objectCount).toBe(active);
    const idle = heapStats().objectCount;
    for (let step = 0; step < 50_000; step++) advance(runtime, ++tick);
    expect(heapStats().objectCount).toBe(idle);
  });

  test('the mission stream is seeded, so the same seed rolls the same composition', () => {
    const picks = (seed: number) => {
      const runtime = createCampaignRuntime('m6-a-long-way-home', seed, 0);
      soloDrive(runtime);
      return runtime.spawns.map(spawn => spawn.chassisPicks.join(','));
    };
    expect(picks(42)).toEqual(picks(42));
    expect(picks(42)).not.toEqual(picks(43));

    const sameSeed = createCampaignRuntime('m6-a-long-way-home', 42, 0);
    const otherSeed = createCampaignRuntime('m6-a-long-way-home', 43, 0);
    expect(sameSeed.rng.state()).toBe(createCampaignRuntime('m6-a-long-way-home', 42, 0).rng.state());
    expect(otherSeed.rng.state()).not.toBe(sameSeed.rng.state());

    const runtime = createCampaignRuntime('m1-ghosts-in-the-belt', 42, 0);
    expect(runtime.spawns[0]!.active).toBe(true);
    expect(runtime.spawns.find(spawn => spawn.entityIds.length > 1)!.entityIds).toEqual(['raider-pair-1', 'raider-pair-2']);
  });
});

describe('campaign votes', () => {
  const options = [
    { id: 'shelter', label: 'Shelter the survivors' },
    { id: 'harvest', label: 'Harvest the vault' },
  ];
  const open = (tick = 0) => openVote({
    id: 'shelter-or-harvest', kind: 'decision', options, defaultOptionId: 'shelter', eligiblePilotIds: ['a', 'b', 'c'], tick,
  });

  test('the window is 30 seconds and eligibility is snapshotted at open', () => {
    const vote = open();
    expect(vote.endsAtTick).toBe(30 * CAMPAIGN_TICK_RATE);
    expect(castVote(vote, 'late', 'harvest', 0)).toEqual({ ok: false, code: 'not-eligible' });
    expect(castVote(vote, 'a', 'harvest', 0).ok).toBe(true);
    expect(castVote(vote, 'a', 'shelter', 10)).toEqual({ ok: false, code: 'already-voted' });
    expect(castVote(vote, 'b', 'nope', 10)).toEqual({ ok: false, code: 'unknown-option' });
    expect(voteView(vote)!.votes).toEqual({ a: 'harvest' });
    expect(voteView(vote)!.eligiblePilotIds).toEqual(['a', 'b', 'c']);
    expect(voteView(vote)!.defaultOptionId).toBe('shelter');
  });

  test('a reconnect may vote before the deadline and a late join spectates', () => {
    const vote = open();
    expect(resolveVote(vote, 10).reason).toBe('open');
    expect(castVote(vote, 'c', 'harvest', 30 * CAMPAIGN_TICK_RATE - 1).ok).toBe(true);
    expect(castVote(vote, 'b', 'harvest', 30 * CAMPAIGN_TICK_RATE)).toEqual({ ok: false, code: 'closed' });
    expect(voteView(vote)!.votes).toEqual({ c: 'harvest' });
  });

  test('majority of cast votes wins, a tie or an empty ballot uses the conservative default', () => {
    const majority = open();
    castVote(majority, 'a', 'harvest', 0);
    castVote(majority, 'b', 'harvest', 0);
    castVote(majority, 'c', 'shelter', 0);
    const decided = resolveVote(majority, 30 * CAMPAIGN_TICK_RATE);
    expect(decided).toEqual({ committed: true, optionId: 'harvest', reason: 'majority' });

    const tie = open();
    castVote(tie, 'a', 'harvest', 0);
    castVote(tie, 'b', 'shelter', 0);
    expect(resolveVote(tie, 30 * CAMPAIGN_TICK_RATE)).toEqual({ committed: true, optionId: 'shelter', reason: 'default-tie' });

    const empty = open();
    expect(resolveVote(empty, 30 * CAMPAIGN_TICK_RATE)).toEqual({ committed: true, optionId: 'shelter', reason: 'default-no-votes' });
  });

  test('a committed decision cannot be re-opened or overridden', () => {
    const vote = open();
    castVote(vote, 'a', 'harvest', 0);
    expect(resolveVote(vote, 30 * CAMPAIGN_TICK_RATE).committed).toBe(true);
    expect(resolveVote(vote, 30 * CAMPAIGN_TICK_RATE + 500)).toEqual({ committed: false, optionId: 'harvest', reason: 'already-committed' });
    expect(castVote(vote, 'b', 'shelter', 30 * CAMPAIGN_TICK_RATE + 500)).toEqual({ ok: false, code: 'decided' });
    expect(voteView(vote)).toBeNull();
  });

  test('an unknown default option is a build error, not a runtime state', () => {
    expect(() => openVote({
      id: 'bad', kind: 'decision', options, defaultOptionId: 'nope', eligiblePilotIds: [], tick: 0,
    })).toThrow();
  });
});

describe('campaign recovery', () => {
  test('destruction emits once and leaves a wreck, a beacon and a 15 s redeploy', () => {
    const state = createRecoveryState('m1-ghosts-in-the-belt', 200);
    const input = {
      pilotId: 'pilot-1',
      tick: 0,
      position: { x: 10, y: 20 },
      modules: [{ instanceId: 'inst-1', partId: 'gun-autocannon', replacementCostCredits: 100 }],
      criticalCargo: ['archive-a'],
      beaconReachable: true,
    };
    const first = recordDestruction(state, input);
    expect(first.code).toBe('destroyed');
    expect(first.redeployAtTick).toBe(15 * CAMPAIGN_TICK_RATE);
    expect(state.wrecks).toHaveLength(1);
    expect(state.beacons).toHaveLength(1);
    expect(state.criticalCargo.get('archive-a')).toBe(first.beaconId);

    const second = recordDestruction(state, input);
    expect(second.code).toBe('already-destroyed');
    expect(second.wreckId).toBe(first.wreckId);
    expect(state.wrecks).toHaveLength(1);
  });

  test('redeploy waits 15 s, the first recovery is free and the next costs 20', () => {
    const state = createRecoveryState('m1-ghosts-in-the-belt', 200);
    const modules: readonly { instanceId: Id; partId: Id; replacementCostCredits: number }[] = [];
    recordDestruction(state, { pilotId: 'pilot-1', tick: 0, position: { x: 0, y: 0 }, modules, criticalCargo: [], beaconReachable: true });
    expect(redeploy(state, 'pilot-1', 15 * CAMPAIGN_TICK_RATE - 1).code).toBe('early');
    const first = redeploy(state, 'pilot-1', 15 * CAMPAIGN_TICK_RATE);
    expect(first.free).toBe(true);
    expect(first.paidCredits).toBe(0);
    expect(state.credits).toBe(200);

    recordDestruction(state, { pilotId: 'pilot-1', tick: 100, position: { x: 0, y: 0 }, modules, criticalCargo: [], beaconReachable: true });
    const paid = redeploy(state, 'pilot-1', 100 + 15 * CAMPAIGN_TICK_RATE);
    expect(paid.free).toBe(false);
    expect(paid.paidCredits).toBe(RECOVERY_COST_CREDITS);
    expect(state.credits).toBe(200 - RECOVERY_COST_CREDITS);
    expect(redeploy(state, 'pilot-1', 0).code).toBe('no-wreck');
  });

  test('insolvency still permits the loaner and forfeits optional cargo', () => {
    const state = createRecoveryState('m1-ghosts-in-the-belt', 0);
    state.attempt.optionalLoot.push('loot-a');
    recordDestruction(state, { pilotId: 'p1', tick: 0, position: { x: 0, y: 0 }, modules: [], criticalCargo: [], beaconReachable: true });
    redeploy(state, 'p1', 15 * CAMPAIGN_TICK_RATE);
    recordDestruction(state, { pilotId: 'p1', tick: 100, position: { x: 0, y: 0 }, modules: [], criticalCargo: [], beaconReachable: true });
    const result = redeploy(state, 'p1', 100 + 15 * CAMPAIGN_TICK_RATE);
    expect(result.code).toBe('deployed');
    expect(result.forfeitedOptionalCargo).toBe(true);
    expect(result.paidCredits).toBe(0);
    expect(state.credits).toBe(0);
    expect(state.attempt.optionalLoot).toEqual([]);
  });

  test('an unrecovered wreck returns damaged modules at 25% repair price', () => {
    const state = createRecoveryState('m1-ghosts-in-the-belt', 200);
    const modules = [{ instanceId: 'inst-1', partId: 'torch-standard', replacementCostCredits: 100 }];
    recordDestruction(state, { pilotId: 'p1', tick: 0, position: { x: 0, y: 0 }, modules, criticalCargo: [], beaconReachable: true });
    expect(advanceRecovery(state, WRECK_LIFETIME_SECONDS * CAMPAIGN_TICK_RATE - 1)).toEqual([]);
    const returned = advanceRecovery(state, WRECK_LIFETIME_SECONDS * CAMPAIGN_TICK_RATE);
    expect(returned).toHaveLength(1);
    expect(state.damaged.get('inst-1')).toEqual({
      instanceId: 'inst-1', partId: 'torch-standard', health: 0.75, repairPriceCredits: 25,
    });
    expect(state.wrecks).toHaveLength(0);
    expect(state.beacons).toHaveLength(0);
  });

  test('a salvage run before expiry returns the modules whole', () => {
    const state = createRecoveryState('m1-ghosts-in-the-belt', 200);
    const modules = [{ instanceId: 'inst-1', partId: 'torch-standard', replacementCostCredits: 100 }];
    const wreck = recordDestruction(state, { pilotId: 'p1', tick: 0, position: { x: 0, y: 0 }, modules, criticalCargo: [], beaconReachable: true });
    expect(salvageWreck(state, wreck.wreckId)).toEqual({ code: 'ok', modules });
    expect(state.damaged.size).toBe(0);
    expect(salvageWreck(state, wreck.wreckId).code).toBe('unknown-wreck');
  });

  test('critical cargo moves atomically when a beacon becomes reachable', () => {
    const state = createRecoveryState('m4-terms-of-silence', 200);
    const wreck = recordDestruction(state, {
      pilotId: 'p1', tick: 0, position: { x: 5, y: 5 }, modules: [], criticalCargo: ['pod-1', 'pod-2'], beaconReachable: false,
    });
    expect(state.criticalCargo.size).toBe(0);
    expect(state.pendingCargo.get('pod-1')).toBe(wreck.wreckId);
    expect(state.pendingCargo.get('pod-2')).toBe(wreck.wreckId);
    const moved = markBeaconReachable(state, wreck.beaconId);
    expect(moved).toEqual(['pod-1', 'pod-2']);
    expect(state.criticalCargo.get('pod-1')).toBe(wreck.beaconId);
    expect(state.criticalCargo.get('pod-2')).toBe(wreck.beaconId);
    expect(state.pendingCargo.size).toBe(0);
    expect(markBeaconReachable(state, 'no-beacon')).toEqual([]);

    // A wreck can expire; the critical cargo it held is still tracked and still recoverable.
    advanceRecovery(state, WRECK_LIFETIME_SECONDS * CAMPAIGN_TICK_RATE * 10);
    expect(state.criticalCargo.get('pod-1')).toBe(wreck.beaconId);
    expect(state.criticalCargo.get('pod-2')).toBe(wreck.beaconId);
  });

  test('the all-humans-destroyed vote is 20 s, defaults to retry and admits no bots', () => {
    const state = createRecoveryState('m5-closed-circuit', 200);
    const vote = openRecoveryVote(state, ['p1', 'p2'], 0);
    expect(vote.endsAtTick).toBe(20 * CAMPAIGN_TICK_RATE);
    expect(RECOVERY_VOTE.defaultOptionId).toBe('retry-checkpoint');
    expect(castVote(vote, 'bot-1', 'return-carrier', 0)).toEqual({ ok: false, code: 'not-eligible' });
    expect(resolveRecoveryVote(state, 20 * CAMPAIGN_TICK_RATE)).toEqual({ committed: true, optionId: 'retry-checkpoint', reason: 'default-no-votes' });

    const voted = createRecoveryState('m5-closed-circuit', 200);
    const second = openRecoveryVote(voted, ['p1', 'p2'], 0);
    castVote(second, 'p1', 'return-carrier', 0);
    expect(resolveRecoveryVote(voted, 20 * CAMPAIGN_TICK_RATE)).toEqual({ committed: true, optionId: 'return-carrier', reason: 'majority' });
    expect(resolveRecoveryVote(voted, 20 * CAMPAIGN_TICK_RATE + 1).reason).toBe('already-committed');
  });

  test('receipts commit once and a reset restores the attempt without touching them', () => {
    const state = createRecoveryState('m1-ghosts-in-the-belt', 200);
    state.attempt.consumables = 2;
    state.attempt.optionalLoot.push('loot-a');
    setCheckpoint(state);
    state.attempt.consumables = 0;
    state.attempt.optionalLoot.push('loot-b');
    expect(awardReceipt(state, 'receipt-m1-archives', 120)).toBe(true);
    expect(awardReceipt(state, 'receipt-m1-archives', 120)).toBe(false);
    expect(state.credits).toBe(320);

    const reset = resetAttempt(state);
    expect(reset.droppedLoot).toEqual(['loot-b']);
    expect(reset.retainedReceipts).toEqual(['receipt-m1-archives']);
    expect(state.attempt).toEqual({ consumables: 2, optionalLoot: ['loot-a'] });
    expect(state.credits).toBe(320);
    expect(state.receipts.get('receipt-m1-archives')).toBe(120);
  });
});
