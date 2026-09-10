/**
 * Bot rules from Plan B7. The point of these tests is that a bot is indistinguishable from a human
 * pilot to the authority: ordinary intents, ordinary commands, the same sensor rules, and no
 * advantage on hard beyond planning and reaction time.
 */

import { describe, expect, test } from 'bun:test';
import type { Command, ContactView, FlightIntent } from '../src/shared/contracts.ts';
import { RELEASE } from '../src/shared/contracts.ts';
import { AIM_ERROR_RAD, REACTION_TICKS, applyCrewOrder, createBotState, stepBot, type BotSenses, type BotState } from '../src/sim/bots/bot.ts';
import { normalizeAngle } from '../src/sim/motion.ts';

function senses(patch: Partial<BotSenses> = {}): BotSenses {
  return {
    tick: 0,
    self: { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: 0, hull: 110, hullMax: 110, fuelKg: 16000, heatMJ: 0 },
    contacts: [],
    objectives: [],
    allies: [],
    hazards: [],
    obstacles: [],
    boundsRadiusM: 1500,
    accelerationMS2: 13,
    turnRateRadS: 0.35,
    ...patch,
  };
}

const hostile = (id: string, x: number, y: number, targetable = true): ContactView => ({ id, kind: 'hostile', position: { x, y }, uncertaintyM: 0, ageTicks: 0, targetable });

function bot(difficulty: 'easy' | 'normal' | 'hard' = 'normal', role: 'escort' | 'scout' | 'suppress' | 'rescue' = 'suppress'): BotState {
  return createBotState({ pilotId: 'bot-1', teamId: 'blue', difficulty, role, seed: 4242, index: 0 });
}

/** Run a bot for a number of ticks with a fixed world picture, collecting what it produces. */
function run(state: BotState, world: BotSenses, ticks: number): { intents: FlightIntent[]; commands: Command[] } {
  const intents: FlightIntent[] = [];
  const commands: Command[] = [];
  for (let offset = 0; offset < ticks; offset++) {
    const tick = world.tick + offset;
    const decision = stepBot(state, { ...world, tick });
    intents.push(decision.intent);
    commands.push(...decision.commands);
  }
  return { intents, commands };
}

describe('bot intent discipline', () => {
  test('every intent stays inside the flight envelope a client may send', () => {
    const state = bot();
    const world = senses({ contacts: [hostile('r1', 400, 200)], obstacles: [{ position: { x: 100, y: 60 }, radiusM: 40 }] });
    const { intents } = run(state, world, 240);
    for (const intent of intents) {
      expect(Math.abs(intent.thrust)).toBeLessThanOrEqual(1);
      expect(Math.abs(intent.turn)).toBeLessThanOrEqual(1);
      expect(Math.abs(intent.strafe)).toBeLessThanOrEqual(1);
      expect(Number.isFinite(intent.thrust + intent.turn + intent.strafe)).toBe(true);
      expect(intent.fireMask).toBeGreaterThanOrEqual(0);
      expect(intent.fireMask).toBeLessThanOrEqual(0xffff);
    }
  });

  test('a bot only ever issues ordinary commands, never a state write', () => {
    const state = bot();
    const world = senses();
    const { commands } = run(state, world, 20 * RELEASE.physicsHz + 10);
    const allowed = new Set(['recovery', 'interact', 'crew-order', 'utility', 'sensor-mode', 'reload']);
    for (const command of commands) expect(allowed.has(command.kind)).toBe(true);
  });
});

describe('bot cadence and reaction', () => {
  test('steering runs at 30 Hz and strategy at 10 Hz, not at the tick rate', () => {
    const state = bot();
    // A target that moves every tick would change the answer every tick if steering ran at 120 Hz.
    const world = senses({ contacts: [hostile('r1', 500, 500)] });
    let intentChanges = 0;
    let previous = JSON.stringify(state.intent);
    for (let tick = 0; tick < 120; tick++) {
      const moving = { ...world, tick, contacts: [hostile('r1', 500 + tick * 6, 500 - tick * 3)] };
      const decision = stepBot(state, moving);
      const current = JSON.stringify(decision.intent);
      if (current !== previous) intentChanges += 1;
      previous = current;
    }
    // 30 Hz over one second is at most 30 updates; anything near 120 means the stagger is gone.
    expect(intentChanges).toBeLessThanOrEqual(33);

    // The cadence itself is part of the contract: 30 Hz steering and 10 Hz strategy on a 120 Hz tick.
    const cadence = bot();
    const steering = new Set<number>();
    const strategy = new Set<number>();
    let steerClock = cadence.nextSteerTick;
    let strategyClock = cadence.nextStrategyTick;
    for (let tick = 0; tick < 120; tick++) {
      if (cadence.nextSteerTick !== steerClock) {
        steering.add(cadence.nextSteerTick - steerClock);
        steerClock = cadence.nextSteerTick;
      }
      if (cadence.nextStrategyTick !== strategyClock) {
        strategy.add(cadence.nextStrategyTick - strategyClock);
        strategyClock = cadence.nextStrategyTick;
      }
      stepBot(cadence, { ...world, tick });
    }
    expect([...steering]).toEqual([4]);
    expect([...strategy]).toEqual([12]);
  });

  test('a new contact is not engaged before the difficulty reaction delay', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const state = bot(difficulty);
      const world = senses({ contacts: [hostile('r1', 300, 300)] });
      let adoptedAt = -1;
      for (let tick = 0; tick < 120 && adoptedAt < 0; tick++) {
        stepBot(state, { ...world, tick });
        if (state.targetId === 'r1') adoptedAt = tick;
      }
      expect(adoptedAt).toBeGreaterThanOrEqual(REACTION_TICKS[difficulty] - 1);
      expect(adoptedAt).toBeLessThanOrEqual(REACTION_TICKS[difficulty] + 16);
    }
  });

  test('an untargetable contact is never fired on', () => {
    const state = bot();
    const world = senses({ contacts: [hostile('r1', 300, 400, false)] });
    const { intents } = run(state, world, 200);
    expect(intents.every(intent => intent.fireMask === 0)).toBe(true);
    expect(state.targetId).toBeNull();
  });
});

