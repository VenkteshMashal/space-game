/**
 * Authority lobby (Plan B1). Readiness is tied to a revision: a rule edit (mode, map, mission, join
 * policy, bot fill) revokes everyone's readiness, and a pilot's own fit or team change revokes only
 * theirs. Joins and departures change the roster and the blockers without silently un-readying
 * pilots who did nothing — the old lobby dropped updates or kept stale readiness, both of which
 * this replaces.
 */

import { PVP } from '../shared/balance.ts';
import { defaultFit, deriveFit } from '../shared/catalog.ts';
import type { BotDifficulty, CommandCode, Fit, Id, Life, LobbyView, Mode, Presence, RosterEntry } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import { PVP_TEAMS, TEAM_BLUE, TEAM_CREW, TEAM_RED } from '../shared/teams.ts';
import { validateFit } from '../shared/validate.ts';

export interface LobbySeat {
  seat: number;
  pilotId: Id;
  name: string;
  teamId: Id;
  isBot: boolean;
  presence: Presence;
  life: Life;
  readyAtRevision: number | null;
  /** Revision at which this pilot's own fit or team last changed. */
  ownRevision: number;
  fit: Fit;
  pingMs: number | null;
  connectionGeneration: number;
  difficulty: BotDifficulty | null;
}

export interface LobbyState {
  revision: number;
  /** Bumped only by rule edits, so unrelated roster churn never revokes readiness. */
  rulesRevision: number;
  captainId: Id;
  mode: Mode;
  mapId: Id;
  missionId: Id | null;
  joinPolicy: 'open' | 'code' | 'closed';
  roomCode: string | null;
  seats: (LobbySeat | null)[];
  botFill: { total: number; difficulty: BotDifficulty } | null;
}

export interface LobbyResult { ok: boolean; code: CommandCode; message?: string }

const ok: LobbyResult = { ok: true, code: 'ok' };

export function createLobby(input: {
  captainId: Id;
  name: string;
  mode: Mode;
  mapId: Id;
  missionId?: Id | null;
  joinPolicy?: 'open' | 'code' | 'closed';
  roomCode?: string | null;
  seatCount?: number;
}): LobbyState {
  const state: LobbyState = {
    revision: 1,
    rulesRevision: 1,
    captainId: input.captainId,
    mode: input.mode,
    mapId: input.mapId,
    missionId: input.missionId ?? null,
    joinPolicy: input.joinPolicy ?? 'open',
    roomCode: input.roomCode ?? null,
    seats: new Array(input.seatCount ?? RELEASE.maxHumans).fill(null),
    botFill: null,
  };
  state.seats[0] = {
    seat: 0,
    pilotId: input.captainId,
    name: input.name,
    teamId: teamForMode(input.mode, 0),
    isBot: false,
    presence: 'connected',
    life: 'staged',
    readyAtRevision: null,
    ownRevision: 1,
    fit: defaultFit('kestrel'),
    pingMs: null,
    connectionGeneration: 1,
    difficulty: null,
  };
  return state;
}

function teamForMode(mode: Mode, seat: number): Id {
  if (mode === 'team-deathmatch') return seat % 2 === 0 ? TEAM_BLUE : TEAM_RED;
  return TEAM_CREW;
}

export function seatIndex(state: LobbyState, pilotId: Id): number {
  return state.seats.findIndex(seat => seat?.pilotId === pilotId);
}

export function seatFor(state: LobbyState, pilotId: Id): LobbySeat | null {
  const index = seatIndex(state, pilotId);
  return index >= 0 ? state.seats[index]! : null;
}

export function humanCount(state: LobbyState): number {
  return state.seats.filter(seat => seat && !seat.isBot).length;
}

export function connectedHumans(state: LobbyState): LobbySeat[] {
  return state.seats.filter((seat): seat is LobbySeat => Boolean(seat) && !seat!.isBot && seat!.presence !== 'left');
}

function bumpRules(state: LobbyState): void {
  state.revision += 1;
  state.rulesRevision = state.revision;
}

export function join(state: LobbyState, input: { pilotId: Id; name: string; generation: number; teamId?: Id }): LobbyResult {
  if (state.joinPolicy === 'closed') return { ok: false, code: 'join-closed' };
  if (seatIndex(state, input.pilotId) >= 0) return { ok: false, code: 'seat-taken' };
  const index = state.seats.findIndex(seat => seat === null);
  if (index < 0 || humanCount(state) >= RELEASE.maxHumans) return { ok: false, code: 'room-full' };
  state.revision += 1;
  state.seats[index] = {
    seat: index,
    pilotId: input.pilotId,
    name: input.name,
    teamId: input.teamId ?? teamForMode(state.mode, index),
    isBot: false,
    presence: 'connected',
    life: 'staged',
    readyAtRevision: null,
    ownRevision: state.revision,
    fit: defaultFit(index % 2 === 0 ? 'kestrel' : 'needle'),
    pingMs: null,
    connectionGeneration: input.generation,
    difficulty: null,
  };
  return ok;
}

