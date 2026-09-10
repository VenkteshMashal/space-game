/**
 * The campaign through the real room (Plan B8/C4): a seated pilot recovers the three archives M1
 * asks for, docks at the Wayfarer berth, requests extraction and settles. This is the authority path
 * end to end — room, mission entities, campaign runtime, items carried as mass, settlement — with the
 * same `CampaignSource` wiring `serve.ts` installs.
 */

import { describe, expect, test } from 'bun:test';
import { RULES } from '../src/shared/balance.ts';
import { RELEASE } from '../src/shared/contracts.ts';
import { applyObjectiveEvent, advance, commitDecision, createCampaignRuntime, resetToCheckpoint, viewObjectives } from '../src/sim/campaign/runtime.ts';
import type { ViewMeta } from '../src/shared/protocol.ts';
import { CAMPAIGN_MISSIONS, missionDefinition } from '../src/sim/campaign/missions.ts';
import { MISSION_ITEM_MASS_KG } from '../src/sim/mission.ts';
import { CAMPAIGN_START } from '../src/shared/balance.ts';
import { bodyOf, cargoMassKg, interactFacts } from '../src/sim/world.ts';
import { MemoryStore } from '../src/server/persistence/memory-store.ts';
import { Room, type CampaignSource, type InteractionFacts } from '../src/server/room.ts';
import { LOOPBACK, MemorySocket, helloRequest, makeRoom } from './helpers/room.ts';

const MISSION = CAMPAIGN_MISSIONS[0]!.id;
const PHYSICS_HZ = RELEASE.physicsHz;

/** The same adapter `serve.ts` installs: entity resolution here, every tolerance in the runtime. */
function campaignSource(): CampaignSource {
  const mission = missionDefinition(MISSION)!;
  const runtime = createCampaignRuntime(MISSION, 4242, 0);
  const entityMap = new Map<string, { objectiveId: string; itemId: string | null }>();
  for (const objective of mission.objectives) {
    entityMap.set(objective.id, { objectiveId: objective.id, itemId: null });
    for (const itemId of objective.items) entityMap.set(itemId, { objectiveId: objective.id, itemId });
    if (objective.requiresBerth) entityMap.set(`berth:${objective.id}`, { objectiveId: objective.id, itemId: null });
  }
  const evaluate = (input: { objectiveId: string; itemId: string | null; pilotId: string; isBot: boolean; tick: number; facts: InteractionFacts }) => {
    const outcome = applyObjectiveEvent(runtime, {
      objectiveId: input.objectiveId,
      kind: 'observe',
      itemId: input.itemId,
      pilotId: input.pilotId,
      isBot: input.isBot,
      tick: input.tick,
      ...input.facts,
    });
    return { accepted: outcome.accepted, code: outcome.code };
  };
  return {
    viewObjectives: () => viewObjectives(runtime),
    advance: tick => advance(runtime, tick),
    commitDecision: (decisionId, optionId) => commitDecision(runtime, decisionId, optionId),
    resetToCheckpoint: () => resetToCheckpoint(runtime),
    resolve: entityId => entityMap.get(entityId) ?? null,
    settlement: () => ({
      rewardCredits: 120,
      receiptId: mission.receiptId,
      nextMissionId: 'm2-borrowed-light',
    }),
    interact: evaluate,
    observe: evaluate,
  };
}

/** The newest view the authority sent this pilot, which is what a client renders. */
function latestMeta(socket: MemorySocket): ViewMeta {
  for (let index = socket.control.length - 1; index >= 0; index--) {
    const message = socket.control[index]!;
    if (message.t === 'meta') return message.meta;
  }
  throw new Error('no view was sent');
}

function seatedRoom(): { room: Room; socket: MemorySocket; pilotId: string } {
  const room = makeRoom({ mode: 'campaign', missionId: MISSION, seed: 4242, store: new MemoryStore(), campaignId: 'campaign-1' });
  room.attachCampaign(campaignSource());
  const socket = new MemorySocket(1);
  room.hello(socket, LOOPBACK, helloRequest('Alpha'));
  expect(room.claimOperator(socket, 'test-claim')).toBe(true);
  const pilotId = room.lobby.seats.find(seat => seat !== null)!.pilotId;
  room.command(socket, 'ready', { kind: 'ready', expectedRevision: room.lobby.revision, ready: true });
  expect(room.command(socket, 'start', { kind: 'start', expectedRevision: room.lobby.revision }).code).toBe('ok');
  room.advance(2);
  room.advance(RULES.countdownSeconds * PHYSICS_HZ + 8);
  expect(room.phase).toBe('live');
  return { room, socket, pilotId };
}

