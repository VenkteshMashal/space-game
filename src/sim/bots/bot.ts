/**
 * Bots (Plan B7). A bot is a pilot like any other: it produces ordinary `FlightIntent` frames and
 * ordinary commands, and it never writes health, ammo or position. That is not just tidiness — it
 * means a bot cannot gain an advantage a human could not have, cannot desync the authority, and can
 * be replaced by a human mid-match without a special case.
 *
 * Cadence follows the plan: strategy at 10 Hz, steering at 30 Hz, and the intent held in between so
 * the 120 Hz authority sees exactly the same kind of input stream a client sends.
 */

import type { BotDifficulty, Command, ContactView, FlightIntent, Id, ObjectiveView, Vec2 } from '../../shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../../shared/contracts.ts';
import type { Rng } from '../../shared/rng.ts';
import { createRng } from '../../shared/rng.ts';
import { clampAxis, normalizeAngle } from '../motion.ts';

export type BotRole = 'escort' | 'scout' | 'suppress' | 'rescue';

/** Reaction delay in ticks, from the plan's 350/220/120 ms (B7). */
export const REACTION_TICKS: Readonly<Record<BotDifficulty, number>> = {
  easy: Math.round(0.35 * RELEASE.physicsHz),
  normal: Math.round(0.22 * RELEASE.physicsHz),
  hard: Math.round(0.12 * RELEASE.physicsHz),
};

/** Bounded aim error in radians; hard improves planning, never damage or accuracy omniscience. */
export const AIM_ERROR_RAD: Readonly<Record<BotDifficulty, number>> = {
  easy: 6 * Math.PI / 180,
  normal: 3 * Math.PI / 180,
  hard: 1.2 * Math.PI / 180,
};

const STRATEGY_TICKS = 12;
const STEERING_TICKS = 4;
const STUCK_REROUTE_TICKS = 8 * RELEASE.physicsHz;
const STUCK_TOW_TICKS = 20 * RELEASE.physicsHz;
const STUCK_DISTANCE_M = 5;
const ARRIVE_MARGIN_M = 60;
const CORRIDOR_STEP_M = 40;
const CORRIDOR_WIDTH_M = 26;
const ORDER_DURATION_TICKS = 20 * RELEASE.physicsHz;

export interface BotSenses {
  tick: number;
  self: { position: Vec2; velocity: Vec2; angle: number; hull: number; hullMax: number; fuelKg: number; heatMJ: number };
  /** Already filtered by the same sensor rules the player sees: never an omniscient enemy list. */
  contacts: readonly ContactView[];
  objectives: readonly ObjectiveView[];
  allies: readonly { pilotId: Id; position: Vec2; velocity: Vec2; hull: number; hullMax: number }[];
  hazards: readonly { position: Vec2; velocity: Vec2; radiusM: number }[];
  obstacles: readonly { position: Vec2; radiusM: number }[];
  boundsRadiusM: number;
  /** Full-thrust acceleration of this hull, so stopping distance is the real one. */
  accelerationMS2: number;
  turnRateRadS: number;
}

export interface BotOrder { order: 'focus' | 'defend' | 'recover' | 'regroup'; contactId: Id | null; untilTick: number }

export interface BotConfig {
  pilotId: Id;
  teamId: Id;
  difficulty: BotDifficulty;
  role: BotRole;
  seed: number;
  index: number;
}

export interface BotState {
  config: BotConfig;
  rng: Rng;
  intent: FlightIntent;
  nextStrategyTick: number;
  nextSteerTick: number;
  /** Target chosen by strategy, adopted only once the reaction delay has passed. */
  desiredTargetId: Id | null;
  desiredSinceTick: number;
  targetId: Id | null;
  waypoint: Vec2 | null;
  waypointIndex: number;
  lastPosition: Vec2;
  lastProgressTick: number;
  /** Throttles reroutes without resetting the tow clock. */
  lastRerouteTick: number;
  towRequested: boolean;
  order: BotOrder | null;
  /** Diagnostics for tests and the observer UI; never read by the authority. */
  reroutes: number;
}

export function createBotState(config: BotConfig): BotState {
  return {
    config,
    rng: createRng(config.seed, 'bot', config.index),
    intent: { ...EMPTY_FLIGHT_INTENT },
    nextStrategyTick: 0,
    nextSteerTick: 0,
    desiredTargetId: null,
    desiredSinceTick: 0,
    targetId: null,
    waypoint: null,
    waypointIndex: 0,
    lastPosition: { x: 0, y: 0 },
    lastProgressTick: 0,
    lastRerouteTick: 0,
    towRequested: false,
    order: null,
    reroutes: 0,
  };
}

export function applyCrewOrder(state: BotState, order: 'focus' | 'defend' | 'recover' | 'regroup', contactId: Id | null, tick: number): void {
  state.order = { order, contactId, untilTick: tick + ORDER_DURATION_TICKS };
  state.targetId = contactId;
  state.desiredTargetId = contactId;
  state.desiredSinceTick = tick;
}