/** Presence and ping never bump the revision: they are not consent to anything. */
export function notePresence(state: LobbyState, pilotId: Id, presence: Presence): void {
  const seat = seatFor(state, pilotId);
  if (!seat || seat.presence === presence) return;
  seat.presence = presence;
  if (presence === 'reconnecting' || presence === 'away') seat.readyAtRevision = null;
}

export function notePing(state: LobbyState, pilotId: Id, pingMs: number | null): void {
  const seat = seatFor(state, pilotId);
  if (seat) seat.pingMs = pingMs;
}

export function noteLife(state: LobbyState, pilotId: Id, life: Life): void {
  const seat = seatFor(state, pilotId);
  if (seat) seat.life = life;
}

export function leave(state: LobbyState, pilotId: Id): void {
  const index = seatIndex(state, pilotId);
  if (index < 0) return;
  state.seats[index] = null;
  state.revision += 1;
  if (state.captainId === pilotId) {
    const next = connectedHumans(state)[0];
    if (next) state.captainId = next.pilotId;
  }
}

export function setPilot(
  state: LobbyState,
  pilotId: Id,
  patch: { name?: string; teamId?: Id; fit?: Fit },
): LobbyResult {
  const seat = seatFor(state, pilotId);
  if (!seat) return { ok: false, code: 'denied', message: 'not seated' };
  if (patch.fit) {
    const structural = validateFit(patch.fit);
    if (!structural.ok) return { ok: false, code: 'invalid-fit', message: `${structural.code}:${structural.detail}` };
    const derived = deriveFit(structural.value);
    if (!derived.valid) return { ok: false, code: 'invalid-fit', message: derived.errors.join(',') };
  }
  if (patch.teamId && state.mode === 'team-deathmatch') {
    if (!PVP_TEAMS.includes(patch.teamId)) return { ok: false, code: 'denied', message: 'unknown team' };
    const target = state.seats.filter(candidate => candidate?.teamId === patch.teamId).length;
    if (target >= PVP.maxPerTeam && patch.teamId !== seat.teamId) return { ok: false, code: 'denied', message: 'team full' };
  }
  state.revision += 1;
  seat.ownRevision = state.revision;
  // Any edit to this pilot's own ship or side voids their previous readiness, visibly.
  seat.readyAtRevision = null;
  if (patch.name !== undefined) seat.name = patch.name;
  if (patch.teamId !== undefined) seat.teamId = patch.teamId;
  if (patch.fit !== undefined) seat.fit = patch.fit;
  return ok;
}

const RULES_MAX_PER_TEAM = 4;

export function setReady(state: LobbyState, pilotId: Id, ready: boolean): LobbyResult {
  const seat = seatFor(state, pilotId);
  if (!seat) return { ok: false, code: 'denied', message: 'not seated' };
  seat.readyAtRevision = ready ? state.revision : null;
  return ok;
}

export function editLobby(
  state: LobbyState,
  pilotId: Id,
  patch: { mode?: Mode; mapId?: Id; missionId?: Id; joinPolicy?: 'open' | 'code' | 'closed' },
): LobbyResult {
  if (state.captainId !== pilotId) return { ok: false, code: 'not-captain' };
  bumpRules(state);
  if (patch.mode && patch.mode !== state.mode) {
    state.mode = patch.mode;
    for (const seat of state.seats) if (seat && !seat.isBot) seat.teamId = teamForMode(patch.mode, seat.seat);
  }
  if (patch.mapId) state.mapId = patch.mapId;
  if (patch.missionId !== undefined) state.missionId = patch.missionId;
  if (patch.joinPolicy) state.joinPolicy = patch.joinPolicy;
  return ok;
}

export function setBotFill(state: LobbyState, pilotId: Id, total: number, difficulty: BotDifficulty): LobbyResult {
  if (state.captainId !== pilotId) return { ok: false, code: 'not-captain' };
  if (total < 2 || total > RELEASE.maxPvpCombatants) return { ok: false, code: 'denied', message: 'bot total out of range' };
  state.botFill = { total, difficulty };
  bumpRules(state);
  fillBots(state, total, difficulty);
  return ok;
}

