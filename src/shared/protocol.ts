/**
 * Control protocol (Plan B3). Entities travel as versioned binary snapshots through the codec; this
 * file is the *bounded JSON control plane* that surrounds them: handshake, commands, input frames,
 * receipts, baseline bookkeeping and lifecycle.
 *
 * Both sides parse with these functions, so a field cannot be spelled one way by the client and
 * another by the room. Everything is validated before it can allocate, and every rejection is a
 * typed result rather than a thrown string.
 */

import type {
  BaselineHeader, CampaignView, ClientView, Command, CommandCode, CommandResult, DebriefView, HostInfo, HostView,
  Id, InputFrame, InputReceipt, LobbyView, NoticeCode, Phase, Presence, RosterEntry, SessionEvent, LinkState,
  ObjectiveView, PlayerEconomyView,
} from './contracts.ts';
import { RELEASE } from './contracts.ts';
import {
  boundedArray, boundedString, displayName, enumField, fail, finiteNumber, idString, isPlainObject, ok, propagate, safeInteger,
  validateCommand, validateFit, validateFlightIntent, type Result,
} from './validate.ts';

export const PROTOCOL_VERSION = RELEASE.protocol;

/** Socket path on the host; one port serves assets, health, info and this endpoint (B2). */
export const SOCKET_PATH = '/ws';

export type ClientMessage =
  | { t: 'hello'; protocol: number; contentVersion: string; name: string; roomCode: string | null; resumeToken: string | null; campaignId: Id | null }
  | { t: 'claim'; token: string }
  | { t: 'command'; requestId: Id; command: Command }
  | { t: 'input'; frame: InputFrame }
  | { t: 'release'; epoch: Id; lifeId: Id; seq: number }
  | { t: 'ping'; nonce: number; clientTimeMs: number }
  | { t: 'baseline-ready'; transferId: Id; verified: boolean }
  | { t: 'baseline-request' }
  | { t: 'leave' };

/**
 * Lobby-phase and lifecycle state. Deliberately *not* `ClientView`: entities arrive at 30 Hz in the
 * binary snapshot, and metadata changes only on a revision, so the two never compete for bandwidth.
 */
export interface ViewMeta {
  phase: Phase | null;
  link: LinkState;
  pilotId: Id | null;
  epoch: Id | null;
  tick: number;
  lobby: LobbyView | null;
  campaign: CampaignView | null;
  host: HostView | null;
  debrief: DebriefView | null;
  save: ClientView['save'];
  teamScores: Readonly<Record<Id, number>>;
  objectives: readonly ObjectiveView[];
  respawnAtTick: number | null;
  phaseEndsAtTick: number | null;
  map: ClientView['map'];
  economy: PlayerEconomyView | null;
}

export type ServerMessage =
  | { t: 'welcome'; protocol: number; contentVersion: string; epoch: Id; tick: number; pilotId: Id; sessionId: Id; resumeToken: string; generation: number; phase: Phase; host: HostInfo; seat: number }
  | { t: 'reject'; code: CommandCode; message: string }
  | { t: 'lobby'; lobby: LobbyView }
  | { t: 'meta'; meta: ViewMeta }
  | { t: 'receipt'; receipt: InputReceipt }
  | { t: 'command-result'; result: CommandResult }
  | { t: 'baseline-header'; header: BaselineHeader }
  | { t: 'baseline-end'; transferId: Id; verified: boolean }
  | { t: 'event'; event: SessionEvent }
  | { t: 'notice'; code: NoticeCode; message: string }
  | { t: 'pong'; nonce: number; clientTimeMs: number; tick: number; serverTimeMs: number }
  | { t: 'goodbye'; code: CommandCode; reason: string };

