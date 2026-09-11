import type { CampaignSource } from '../../server/room.ts';
import { advance, applyObjectiveEvent, commitDecision, createCampaignRuntime, resetToCheckpoint, viewObjectives } from './runtime.ts';
import { nextMission } from './missions.ts';

/** Shared mission adapter for LAN rooms and the offline worker. */
export function campaignSource(missionId: string, seed: number): CampaignSource {
  const runtime = createCampaignRuntime(missionId, seed, 0);
  const mission = runtime.mission;
  const observe: CampaignSource['observe'] = input => {
    const result = applyObjectiveEvent(runtime, {
      kind: 'observe', objectiveId: input.objectiveId, itemId: input.itemId,
      pilotId: input.pilotId, isBot: input.isBot, tick: input.tick, ...input.facts,
    });
    return { accepted: result.accepted, code: result.code };
  };
  return {
    viewObjectives: () => viewObjectives(runtime),
    advance: tick => { advance(runtime, tick); },
    outcome: () => runtime.outcome,
    decisions: () => [...runtime.decisions].map(([decisionId, optionId]) => ({ decisionId, optionId })),
    commitDecision: (id, option) => commitDecision(runtime, id, option),
    resetToCheckpoint: () => { resetToCheckpoint(runtime); },
    resolve: id => {
      const objective = mission.objectives.find(o => o.id === id || o.items.includes(id) || `berth:${o.id}` === id);
      return objective ? { objectiveId: objective.id, itemId: objective.items.includes(id) ? id : null } : null;
    },
    settlement: () => ({ rewardCredits: mission.rewardCredits + runtime.bonusCredits, receiptId: mission.receiptId, nextMissionId: nextMission(mission.id)?.id ?? null }),
    interact: observe, observe,
  };
}