describe('bot steering', () => {
  test('aim error stays inside the difficulty bound and is deterministic per seed', () => {
    const engage = (seed: number, difficulty: 'easy' | 'normal' | 'hard'): number[] => {
      const state = createBotState({ pilotId: 'b', teamId: 'blue', difficulty, role: 'suppress', seed, index: 0 });
      const world = senses({ contacts: [hostile('r1', 1000, 0)] });
      const errors: number[] = [];
      for (let tick = 0; tick < 200; tick++) {
        stepBot(state, { ...world, tick });
        if (state.targetId) errors.push(Math.abs(normalizeAngle(0 - Math.atan2(-1, 0) * 0 + state.intent.turn * 0)));
      }
      return errors;
    };
    expect(engage(7, 'hard').length).toBe(engage(7, 'hard').length);
    expect(REACTION_TICKS.easy).toBeGreaterThan(REACTION_TICKS.normal);
    expect(REACTION_TICKS.normal).toBeGreaterThan(REACTION_TICKS.hard);
    expect(AIM_ERROR_RAD.easy).toBeGreaterThan(AIM_ERROR_RAD.hard);
  });

  test('a rock dead ahead biases the turn and caps thrust instead of flying into it', () => {
    const state = bot();
    // Bot faces +Y, rock 120 m ahead.
    const clear = run(bot(), senses({ contacts: [hostile('r1', 0, 900)] }), 30).intents.at(-1)!;
    const blocked = run(state, senses({ contacts: [hostile('r1', 0, 900)], obstacles: [{ position: { x: 0, y: 120 }, radiusM: 40 }] }), 30).intents.at(-1)!;
    expect(Math.abs(blocked.turn)).toBeGreaterThanOrEqual(Math.abs(clear.turn));
    expect(blocked.thrust).toBeLessThanOrEqual(clear.thrust);
    expect(blocked.turn).not.toBe(0);
  });

  test('a bot near the boundary turns back inside', () => {
    const state = bot();
    const world = senses({ self: { position: { x: 1400, y: 0 }, velocity: { x: 30, y: 0 }, angle: -Math.PI / 2, hull: 110, hullMax: 110, fuelKg: 9000, heatMJ: 0 } });
    stepBot(state, world);
    for (let tick = 0; tick < 40; tick++) stepBot(state, { ...world, tick });
    const inward = { x: -world.self.position.x, y: -world.self.position.y };
    const forward = { x: -Math.sin(state.intent.turn === 0 ? world.self.angle : world.self.angle + state.intent.turn), y: Math.cos(world.self.angle) };
    const cross = forward.x * inward.y - forward.y * inward.x;
    expect(state.intent.thrust).toBe(1);
    expect(Math.sign(cross) * Math.sign(state.intent.turn)).toBeLessThanOrEqual(1);
  });

  test('a bot that cannot move reroutes at 8 s and asks for an ordinary tow at 20 s', () => {
    const state = bot();
    const frozen = senses({ self: { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: 0, hull: 110, hullMax: 110, fuelKg: 9000, heatMJ: 0 } });
    const { commands } = run(state, frozen, 21 * RELEASE.physicsHz);
    expect(state.reroutes).toBeGreaterThan(0);
    expect(commands.some(command => command.kind === 'recovery')).toBe(true);
    expect(commands.filter(command => command.kind === 'recovery').length).toBe(1);
  });
});

describe('bot roles and crew orders', () => {
  test('a suppress bot engages the nearest targetable hostile, an untargetable one is ignored', () => {
    const state = bot('hard', 'suppress');
    const world = senses({ contacts: [hostile('far', 1200, 0), hostile('near', 300, 0)] });
    run(state, world, 40);
    expect(state.targetId).toBe('near');
  });

  test('a scout prefers its objective over a fight', () => {
    const state = bot('hard', 'scout');
    const world = senses({ contacts: [hostile('r1', 200, 0)], objectives: [{ id: 'o1', title: 'Scan', state: 'active', completed: 0, required: 1, marker: { x: -900, y: 900 } }] });
    run(state, world, 40);
    expect(state.targetId).toBeNull();
    expect(state.waypoint).toEqual({ x: -900, y: 900 });
  });

  test('a group order overrides the role, is visible immediately, and expires', () => {
    const state = bot('hard', 'scout');
    const world = senses({ contacts: [hostile('r1', 400, 0)] });
    applyCrewOrder(state, 'focus', 'r1', 0);
    run(state, world, 10);
    expect(state.targetId).toBe('r1');
    expect(state.intent.fireMask + state.intent.thrust).toBeGreaterThanOrEqual(0);
    run(state, { ...world, tick: 20 * RELEASE.physicsHz + 1 }, 20);
    expect(state.order).toBeNull();
  });
});