const PHASES = ['lobby', 'loading', 'countdown', 'live', 'extraction', 'settlement', 'debrief'] as const;
const LINKS = ['idle', 'connecting', 'handshake', 'loading', 'online', 'reconnecting', 'failed'] as const;
const PRESENCES = ['connected', 'reconnecting', 'away', 'left'] as const;
const LIVES = ['staged', 'alive', 'disabled', 'destroyed', 'respawning', 'spectating'] as const;
const SAVES = ['clean', 'pending', 'saved', 'failed'] as const;
const NOTICES: readonly NoticeCode[] = [
  'weapon-traffic-limit', 'insufficient-power', 'thermal-limit', 'no-ammo', 'reloading', 'invalid-target', 'out-of-range',
  'not-docked', 'hostile-nearby', 'cargo-full', 'insufficient-credits', 'already-recovered', 'tow-dispatched',
  'checkpoint-restored', 'boundary-warning', 'boundary-tow', 'vote-started', 'vote-resolved', 'disconnect-grace',
];
const COMMAND_CODES: readonly CommandCode[] = [
  'ok', 'stale-revision', 'not-captain', 'seat-taken', 'room-full', 'invalid-fit', 'join-closed', 'bad-code',
  'receipt-expired', 'rate-limited', 'wrong-life', 'wrong-phase', 'denied', 'unsupported', 'incompatible', 'already-processed',
];

// ---------------------------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------------------------