/**
 * Advance the room while keeping the connection alive, the way a real client's heartbeat does; a
 * silent socket is deliberately staled by the authority after 15 seconds (B3).
 */
function advanceAlive(room: Room, socket: MemorySocket, steps: number): void {
  for (let step = 0; step < steps; step++) {
    room.advance(1);
    if (step % (5 * PHYSICS_HZ) === 0) room.ping(socket, step, 0);
  }
}

/** Put the pilot at a point with a given heading, the way a pilot would arrive there. */
function placeAt(room: Room, pilotId: string, x: number, y: number, angle = 0): void {
  const world = room.world!;
  const pilot = world.ships.get(pilotId)!;
  const body = bodyOf(world, pilot.bodyId)!;
  body.position = { x, y };
  body.velocity = { x: 0, y: 0 };
  body.angle = angle;
  body.angularVelocity = 0;
}

describe('campaign view', () => {
  test('the host record fills the view: M1 available, the rest of the chain locked', async () => {
    const store = new MemoryStore();
    const campaign = await store.createCampaign({ id: 'campaign-1', name: 'Quiet Signal', at: new Date(0).toISOString() });
    expect(campaign.ok).toBe(true);
    const room = makeRoom({ mode: 'campaign', missionId: MISSION, seed: 4242, store, campaignId: 'campaign-1' });
    // Hydration is asynchronous by design; one turn of the microtask queue is all a memory store needs.
    await Promise.resolve();
    await Promise.resolve();
    const view = room.campaignView()!;
    expect(view.name).toBe('Quiet Signal');
    expect(view.missions).toHaveLength(6);
    expect(view.missions[0]).toMatchObject({ id: MISSION, state: 'available' });
    expect(view.missions[1]!.state).toBe('locked');
    expect(view.credits).toBe(CAMPAIGN_START.credits);
    expect(view.saveOwner).toBe('host');
  });

  test('a campaign with no record reports zeroes rather than a guess', () => {
    const room = makeRoom({ mode: 'campaign', missionId: MISSION, seed: 1, store: new MemoryStore(), campaignId: 'missing' });
    const view = room.campaignView()!;
    expect(view.credits).toBe(0);
    expect(view.inventory).toEqual([]);
  });
});