/**
 * One simulation tick for one bot. Returns the intent the authority should apply and any ordinary
 * commands the bot issues this tick (interact, recovery, crew order). The bot never mutates anything.
 */
export function stepBot(state: BotState, senses: BotSenses): { intent: FlightIntent; commands: Command[] } {
  const commands: Command[] = [];
  if (state.order && senses.tick > state.order.untilTick) state.order = null;
  if (senses.tick >= state.nextStrategyTick) {
    state.nextStrategyTick = senses.tick + STRATEGY_TICKS;
    chooseTarget(state, senses);
  }
  if (state.desiredTargetId !== state.targetId && senses.tick - state.desiredSinceTick >= REACTION_TICKS[state.config.difficulty]) {
    state.targetId = state.desiredTargetId;
  }
  trackProgress(state, senses, commands);
  if (senses.tick >= state.nextSteerTick) {
    state.nextSteerTick = senses.tick + STEERING_TICKS;
    steer(state, senses);
  }
  return { intent: state.intent, commands };
}

function chooseTarget(state: BotState, senses: BotSenses): void {
  const order = state.order;
  if (order && order.contactId) {
    want(state, order.contactId, senses);
    return;
  }
  const hostiles = senses.contacts.filter(contact => contact.targetable && contact.kind === 'hostile');
  const objective = nextObjective(senses);
  switch (order?.order ?? state.config.role) {
    case 'regroup': {
      const anchor = nearestAlly(state, senses) ?? anchorFor(senses);
      state.waypoint = anchor ? { ...anchor } : null;
      want(state, null, senses);
      return;
    }
    case 'recover': {
      // Break off and escort the most damaged ally home.
      const wounded = [...senses.allies].sort((a, b) => a.hull / Math.max(1, a.hullMax) - b.hull / Math.max(1, b.hullMax))[0];
      state.waypoint = wounded ? { ...wounded.position } : anchorFor(senses);
      want(state, null, senses);
      return;
    }
    case 'scout':
      want(state, null, senses);
      state.waypoint = objective ? { ...objective } : anchorFor(senses);
      return;
    case 'rescue':
    case 'escort': {
      const ward = nearestAlly(state, senses);
      const threat = nearest(hostiles, senses.self.position);
      state.waypoint = ward ? { ...ward } : objective ? { ...objective } : anchorFor(senses);
      want(state, threat?.id ?? null, senses);
      return;
    }
    case 'suppress':
    default: {
      const threat = nearest(hostiles, senses.self.position);
      want(state, threat?.id ?? null, senses);
      if (!threat) state.waypoint = objective ? { ...objective } : anchorFor(senses);
      return;
    }
  }
}

function want(state: BotState, targetId: Id | null, senses: BotSenses): void {
  if (state.desiredTargetId === targetId) return;
  state.desiredTargetId = targetId;
  state.desiredSinceTick = senses.tick;
}

function nextObjective(senses: BotSenses): Vec2 | null {
  const active = senses.objectives.find(objective => objective.state === 'active' && objective.marker);
  return active?.marker ?? null;
}

function anchorFor(senses: BotSenses): Vec2 | null {
  // Nothing to do: loiter on the ring rather than parking on the boundary.
  const angle = Math.atan2(senses.self.position.y, senses.self.position.x);
  return { x: Math.cos(angle) * senses.boundsRadiusM * 0.5, y: Math.sin(angle) * senses.boundsRadiusM * 0.5 };
}