export function parseClientMessage(value: unknown): Result<ClientMessage> {
  if (typeof value !== 'string') return fail('bad-type', 'control frame must be text');
  if (value.length > RELEASE.maxHumans * 512) return fail('too-large', `${value.length} characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('bad-type', 'malformed JSON');
  }
  if (!isPlainObject(parsed)) return fail('not-object', 'control frame');
  const type = enumField(parsed.t, ['hello', 'claim', 'command', 'input', 'release', 'ping', 'baseline-ready', 'baseline-request', 'leave'] as const);
  if (!type.ok) return type;
  switch (type.value) {
    case 'claim': {
      // One-use operator claim delivered in the launcher URL fragment and consumed over loopback
      // (B2). The room validates loopback and Origin; this only bounds the token itself.
      const token = boundedString(parsed.token, 128, 128);
      if (!token.ok) return token;
      if (token.value.length < 32) return fail('too-long', 'claim token is too short to be random');
      return ok({ t: 'claim', token: token.value });
    }
    case 'hello': {
      const protocol = safeInteger(parsed.protocol, 0, 1000);
      if (!protocol.ok) return protocol;
      const contentVersion = boundedString(parsed.contentVersion, 64, 32);
      if (!contentVersion.ok) return contentVersion;
      const name = displayName(parsed.name);
      if (!name.ok) return name;
      const roomCode = parsed.roomCode === null || parsed.roomCode === undefined ? ok(null) : boundedString(parsed.roomCode, 32, 16);
      if (!roomCode.ok) return roomCode;
      const resumeToken = parsed.resumeToken === null || parsed.resumeToken === undefined ? ok(null) : boundedString(parsed.resumeToken, 128, 128);
      if (!resumeToken.ok) return resumeToken;
      const campaignId = parsed.campaignId === null || parsed.campaignId === undefined ? ok(null) : idString(parsed.campaignId);
      if (!campaignId.ok) return campaignId;
      return ok({
        t: 'hello',
        protocol: protocol.value,
        contentVersion: contentVersion.value,
        name: name.value,
        roomCode: roomCode.value,
        resumeToken: resumeToken.value,
        campaignId: campaignId.value,
      });
    }
    case 'command': {
      const requestId = idString(parsed.requestId);
      if (!requestId.ok) return requestId;
      const command = validateCommand(parsed.command);
      if (!command.ok) return command;
      return ok({ t: 'command', requestId: requestId.value, command: command.value });
    }
    case 'input': {
      const frameValue = parsed.frame;
      if (!isPlainObject(frameValue)) return fail('not-object', 'input frame');
      const epoch = idString(frameValue.epoch);
      if (!epoch.ok) return epoch;
      const lifeId = idString(frameValue.lifeId);
      if (!lifeId.ok) return lifeId;
      const seq = safeInteger(frameValue.seq, 0, 0xffffffff);
      if (!seq.ok) return seq;
      const targetTick = safeInteger(frameValue.targetTick, 0, 0xffffffff);
      if (!targetTick.ok) return targetTick;
      const intent = validateFlightIntent(frameValue.intent);
      if (!intent.ok) return intent;
      const frame: InputFrame = { epoch: epoch.value, lifeId: lifeId.value, seq: seq.value, targetTick: targetTick.value, intent: intent.value };
      return ok({ t: 'input', frame });
    }
    case 'release': {
      const epoch = idString(parsed.epoch);
      if (!epoch.ok) return epoch;
      const lifeId = idString(parsed.lifeId);
      if (!lifeId.ok) return lifeId;
      const seq = safeInteger(parsed.seq, 0, 0xffffffff);
      if (!seq.ok) return seq;
      return ok({ t: 'release', epoch: epoch.value, lifeId: lifeId.value, seq: seq.value });
    }
    case 'ping': {
      const nonce = safeInteger(parsed.nonce, 0, 0xffffffff);
      if (!nonce.ok) return nonce;
      const clientTimeMs = finiteNumber(parsed.clientTimeMs, 0, 1e15);
      if (!clientTimeMs.ok) return clientTimeMs;
      return ok({ t: 'ping', nonce: nonce.value, clientTimeMs: clientTimeMs.value });
    }
    case 'baseline-ready': {
      const transferId = idString(parsed.transferId);
      if (!transferId.ok) return transferId;
      if (typeof parsed.verified !== 'boolean') return fail('bad-type', 'verified');
      return ok({ t: 'baseline-ready', transferId: transferId.value, verified: parsed.verified });
    }
    case 'baseline-request':
      return ok({ t: 'baseline-request' });
    case 'leave':
      return ok({ t: 'leave' });
  }
  return fail<ClientMessage>('bad-enum', 'unhandled client message');
}

// ---------------------------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------------------------

export function parseServerMessage(value: unknown): Result<ServerMessage> {
  if (typeof value !== 'string') return fail('bad-type', 'control frame must be text');
  if (value.length > 2 * 1024 * 1024) return fail('too-large', `${value.length} characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('bad-type', 'malformed JSON');
  }
  if (!isPlainObject(parsed)) return fail('not-object', 'control frame');
  const type = enumField(parsed.t, ['welcome', 'reject', 'lobby', 'meta', 'receipt', 'command-result', 'baseline-header', 'baseline-end', 'event', 'notice', 'pong', 'goodbye'] as const);
  if (!type.ok) return type;
  switch (type.value) {
    case 'welcome': {
      const protocol = safeInteger(parsed.protocol, 0, 1000);
      if (!protocol.ok) return protocol;
      const contentVersion = boundedString(parsed.contentVersion, 64, 32);
      if (!contentVersion.ok) return contentVersion;
      const epoch = idString(parsed.epoch);
      if (!epoch.ok) return epoch;
      const tick = safeInteger(parsed.tick, 0, 0xffffffff);
      if (!tick.ok) return tick;
      const pilotId = idString(parsed.pilotId);
      if (!pilotId.ok) return pilotId;
      const sessionId = idString(parsed.sessionId);
      if (!sessionId.ok) return sessionId;
      const resumeToken = boundedString(parsed.resumeToken, 256, 256);
      if (!resumeToken.ok) return resumeToken;
      const generation = safeInteger(parsed.generation, 0, 0xffffffff);
      if (!generation.ok) return generation;
      const phase = enumField(parsed.phase, PHASES);
      if (!phase.ok) return phase;
      const seat = safeInteger(parsed.seat, 0, RELEASE.maxHumans - 1);
      if (!seat.ok) return seat;
      if (!isPlainObject(parsed.host)) return fail('not-object', 'host info');
      const host: HostInfo = {
        protocol: Number(parsed.host.protocol ?? 0),
        contentVersion: String(parsed.host.contentVersion ?? ''),
        appVersion: String(parsed.host.appVersion ?? ''),
        phase: (enumField(parsed.host.phase, PHASES).ok ? parsed.host.phase : 'lobby') as Phase,
        guestOrigin: typeof parsed.host.guestOrigin === 'string' ? parsed.host.guestOrigin : null,
        operatorOrigin: typeof parsed.host.operatorOrigin === 'string' ? parsed.host.operatorOrigin : null,
        capacity: Number(parsed.host.capacity ?? 0),
        occupied: Number(parsed.host.occupied ?? 0),
        uptimeSeconds: Number(parsed.host.uptimeSeconds ?? 0),
        joinPolicy: (enumField(parsed.host.joinPolicy, ['open', 'code', 'closed'] as const).ok ? parsed.host.joinPolicy : 'open') as HostInfo['joinPolicy'],
      };
      return ok({
        t: 'welcome',
        protocol: protocol.value,
        contentVersion: contentVersion.value,
        epoch: epoch.value,
        tick: tick.value,
        pilotId: pilotId.value,
        sessionId: sessionId.value,
        resumeToken: resumeToken.value,
        generation: generation.value,
        phase: phase.value,
        host,
        seat: seat.value,
      });
    }
    case 'reject':
    case 'goodbye': {
      const code = enumField(parsed.code, COMMAND_CODES);
      if (!code.ok) return code;
      const message = boundedString(parsed.reason ?? parsed.message ?? '', 200, 120);
      if (!message.ok) return message;
      if (type.value === 'reject') return ok({ t: 'reject', code: code.value, message: message.value });
      return ok({ t: 'goodbye', code: code.value, reason: message.value });
    }
    case 'lobby': {
      const lobby = parseLobby(parsed.lobby);
      if (!lobby.ok) return lobby;
      return ok({ t: 'lobby', lobby: lobby.value });
    }
    case 'meta': {
      const meta = parseMeta(parsed.meta);
      if (!meta.ok) return meta;
      return ok({ t: 'meta', meta: meta.value });
    }
    case 'receipt': {
      if (!isPlainObject(parsed.receipt)) return fail('not-object', 'receipt');
      const seq = safeInteger(parsed.receipt.seq, 0, 0xffffffff);
      if (!seq.ok) return seq;
      const result = enumField(parsed.receipt.result, ['scheduled', 'stale', 'invalid', 'wrong-life'] as const);
      if (!result.ok) return result;
      const applyAtTick = parsed.receipt.applyAtTick === undefined ? ok(undefined) : safeInteger(parsed.receipt.applyAtTick, 0, 0xffffffff);
      if (!applyAtTick.ok) return applyAtTick;
      const receipt: InputReceipt = { seq: seq.value, result: result.value, ...(applyAtTick.value === undefined ? {} : { applyAtTick: applyAtTick.value }) };
      return ok({ t: 'receipt', receipt });
    }
    case 'command-result': {
      if (!isPlainObject(parsed.result)) return fail('not-object', 'command result');
      const requestId = idString(parsed.result.requestId);
      if (!requestId.ok) return requestId;
      const code = enumField(parsed.result.code, COMMAND_CODES);
      if (!code.ok) return code;
      if (typeof parsed.result.ok !== 'boolean') return fail('bad-type', 'ok');
      const revision = parsed.result.revision === undefined ? ok(undefined) : safeInteger(parsed.result.revision, 0, 0xffffffff);
      if (!revision.ok) return revision;
      const message = parsed.result.message === undefined ? ok(undefined) : boundedString(parsed.result.message, 200, 120);
      if (!message.ok) return message;
      const result: CommandResult = {
        requestId: requestId.value,
        ok: parsed.result.ok,
        code: code.value,
        ...(revision.value === undefined ? {} : { revision: revision.value }),
        ...(message.value === undefined ? {} : { message: message.value }),
      };
      return ok({ t: 'command-result', result });
    }
    case 'baseline-header': {
      const header = parseBaselineHeader(parsed.header);
      if (!header.ok) return header;
      return ok({ t: 'baseline-header', header: header.value });
    }
    case 'baseline-end': {
      const transferId = idString(parsed.transferId);
      if (!transferId.ok) return transferId;
      if (typeof parsed.verified !== 'boolean') return fail('bad-type', 'verified');
      return ok({ t: 'baseline-end', transferId: transferId.value, verified: parsed.verified });
    }
    case 'event': {
      const event = parseEvent(parsed.event);
      if (!event.ok) return event;
      return ok({ t: 'event', event: event.value });
    }
    case 'notice': {
      const code = enumField(parsed.code, NOTICES);
      if (!code.ok) return code;
      const message = boundedString(parsed.message, 200, 120);
      if (!message.ok) return message;
      return ok({ t: 'notice', code: code.value, message: message.value });
    }
    case 'pong': {
      const nonce = safeInteger(parsed.nonce, 0, 0xffffffff);
      if (!nonce.ok) return nonce;
      const clientTimeMs = finiteNumber(parsed.clientTimeMs, 0, 1e15);
      if (!clientTimeMs.ok) return clientTimeMs;
      const tick = safeInteger(parsed.tick, 0, 0xffffffff);
      if (!tick.ok) return tick;
      const serverTimeMs = finiteNumber(parsed.serverTimeMs, 0, 1e15);
      if (!serverTimeMs.ok) return serverTimeMs;
      return ok({ t: 'pong', nonce: nonce.value, clientTimeMs: clientTimeMs.value, tick: tick.value, serverTimeMs: serverTimeMs.value });
    }
  }
}