function fillBots(state: LobbyState, total: number, difficulty: BotDifficulty): void {
  for (let index = 0; index < state.seats.length; index++) {
    const seat = state.seats[index];
    if (seat && seat.isBot) state.seats[index] = null;
  }
  let combatants = humanCount(state);
  if (combatants >= total) return;
  for (let index = 0; index < state.seats.length && combatants < total; index++) {
    if (state.seats[index]) continue;
    const teamId = balancedTeam(state);
    state.seats[index] = {
      seat: index,
      pilotId: `bot-${index + 1}`,
      name: `Bot ${index + 1}`,
      teamId,
      isBot: true,
      presence: 'connected',
      life: 'staged',
      readyAtRevision: state.revision,
      ownRevision: state.revision,
      fit: defaultFit('kestrel'),
      pingMs: null,
      connectionGeneration: 0,
      difficulty,
    };
    combatants += 1;
  }
}

function balancedTeam(state: LobbyState): Id {
  const blue = state.seats.filter(seat => seat?.teamId === TEAM_BLUE).length;
  const red = state.seats.filter(seat => seat?.teamId === TEAM_RED).length;
  return blue <= red ? TEAM_BLUE : TEAM_RED;
}

export function transferCaptain(state: LobbyState, pilotId: Id, targetPilotId: Id): LobbyResult {
  if (state.captainId !== pilotId) return { ok: false, code: 'not-captain' };
  const target = seatFor(state, targetPilotId);
  if (!target || target.isBot) return { ok: false, code: 'denied', message: 'not a pilot' };
  state.captainId = targetPilotId;
  state.revision += 1;
  return ok;
}

export function removeSeat(state: LobbyState, pilotId: Id, targetPilotId: Id): LobbyResult {
  if (state.captainId !== pilotId) return { ok: false, code: 'not-captain' };
  const target = seatFor(state, targetPilotId);
  if (!target) return { ok: false, code: 'denied', message: 'not seated' };
  if (target.pilotId === pilotId) return { ok: false, code: 'denied', message: 'captain cannot remove themselves' };
  // A captain removes an unready seat explicitly; the seat is never silently marked ready.
  if (isReady(state, target)) return { ok: false, code: 'denied', message: 'seat is ready' };
  state.seats[target.seat] = null;
  state.revision += 1;
  return ok;
}

export function readyAt(state: LobbyState, seat: LobbySeat): number | null {
  if (seat.readyAtRevision === null) return null;
  const floor = Math.max(state.rulesRevision, seat.ownRevision);
  return seat.readyAtRevision >= floor ? seat.readyAtRevision : null;
}

export function isReady(state: LobbyState, seat: LobbySeat): boolean {
  return readyAt(state, seat) !== null;
}

export interface StartCheck { ok: boolean; blockers: string[] }

/** Atomic start check (B1): captain, readiness, valid fits and team rules, reported as blockers. */
export function startCheck(state: LobbyState, captainId: Id): StartCheck {
  const blockers: string[] = [];
  if (state.captainId !== captainId) blockers.push('Only the room captain can start');
  for (const seat of connectedHumans(state)) {
    if (!isReady(state, seat)) blockers.push(`Waiting for ${seat.name}`);
    const derived = deriveFit(seat.fit);
    if (!derived.valid) blockers.push(`${seat.name} has an invalid fit`);
  }
  if (state.mode === 'team-deathmatch') {
    const blue = state.seats.filter(seat => seat?.teamId === TEAM_BLUE).length;
    const red = state.seats.filter(seat => seat?.teamId === TEAM_RED).length;
    if (Math.abs(blue - red) > 1) blockers.push('Teams are unbalanced');
    if (blue === 0 || red === 0) blockers.push('Both fleets need at least one ship');
  }
  if (state.mode === 'campaign' && state.missionId === null) blockers.push('Choose a mission');
  return { ok: blockers.length === 0, blockers };
}

export function view(state: LobbyState): LobbyView {
  const roster: RosterEntry[] = state.seats
    .filter((seat): seat is LobbySeat => seat !== null)
    .map(seat => ({
      pilotId: seat.pilotId,
      name: seat.name,
      teamId: seat.teamId,
      isBot: seat.isBot,
      presence: seat.presence,
      life: seat.life,
      readyRevision: readyAt(state, seat),
      fit: seat.fit,
      pingMs: seat.pingMs,
      seat: seat.seat,
    }));
  const check = startCheck(state, state.captainId);
  return {
    revision: state.revision,
    captainId: state.captainId,
    mode: state.mode,
    mapId: state.mapId,
    missionId: state.missionId,
    joinPolicy: state.joinPolicy,
    roster,
    canStart: check.ok,
    startBlockers: check.blockers,
    botFill: state.botFill,
  };
}