function nearest<T extends { position: Vec2 }>(items: readonly T[], from: Vec2): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const distance = Math.hypot(item.position.x - from.x, item.position.y - from.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

function nearestAlly(state: BotState, senses: BotSenses): Vec2 | null {
  const ally = nearest(senses.allies, senses.self.position);
  return ally ? ally.position : null;
}

/** Arrival at a known stopping distance, plus a swept corridor that will not fly into a rock. */
function steer(state: BotState, senses: BotSenses): void {
  const { self } = senses;
  const target = state.targetId ? senses.contacts.find(contact => contact.id === state.targetId) ?? null : null;
  const goal = target ? target.position : state.waypoint;
  const intent: FlightIntent = { ...EMPTY_FLIGHT_INTENT };
  if (!goal) {
    state.intent = intent;
    return;
  }
  const toGoal = { x: goal.x - self.position.x, y: goal.y - self.position.y };
  const distance = Math.hypot(toGoal.x, toGoal.y);
  const speed = Math.hypot(self.velocity.x, self.velocity.y);
  const stopping = (speed * speed) / Math.max(0.1, 2 * senses.accelerationMS2);
  const aimError = (state.rng.next() * 2 - 1) * AIM_ERROR_RAD[state.config.difficulty];
  const desiredAngle = Math.atan2(-(toGoal.x / Math.max(1e-6, distance)), toGoal.y / Math.max(1e-6, distance)) + aimError;
  const turnError = normalizeAngle(desiredAngle - self.angle);
  const maxTurnPerTick = Math.max(1e-4, senses.turnRateRadS / RELEASE.physicsHz);
  intent.turn = clampAxis(turnError / maxTurnPerTick);
  // Fire only at a targetable contact the sensors actually reported, and only when roughly lined up.
  if (target && Math.abs(turnError) < 0.25 && distance < 1400) {
    intent.fireMask = 1;
    intent.lockContactId = target.id;
  }
  if (distance > stopping + ARRIVE_MARGIN_M) {
    intent.thrust = Math.abs(turnError) > 2.2 ? 0 : 1;
  } else if (target) {
    // Holding a firing position beats ramming: brake rather than close inside gun range.
    intent.brake = speed > 40;
  } else if (distance < ARRIVE_MARGIN_M && speed > 20) {
    intent.brake = true;
  }
  const corridor = avoidCorridor(state, senses, { x: toGoal.x / Math.max(1e-6, distance), y: toGoal.y / Math.max(1e-6, distance) }, distance);
  if (corridor.blocked) {
    intent.turn = clampAxis(intent.turn + corridor.bias);
    intent.thrust = Math.min(intent.thrust, corridor.thrustCap);
  }
  const inward = boundaryBias(self.position, self.angle, senses.boundsRadiusM);
  if (inward !== 0) {
    intent.thrust = 1;
    intent.brake = false;
    intent.turn = clampAxis(intent.turn + inward);
  }
  state.intent = intent;
}

/** A rock in the way is steered around, not flown through; the larger the rock, the wider the bias. */
function avoidCorridor(
  state: BotState,
  senses: BotSenses,
  heading: Vec2,
  distance: number,
): { blocked: boolean; bias: number; thrustCap: number } {
  const steps = Math.max(1, Math.min(12, Math.floor(distance / CORRIDOR_STEP_M)));
  for (let step = 1; step <= steps; step++) {
    const ahead = { x: senses.self.position.x + heading.x * step * CORRIDOR_STEP_M, y: senses.self.position.y + heading.y * step * CORRIDOR_STEP_M };
    for (const obstacle of senses.obstacles) {
      const offset = Math.hypot(ahead.x - obstacle.position.x, ahead.y - obstacle.position.y);
      if (offset > obstacle.radiusM + CORRIDOR_WIDTH_M) continue;
      // Bias to whichever side the obstacle is already on, so two bots in a row do not mirror each other.
      const cross = heading.x * (obstacle.position.y - senses.self.position.y) - heading.y * (obstacle.position.x - senses.self.position.x);
      return { blocked: true, bias: cross > 0 ? -0.6 : 0.6, thrustCap: 0.6 };
    }
  }
  return { blocked: false, bias: 0, thrustCap: 1 };
}

/**
 * Steering home near the edge. The sign comes from the cross product between the current forward
 * vector and the inward vector, so a bot exactly on the diameter still turns consistently instead of
 * flipping between two 180° choices.
 */
function boundaryBias(position: Vec2, angle: number, boundsRadiusM: number): number {
  const distance = Math.hypot(position.x, position.y);
  if (distance < boundsRadiusM * 0.8) return 0;
  const forward = { x: -Math.sin(angle), y: Math.cos(angle) };
  const cross = forward.x * -position.y - forward.y * -position.x;
  return cross > 0 ? 0.8 : -0.8;
}

/** Progress, stuck-reroute at 8 s and an ordinary tow request at 20 s (B7). */
function trackProgress(state: BotState, senses: BotSenses, commands: Command[]): void {
  // Progress is measured over the whole window, not per tick: a bot flying at a steady 20 m/s moves
  // only 0.17 m per tick and is obviously not stuck.
  const travelled = Math.hypot(senses.self.position.x - state.lastPosition.x, senses.self.position.y - state.lastPosition.y);
  if (travelled > STUCK_DISTANCE_M) {
    state.lastPosition = { ...senses.self.position };
    state.lastProgressTick = senses.tick;
    state.towRequested = false;
    return;
  }
  const stalled = senses.tick - state.lastProgressTick;
  if (stalled >= STUCK_REROUTE_TICKS && senses.tick - state.lastRerouteTick >= STUCK_REROUTE_TICKS && !state.towRequested) {
    // Reroute rather than grinding against the same rock: pick a fresh waypoint on the ring. The
    // reroute has its own clock, so it cannot postpone the tow request that follows a true stall.
    state.reroutes += 1;
    state.waypointIndex += 1;
    const angle = (state.waypointIndex * 2.399) % (Math.PI * 2);
    state.waypoint = { x: Math.cos(angle) * senses.boundsRadiusM * 0.5, y: Math.sin(angle) * senses.boundsRadiusM * 0.5 };
    state.lastRerouteTick = senses.tick;
    state.targetId = null;
    state.desiredTargetId = null;
  }
  if (stalled >= STUCK_TOW_TICKS && !state.towRequested) {
    state.towRequested = true;
    commands.push({ kind: 'recovery', action: 'tow' });
  }
}