function parseFitStrict(value: unknown) {
  return validateFit(value);
}

function parseRosterEntry(value: unknown): Result<RosterEntry> {
  if (!isPlainObject(value)) return fail('not-object', 'roster entry');
  const pilotId = idString(value.pilotId);
  if (!pilotId.ok) return pilotId;
  const name = boundedString(value.name, 80, 20);
  if (!name.ok) return name;
  const teamId = idString(value.teamId);
  if (!teamId.ok) return teamId;
  const seat = safeInteger(value.seat, 0, RELEASE.maxHumans - 1);
  if (!seat.ok) return seat;
  const presence = enumField(value.presence, PRESENCES);
  if (!presence.ok) return presence;
  const life = enumField(value.life, LIVES);
  if (!life.ok) return life;
  const fit = parseFitStrict(value.fit);
  if (!fit.ok) return fit;
  const readyRevision = value.readyRevision === null ? ok(null) : safeInteger(value.readyRevision, 0, 0xffffffff);
  if (!readyRevision.ok) return readyRevision;
  const pingMs = value.pingMs === null ? ok(null) : finiteNumber(value.pingMs, 0, 60000);
  if (!pingMs.ok) return pingMs;
  if (typeof value.isBot !== 'boolean') return fail('bad-type', 'isBot');
  return ok({
    pilotId: pilotId.value,
    name: name.value,
    teamId: teamId.value,
    isBot: value.isBot,
    presence: presence.value as Presence,
    life: life.value as RosterEntry['life'],
    readyRevision: readyRevision.value,
    fit: fit.value,
    pingMs: pingMs.value,
    seat: seat.value,
  });
}