describe('campaign through the room', () => {
  test('the mission entities exist where the mission says they do', () => {
    const { room } = seatedRoom();
    const mission = missionDefinition(MISSION)!;
    const recover = mission.objectives.find(objective => objective.id === 'recover-archives')!;
    const items = [...room.world!.mission!.items.values()];
    expect(items).toHaveLength(3);
    for (const [index, item] of items.sort((a, b) => a.index - b.index).entries()) {
      expect(item.position.x).toBeCloseTo(recover.anchors[index]!.x, 6);
      expect(item.position.y).toBeCloseTo(recover.anchors[index]!.y, 6);
      expect(item.carriedBy).toBeNull();
    }
    expect(room.world!.mission!.berths[0]!.position).toEqual({ x: 0, y: -200 });
  });

  test('recovering an archive inside the tolerance carries it as mass', () => {
    const { room, socket, pilotId } = seatedRoom();
    const first = [...room.world!.mission!.items.values()].sort((a, b) => a.index - b.index)[0]!;
    placeAt(room, pilotId, first.position.x + 20, first.position.y);
    const result = room.command(socket, 'take-1', { kind: 'interact', entityId: 'recover-archives', action: 'recover' });
    expect(result.code).toBe('ok');
    expect(room.world!.mission!.items.get(first.id)!.carriedBy).toBe(pilotId);
    expect(cargoMassKg(room.world!, pilotId)).toBe(MISSION_ITEM_MASS_KG);
  });

  test('an archive out of reach, or taken too fast, is refused with the campaign own reason', () => {
    const { room, socket, pilotId } = seatedRoom();
    const first = [...room.world!.mission!.items.values()].sort((a, b) => a.index - b.index)[0]!;
    placeAt(room, pilotId, first.position.x + 400, first.position.y);
    expect(room.command(socket, 'far', { kind: 'interact', entityId: 'recover-archives', action: 'recover' }).code).toBe('denied');
    expect(room.world!.mission!.items.get(first.id)!.carriedBy).toBeNull();

    placeAt(room, pilotId, first.position.x + 10, first.position.y);
    const pilot = room.world!.ships.get(pilotId)!;
    bodyOf(room.world!, pilot.bodyId)!.velocity = { x: 60, y: 0 };
    const fast = room.command(socket, 'fast', { kind: 'interact', entityId: 'recover-archives', action: 'recover' });
    expect(fast.code).toBe('denied');
    expect(room.world!.mission!.items.get(first.id)!.carriedBy).toBeNull();
  });

  test('all three archives complete the stage and the objective reports three of three', () => {
    const { room, socket, pilotId } = seatedRoom();
    const items = [...room.world!.mission!.items.values()].sort((a, b) => a.index - b.index);
    for (const [index, item] of items.entries()) {
      placeAt(room, pilotId, item.position.x + 15, item.position.y);
      expect(room.command(socket, `take-${index}`, { kind: 'interact', entityId: 'recover-archives', action: 'recover' }).code).toBe('ok');
      room.advance(2);
    }
    const objective = latestMeta(socket).objectives.find(view => view.id === 'recover-archives')!;
    expect(objective.state).toBe('complete');
    expect(objective.completed).toBe(3);
    expect(cargoMassKg(room.world!, pilotId)).toBe(MISSION_ITEM_MASS_KG * 3);
  });

  test('docking at the berth finishes the mission and extraction settles it once with its reward', async () => {
    const { room, socket, pilotId } = seatedRoom();
    const items = [...room.world!.mission!.items.values()].sort((a, b) => a.index - b.index);
    for (const item of items) {
      placeAt(room, pilotId, item.position.x + 15, item.position.y);
      expect(room.command(socket, `take-${item.index}`, { kind: 'interact', entityId: 'recover-archives', action: 'recover' }).code).toBe('ok');
      room.advance(2);
    }
    // Fly to the Wayfarer berth, on its heading, and dock.
    placeAt(room, pilotId, 0, -180, 0);
    const dock = room.command(socket, 'dock', { kind: 'interact', entityId: 'berth:return-archives', action: 'dock' });
    expect(dock.code).toBe('ok');
    const returned = latestMeta(socket).objectives.find(view => view.id === 'return-archives')!;
    expect(returned.state).toBe('complete');

    // Extraction is a human request the captain confirms (B8), then the room settles once.
    expect(room.command(socket, 'extract', { kind: 'extraction', action: 'request' }).code).toBe('ok');
    expect(room.phase).toBe('extraction');
    room.advance(RULES.extractionSeconds * PHYSICS_HZ + 8);
    await Promise.resolve();
    const debrief = latestMeta(socket).debrief;
    expect(debrief?.outcome).toBe('mission-complete');
    expect(debrief?.rewardCredits).toBe(120);
  });

  test('a carrier lost outside the arena leaves its archive recoverable instead of deleting it', () => {
    const { room, socket, pilotId } = seatedRoom();
    const first = [...room.world!.mission!.items.values()].sort((a, b) => a.index - b.index)[0]!;
    placeAt(room, pilotId, first.position.x + 10, first.position.y);
    expect(room.command(socket, 'take', { kind: 'interact', entityId: 'recover-archives', action: 'recover' }).code).toBe('ok');
    expect(room.world!.mission!.items.get(first.id)!.carriedBy).toBe(pilotId);

    // Ignore the boundary warning for its full 15 seconds: the tug recovers the pilot, and the
    // archive it was carrying is left where it was lost rather than deleted with the ship.
    placeAt(room, pilotId, 1600, 0);
    advanceAlive(room, socket, BOUNDARY_RETURN_TICKS + 4);
    const lost = room.world!.mission!.items.get(first.id)!;
    expect(lost.carriedBy).toBeNull();
    expect(lost.lost).toBe(true);
    expect(Number.isFinite(lost.position.x) && Number.isFinite(lost.position.y)).toBe(true);

    // And it can be picked up again once the pilot redeploys, so the objective stays reachable.
    advanceAlive(room, socket, 6 * PHYSICS_HZ);
    placeAt(room, pilotId, lost.position.x + 10, lost.position.y);
    // The campaign will not count a second recovery of the same core, but the core is physically
    // back in the pilot's hands, which is what the return leg needs.
    const retry = room.command(socket, 'again', { kind: 'interact', entityId: 'recover-archives', action: 'recover' });
    expect(retry.code).toBe('ok');
    expect(room.world!.mission!.items.get(first.id)!.carriedBy).toBe(pilotId);
    expect(lost.lost).toBe(false);
    const objective = latestMeta(socket).objectives.find(view => view.id === 'recover-archives')!;
    expect(objective.completed).toBe(1);
  });
});

const BOUNDARY_RETURN_TICKS = 15 * PHYSICS_HZ;