export function parseLobby(value: unknown): Result<LobbyView> {
  if (!isPlainObject(value)) return fail('not-object', 'lobby');
  const revision = safeInteger(value.revision, 0, 0xffffffff);
  if (!revision.ok) return revision;
  const captainId = idString(value.captainId);
  if (!captainId.ok) return captainId;
  const mode = enumField(value.mode, ['campaign', 'skirmish', 'team-deathmatch'] as const);
  if (!mode.ok) return mode;
  const mapId = idString(value.mapId);
  if (!mapId.ok) return mapId;
  const missionId = value.missionId === null ? ok(null) : idString(value.missionId);
  if (!missionId.ok) return missionId;
  const joinPolicy = enumField(value.joinPolicy, ['open', 'code', 'closed'] as const);
  if (!joinPolicy.ok) return joinPolicy;
  const roster = boundedArray(value.roster, RELEASE.maxHumans, item => parseRosterEntry(item));
  if (!roster.ok) return roster;
  const blockers = boundedArray(value.startBlockers, 16, item => boundedString(item, 120, 80));
  if (!blockers.ok) return blockers;
  if (typeof value.canStart !== 'boolean') return fail('bad-type', 'canStart');
  let botFill: LobbyView['botFill'] = null;
  if (isPlainObject(value.botFill)) {
    const total = safeInteger(value.botFill.total, 0, RELEASE.maxPvpCombatants);
    if (!total.ok) return total;
    const difficulty = enumField(value.botFill.difficulty, ['easy', 'normal', 'hard'] as const);
    if (!difficulty.ok) return difficulty;
    botFill = { total: total.value, difficulty: difficulty.value };
  }
  return ok({
    revision: revision.value,
    captainId: captainId.value,
    mode: mode.value,
    mapId: mapId.value,
    missionId: missionId.value,
    joinPolicy: joinPolicy.value,
    roster: roster.value,
    canStart: value.canStart,
    startBlockers: blockers.value,
    botFill,
  });
}

function parseBaselineHeader(value: unknown): Result<BaselineHeader> {
  if (!isPlainObject(value)) return fail('not-object', 'baseline header');
  const transferId = idString(value.transferId);
  if (!transferId.ok) return transferId;
  const mapHash = boundedString(value.mapHash, 32, 32);
  if (!mapHash.ok) return mapHash;
  const epoch = idString(value.epoch);
  if (!epoch.ok) return epoch;
  const tick = safeInteger(value.tick, 0, 0xffffffff);
  if (!tick.ok) return tick;
  const chunkCount = safeInteger(value.chunkCount, 1, 32);
  if (!chunkCount.ok) return chunkCount;
  const totalBytes = safeInteger(value.totalBytes, 0, 1024 * 1024);
  if (!totalBytes.ok) return totalBytes;
  return ok({ transferId: transferId.value, mapHash: mapHash.value, epoch: epoch.value, tick: tick.value, chunkCount: chunkCount.value, totalBytes: totalBytes.value });
}

export function parseEvent(value: unknown): Result<SessionEvent> {
  if (!isPlainObject(value)) return fail('not-object', 'event');
  const deliverySeq = safeInteger(value.deliverySeq, 0, 0xffffffff);
  if (!deliverySeq.ok) return deliverySeq;
  const tick = safeInteger(value.tick, 0, 0xffffffff);
  if (!tick.ok) return tick;
  const epoch = idString(value.epoch);
  if (!epoch.ok) return epoch;
  const eventId = idString(value.eventId);
  if (!eventId.ok) return eventId;
  const kind = enumField(value.kind, ['shot', 'impact', 'life', 'roster', 'objective', 'result', 'save', 'notice'] as const);
  if (!kind.ok) return kind;
  if (!isPlainObject(value.payload)) return fail('not-object', 'event payload');
  const payload = value.payload as SessionEvent['payload'];
  return ok({ deliverySeq: deliverySeq.value, tick: tick.value, epoch: epoch.value, eventId: eventId.value, kind: kind.value, payload } as SessionEvent);
}

export function parseMeta(value: unknown): Result<ViewMeta> {
  if (!isPlainObject(value)) return fail('not-object', 'view meta');
  const phase = value.phase === null ? ok(null) : enumField(value.phase, PHASES);
  if (!phase.ok) return phase;
  const link = enumField(value.link, LINKS);
  if (!link.ok) return link;
  const pilotId = value.pilotId === null ? ok(null) : idString(value.pilotId);
  if (!pilotId.ok) return pilotId;
  const epoch = value.epoch === null ? ok(null) : idString(value.epoch);
  if (!epoch.ok) return epoch;
  const tick = safeInteger(value.tick, 0, 0xffffffff);
  if (!tick.ok) return tick;
  const save = enumField(value.save, SAVES);
  if (!save.ok) return save;
  const lobby = value.lobby === null || value.lobby === undefined ? ok(null) : parseLobby(value.lobby);
  if (!lobby.ok) return lobby;
  const objectives = boundedArray(value.objectives ?? [], 32, (item): Result<ObjectiveView> => {
    if (!isPlainObject(item)) return fail('not-object', 'objective');
    const id = idString(item.id);
    if (!id.ok) return propagate(id);
    const title = boundedString(item.title, 120, 80);
    if (!title.ok) return propagate(title);
    const state = enumField(item.state, ['locked', 'active', 'complete', 'failed'] as const);
    if (!state.ok) return propagate(state);
    const completed = safeInteger(item.completed, 0, 10000);
    if (!completed.ok) return propagate(completed);
    const required = safeInteger(item.required, 0, 10000);
    if (!required.ok) return propagate(required);
    const marker = item.marker === null ? ok(null) : markerField(item.marker);
    if (!marker.ok) return propagate(marker);
    const view: ObjectiveView = { id: id.value, title: title.value, state: state.value, completed: completed.value, required: required.value, marker: marker.value };
    return ok(view);
  });
  if (!objectives.ok) return objectives;
  const scores = value.teamScores ?? {};
  if (!isPlainObject(scores)) return fail('bad-type', 'teamScores');
  const teamScores: Record<Id, number> = {};
  for (const [teamId, score] of Object.entries(scores)) {
    const parsed = safeInteger(score, 0, 100000);
    if (!parsed.ok) return parsed;
    teamScores[teamId] = parsed.value;
  }
  const respawnAtTick = value.respawnAtTick === null || value.respawnAtTick === undefined ? ok(null) : safeInteger(value.respawnAtTick, 0, 0xffffffff);
  if (!respawnAtTick.ok) return respawnAtTick;
  const phaseEndsAtTick = value.phaseEndsAtTick === null || value.phaseEndsAtTick === undefined ? ok(null) : safeInteger(value.phaseEndsAtTick, 0, 0xffffffff);
  if (!phaseEndsAtTick.ok) return phaseEndsAtTick;
  const map = value.map === null || value.map === undefined ? ok(null) : parseMapMeta(value.map);
  if (!map.ok) return map;
  const host = value.host === null || value.host === undefined ? ok(null) : parseHostView(value.host);
  if (!host.ok) return host;
  const campaign = value.campaign === null || value.campaign === undefined ? ok(null) : ok(value.campaign as CampaignView);
  if (!campaign.ok) return campaign;
  const debrief = value.debrief === null || value.debrief === undefined ? ok(null) : ok(value.debrief as DebriefView);
  if (!debrief.ok) return debrief;
  const economy = value.economy === null || value.economy === undefined ? ok(null) : ok(value.economy as ViewMeta['economy']);
  if (!economy.ok) return economy;
  return ok({
    phase: phase.value,
    link: link.value as LinkState,
    pilotId: pilotId.value,
    epoch: epoch.value,
    tick: tick.value,
    lobby: lobby.value,
    campaign: campaign.value,
    host: host.value,
    debrief: debrief.value,
    save: save.value,
    teamScores,
    objectives: objectives.value,
    respawnAtTick: respawnAtTick.value,
    phaseEndsAtTick: phaseEndsAtTick.value,
    map: map.value,
    economy: economy.value,
  });
}

function markerField(value: unknown) {
  if (!isPlainObject(value)) return fail<{ x: number; y: number }>('bad-type', 'marker');
  const x = finiteNumber(value.x, -1e6, 1e6);
  if (!x.ok) return x;
  const y = finiteNumber(value.y, -1e6, 1e6);
  if (!y.ok) return y;
  return ok({ x: x.value, y: y.value });
}

function parseMapMeta(value: unknown): Result<NonNullable<ClientView['map']>> {
  if (!isPlainObject(value)) return fail('not-object', 'map');
  const id = idString(value.id);
  if (!id.ok) return id;
  const baselineHash = boundedString(value.baselineHash, 32, 32);
  if (!baselineHash.ok) return baselineHash;
  const generatorVersion = safeInteger(value.generatorVersion, 0, 1000);
  if (!generatorVersion.ok) return generatorVersion;
  const boundsRadiusM = finiteNumber(value.boundsRadiusM, 1, 1_000_000);
  if (!boundsRadiusM.ok) return boundsRadiusM;
  const stationIds = boundedArray(value.stationIds ?? [], 32, item => idString(item));
  if (!stationIds.ok) return stationIds;
  return ok({ id: id.value, baselineHash: baselineHash.value, generatorVersion: generatorVersion.value, boundsRadiusM: boundsRadiusM.value, stationIds: stationIds.value });
}

function parseHostView(value: unknown): Result<HostView> {
  if (!isPlainObject(value)) return fail('not-object', 'host view');
  return ok({
    isOperator: value.isOperator === true,
    guestOrigin: typeof value.guestOrigin === 'string' ? value.guestOrigin : null,
    selectedAdapter: typeof value.selectedAdapter === 'string' ? value.selectedAdapter : null,
    roomCodeVisibleToCaptain: typeof value.roomCodeVisibleToCaptain === 'string' ? value.roomCodeVisibleToCaptain : null,
    canStop: value.canStop === true,
  });
}
