/**
 * Authority room (Plan B1/B3/B4). One room owns the lobby, the 120 Hz world, every connection's
 * delivery state and the campaign checkpoint writer. It is transport-agnostic: `net.ts` adapts
 * Bun's WebSocket to `RoomSocket`, so the room can be driven by a real socket or by a test double
 * without either path being special.
 *
 * Fixed-step rule (B4): the timestep is never enlarged. A late loop runs at most
 * `MAX_CATCH_UP_STEPS` steps and then slows simulation time, which is the only overload response
 * that keeps physics and replay identical.
 *
 * The control plane is `src/shared/protocol.ts` — both sides parse with the same functions, so a
 * field cannot be spelled one way by the client and another by the room. Entities travel as binary
 * codec frames; a baseline is an ordered sequence of snapshot frames sent between `baseline-header`
 * and `baseline-end`, which is exactly what the client adapter collects.
 *
 * Intents the room answers directly: lobby edits, readiness, launch, bot fill, captain transfer,
 * reload, sensor mode, extraction, votes, return-lobby and leave. Intents whose owning system has
 * not landed yet (docking/salvage, utilities, crew orders, tow recovery, manual respawn, economy)
 * are answered `unsupported` — a typed refusal, never a silent no-op and never a second rules
 * implementation.
 */

import { PVP, RULES } from '../shared/balance.ts';
import type {
  CampaignView, ClientView, Command, CommandCode, CommandResult, DebriefView, DerivedFit, HostInfo, HostView, Id, InputFrame,
  InputReceipt, LobbyView, Mode, ObjectiveView, Phase, PredictionState, SelfAuthority, SessionEvent,
  ShipView, Snapshot, WeaponView,
} from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import type { ServerMessage, ViewMeta } from '../shared/protocol.ts';
import { encodeSnapshot, StringTable } from '../shared/codec.ts';
import type { BodyView } from '../shared/contracts.ts';
import type { EventPayloadByKind, SessionEventKind } from '../shared/contracts.ts';
import { TEAM_CREW, TEAM_HOSTILE, PVP_TEAMS } from '../shared/teams.ts';
import { CAMPAIGN_MISSIONS, missionDefinition } from '../sim/campaign/missions.ts';
import { createMission, interactFacts, recoverItem } from '../sim/world.ts';
import { nearestFreeItem } from '../sim/mission.ts';
import { hash32 } from '../shared/ids.ts';
import { createRng } from '../shared/rng.ts';
import { displayName, originAllowed, safeInteger, validateCommand, validateFlightIntent } from '../shared/validate.ts';
import type { Result } from '../shared/validate.ts';

import type { LobbyState } from '../sim/lobby.ts';
import type { CampaignSnapshot } from './store-port.ts';
import {
  createLobby, editLobby, join, leave, noteLife, notePresence, removeSeat, seatFor,
  setBotFill, setPilot, setReady, startCheck, transferCaptain, view as lobbyView,
} from '../sim/lobby.ts';
import type { PilotRuntime, WorldState } from '../sim/world.ts';
import {
  addPilot, applyCrewOrder, applyInput, applyUtility, bodyOf, createWorld, projectileViews, releaseAll, releaseInput,
  removePilot, requestRespawn, rockViews, shipView, stepWorld,
} from '../sim/world.ts';
import { beginReload } from '../sim/weapons.ts';
import { encodeBaselineFrames, mapHashOf, payloadHash } from './baseline.ts';
import type { CheckpointState, HostStorePort } from './store-port.ts';
import { isLoopback } from './operator.ts';

/** Steps in one loop before simulation time is slowed instead of the timestep enlarged. */
export const MAX_CATCH_UP_STEPS = 8;

/** Typed close codes so a client can tell a refused handshake from a shut-down room. */
export const CLOSE = {
  normal: 1000,
  rejected: 4001,
  slowClient: 4002,
  superseded: 4003,
  shuttingDown: 4004,
} as const;

export type CloseReason = 'rejected' | 'slow-client' | 'slow-client-buffer' | 'superseded' | 'shutdown';

/** One connected transport endpoint. `net.ts` implements it; tests implement it in memory. */
export interface RoomSocket {
  readonly connectionId: number;
  sendControl(message: ServerMessage): void;
  /** Bun's send contract: >0 sent, -1 enqueued under backpressure, 0 dropped. */
  sendBinary(bytes: Uint8Array): number;
  close(code: number, reason: CloseReason): void;
  readonly open: boolean;
}

export interface RoomSocketInfo {
  remoteAddress: string;
  origin: string | null;
}

export interface HelloRequest {
  name: string;
  roomCode: string | null;
  resumeToken: string | null;
  campaignId: Id | null;
  protocol: number;
  contentVersion: string;
}

/** Measured facts about one interaction; the room measures, the campaign decides what they mean. */
export interface InteractionFacts {
  distanceM: number;
  relativeSpeedMS: number;
  lineOfSight: boolean;
  targetAlive: boolean;
  pilotAlive: boolean;
  headingErrorDeg: number | null;
  berthClear: boolean;
  queueVisible: boolean;
}

/** Anything the room can call to advance campaign objectives; `serve.ts` wires the real runtime. */
export interface CampaignSource {
  viewObjectives(): readonly ObjectiveView[];
  advance(tick: number): void;
  commitDecision(decisionId: Id, optionId: Id): { committed: boolean; code: string };
  resetToCheckpoint(): void;
  /**
   * Which objective and item an entity belongs to, so the room can measure the right thing without
   * knowing the mission table.
   */
  resolve(entityId: Id): { objectiveId: Id; itemId: Id | null } | null;
  /** One interaction, evaluated once. Acceptance is the campaign's decision, never the room's. */
  interact(input: { pilotId: Id; isBot: boolean; objectiveId: Id; itemId: Id | null; tick: number; facts: InteractionFacts }): { accepted: boolean; code: string };
  /** What finishing this mission is worth and what it opens (B8); null outside a campaign. */
  settlement(): { rewardCredits: number; receiptId: Id | null; nextMissionId: Id | null } | null;
  /** Sustained work: called every tick for a pilot who is still holding an interaction. */
  observe(input: { pilotId: Id; isBot: boolean; objectiveId: Id; itemId: Id | null; tick: number; facts: InteractionFacts }): { accepted: boolean; code: string };
}

export interface RoomOptions {
  roomId?: Id;
  hostName?: string;
  mode?: Mode;
  mapId?: Id;
  missionId?: Id | null;
  seed?: number;
  joinPolicy?: 'open' | 'code' | 'closed';
  roomCode?: string | null;
  store?: HostStorePort | null;
  campaignId?: Id | null;
  /** Guests are held at "Host preparing room" until the operator claim is consumed (B2). */
  operatorRequired?: boolean;
  guestOrigin?: string | null;
  operatorOrigin?: string | null;
  selectedAdapter?: string | null;
  devOrigins?: readonly string[];
  now?: () => number;
  receiptRetentionMs?: number;
  snapshotIntervalTicks?: number;
  rockIntervalTicks?: number;
  staleTicks?: number;
  matchSeconds?: number;
}

interface ResolvedRoom {
  hostName: string;
  mode: Mode;
  joinPolicy: 'open' | 'code' | 'closed';
  operatorRequired: boolean;
  matchSeconds: number;
}

interface LoggedEvent {
  eventId: Id;
  epoch: Id;
  tick: number;
  kind: SessionEventKind;
  payload: EventPayloadByKind[SessionEventKind];
  bytes: number;
}

interface Receipt {
  result: CommandResult;
  atMs: number;
}

interface PendingBaseline {
  transferId: Id;
  tick: number;
  frames: number;
}

interface Session {
  sessionId: Id;
  pilotId: Id;
  generation: number;
  socket: RoomSocket;
  remoteAddress: string;
  origin: string | null;
  operator: boolean;
  order: number;
  tokenHash: string;
  previousTokenHash: string | null;
  previousTokenExpiresAt: number;
  table: StringTable;
  deliverySeq: number;
  /** Index into `eventLog` of the next event this session has not received. */
  eventCursor: number;
  receipts: Map<Id, Receipt>;
  expiredReceipts: Set<Id>;
  lastCommandSeq: number;
  unsentSnapshot: Uint8Array | null;
  pendingCritical: Uint8Array[];
  pendingCriticalBytes: number;
  socketBufferedBytes: number;
  congestedSinceTick: number | null;
  pendingBaseline: PendingBaseline | null;
  needBaseline: boolean;
  lastSeenTick: number;
  graceEndsAtTick: number | null;
}

const EMPTY_OBJECTIVES: readonly ObjectiveView[] = [];

export class Room {
  readonly roomId: Id;
  readonly seed: number;
  lobby: LobbyState;
  world: WorldState | null = null;
  phase: Phase = 'lobby';

  private readonly resolved: ResolvedRoom;
  private readonly store: HostStorePort | null;
  private readonly campaignId: Id | null;
  private campaignSource: CampaignSource | null = null;
  /** Objectives a pilot is holding an interaction on, so sustained work can be fed each tick. */
  private readonly interactions = new Map<Id, { objectiveId: Id; itemId: Id | null }>();
  /** Last published objective progress, so a completion reaches the clients instead of staying local. */
  private objectivesSignature = 0;
  /** The host's campaign record: credits, inventory, receipts and recorded decisions (B9). */
  private campaign: CampaignSnapshot | null = null;
  private readonly now: () => number;
  private readonly sessions = new Map<Id, Session>();
  private readonly byConnection = new Map<number, Session>();
  private readonly resumeIndex = new Map<string, Id>();
  private readonly eventLog: LoggedEvent[] = [];
  private readonly snapshotInterval: number;
  private readonly rockInterval: number;
  private readonly staleTicks: number;
  private readonly receiptRetentionMs: number;
  private readonly devOrigins: readonly string[];
  private eventLogBytes = 0;
  private epochCounter = 0;
  private epoch: Id | null = null;
  private roomTick = 0;
  private nextPilot = 1;
  private nextSession = 1;
  private nextOrder = 1;
  private startedAt = 0;
  private phaseEndsAtTick: number | null = null;
  private lastBaseline: Id | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private loopLastMs = 0;
  private overloadLoops = 0;
  private caughtUpSteps = 0;
  private closed = false;
  private saveState: ClientView['save'] = 'clean';
  private lastSavedAt: string | null = null;
  private pendingSave: Promise<boolean> | null = null;
  private settling = false;
  private debrief: DebriefView | null = null;
  private resultReceipt: Id | null = null;
  private claimedOperator = false;
  private pendingClaim: { token: string; expiresAt: string } | null = null;
  private guestOrigin: string | null;
  private operatorOrigin: string | null;
  private selectedAdapter: string | null;

  constructor(options: RoomOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const seed = (options.seed ?? hash32(options.mapId ?? 'belt')) >>> 0;
    this.seed = seed;
    this.roomId = options.roomId ?? 'room-1';
    this.store = options.store ?? null;
    this.campaignId = options.campaignId ?? null;
    // The campaign record is the host's own; load it in the background and tell the clients when it
    // is real rather than showing an invented balance in the meantime.
    void this.hydrateCampaign();
    this.guestOrigin = options.guestOrigin ?? null;
    this.operatorOrigin = options.operatorOrigin ?? null;
    this.selectedAdapter = options.selectedAdapter ?? null;
    this.devOrigins = options.devOrigins ?? [];
    this.snapshotInterval = options.snapshotIntervalTicks ?? RELEASE.physicsHz / RELEASE.snapshotHz;
    this.rockInterval = options.rockIntervalTicks ?? RELEASE.physicsHz / RELEASE.rockHz;
    this.staleTicks = options.staleTicks ?? RULES.staleSeconds * RELEASE.physicsHz;
    this.receiptRetentionMs = options.receiptRetentionMs ?? RULES.receiptRetentionS * 1000;
    this.resolved = {
      hostName: options.hostName ?? 'Wayfarer',
      mode: options.mode ?? 'skirmish',
      joinPolicy: options.joinPolicy ?? 'open',
      operatorRequired: options.operatorRequired ?? true,
      matchSeconds: options.matchSeconds ?? PVP.timeLimitS,
    };
    this.lobby = createLobby({
      captainId: 'operator',
      name: this.resolved.hostName,
      mode: this.resolved.mode,
      mapId: options.mapId ?? 'belt',
      missionId: options.missionId ?? null,
      joinPolicy: this.resolved.joinPolicy,
      roomCode: options.roomCode ?? null,
    });
    // The operator claim assigns the initial captain; until then nobody holds a seat.
    this.lobby.seats[0] = null;
    this.lobby.revision += 1;
    this.startedAt = this.now();
  }

  // -------------------------------------------------------------------------------------------
  // Read-only surface for `net.ts`, `serve.ts` and tests
  // -------------------------------------------------------------------------------------------

  /** Wire the campaign runtime once `src/sim/campaign` lands; no second rules implementation. */
  attachCampaign(source: CampaignSource): void {
    this.campaignSource = source;
  }

  /**
   * Apply a host-screen setting to the room before anyone is seated (B2). This is the operator's own
   * machine and the operator's own room: the route that calls it validates loopback and Origin, which
   * is the same bar the operator claim is consumed under. Process-level actions still need the
   * launcher's admin token.
   */
  configureHost(patch: { mode?: Mode; joinPolicy?: LobbyState['joinPolicy']; roomCode?: string | null }): { ok: boolean; code: CommandCode; revision: number } {
    if (this.phase !== 'lobby') return { ok: false, code: 'wrong-phase', revision: this.lobby.revision };
    if (patch.mode && patch.mode !== this.lobby.mode) {
      if (patch.mode === 'campaign' && this.campaignId === null) {
        // A campaign has to exist before the room can run one; the title screen creates it.
        return { ok: false, code: 'denied', revision: this.lobby.revision };
      }
      this.lobby.mode = patch.mode;
      this.lobby.missionId = patch.mode === 'campaign' ? this.lobby.missionId ?? CAMPAIGN_MISSIONS[0]!.id : null;
    }
    if (patch.joinPolicy) this.lobby.joinPolicy = patch.joinPolicy;
    if (patch.roomCode !== undefined) this.lobby.roomCode = patch.roomCode;
    this.lobby.revision += 1;
    this.publishLobby();
    return { ok: true, code: 'ok', revision: this.lobby.revision };
  }

  setOrigins(guest: string | null, operator: string | null, adapter: string | null = null): void {
    this.guestOrigin = guest;
    this.operatorOrigin = operator;
    this.selectedAdapter = adapter;
  }

  get tick(): number {
    return this.roomTick;
  }

  get worldTick(): number {
    return this.world?.tick ?? 0;
  }

  get currentEpoch(): Id | null {
    return this.epoch;
  }

  get lastEventWatermark(): number {
    return this.eventLog.length;
  }

  get operatorClaimed(): boolean {
    return this.claimedOperator;
  }

  get saveStatus(): ClientView['save'] {
    return this.saveState;
  }

  get debriefView(): DebriefView | null {
    return this.debrief;
  }

  get lobbyState(): LobbyState {
    return this.lobby;
  }

  /** Waiting for a busy port is the one thing the launcher may retry. */
  get isClosed(): boolean {
    return this.closed;
  }

  allowedOrigins(): readonly string[] {
    const origins = new Set<string>();
    if (this.guestOrigin) origins.add(this.guestOrigin);
    if (this.operatorOrigin) {
      origins.add(this.operatorOrigin);
      try {
        const parsed = new URL(this.operatorOrigin);
        origins.add(`${parsed.protocol}//127.0.0.1:${parsed.port}`);
        origins.add(`${parsed.protocol}//localhost:${parsed.port}`);
      } catch {
        // A malformed launch origin simply contributes no alias.
      }
    }
    for (const origin of this.devOrigins) origins.add(origin);
    return [...origins];
  }

  /** True when `origin` is a served origin or an explicitly enabled dev origin. */
  originAllowed(origin: string | null): boolean {
    return originAllowed(origin, this.allowedOrigins());
  }

  info(): HostInfo {
    return {
      protocol: RELEASE.protocol,
      contentVersion: RELEASE.contentVersion,
      appVersion: '1.0.0',
      phase: this.phase,
      guestOrigin: this.guestOrigin,
      operatorOrigin: this.operatorOrigin,
      capacity: RELEASE.maxHumans,
      occupied: this.occupiedSeats(),
      uptimeSeconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
      joinPolicy: this.lobby.joinPolicy,
    };
  }

  /** Seats held, including reconnect reservations and bots. */
  occupiedSeats(): number {
    return this.lobby.seats.filter(seat => seat !== null).length;
  }

  metrics(): { tick: number; overloadLoops: number; caughtUpSteps: number; sessions: number; eventLogBytes: number; save: ClientView['save'] } {
    return {
      tick: this.roomTick,
      overloadLoops: this.overloadLoops,
      caughtUpSteps: this.caughtUpSteps,
      sessions: this.sessions.size,
      eventLogBytes: this.eventLogBytes,
      save: this.saveState,
    };
  }

  installOperatorClaim(claim: { token: string; expiresAt: string }): void {
    this.pendingClaim = claim;
  }

  // -------------------------------------------------------------------------------------------
  // Transport lifecycle
  // -------------------------------------------------------------------------------------------

  /**
   * Admission. Identity is minted here, so a client can never present its own pilot id, and a
   * repeat handshake on one connection is rejected rather than refilling a seat. Before the
   * operator claim only a loopback address is admitted, which keeps eight early guests from taking
   * the operator's seat (B2).
   */
  hello(socket: RoomSocket, info: RoomSocketInfo, request: HelloRequest): void {
    if (this.byConnection.has(socket.connectionId)) {
      this.reject(socket, 'already-processed', 'one handshake per connection');
      return;
    }
    if (request.protocol !== RELEASE.protocol || request.contentVersion !== RELEASE.contentVersion) {
      // An incompatible build is refused before it can allocate a seat; only this case reloads.
      this.reject(socket, 'incompatible', `host speaks ${RELEASE.protocol}/${RELEASE.contentVersion}`);
      return;
    }
    const name = displayName(request.name);
    if (!name.ok) {
      this.reject(socket, 'denied', `bad name: ${name.code}`);
      return;
    }
    const tokenHash = request.resumeToken === null ? null : hashToken(request.resumeToken);
    const resumedPilot = tokenHash === null ? undefined : this.resumeIndex.get(tokenHash);
    if (resumedPilot !== undefined) {
      const resumed = this.sessions.get(resumedPilot);
      if (resumed) {
        this.resumeSession(resumed, name.value, info, socket);
        return;
      }
      this.resumeIndex.delete(tokenHash!);
    }
    if (this.resolved.operatorRequired && !this.claimedOperator && !isLoopback(info.remoteAddress)) {
      this.reject(socket, 'join-closed', 'Host preparing room');
      return;
    }
    this.admit(name.value, info, socket, request);
  }

  private admit(name: string, info: RoomSocketInfo, socket: RoomSocket, request: HelloRequest): void {
    if (this.lobby.joinPolicy === 'closed') {
      this.reject(socket, 'join-closed', 'room closed');
      return;
    }
    if (this.lobby.joinPolicy === 'code' && this.lobby.roomCode !== null && request.roomCode !== this.lobby.roomCode) {
      this.reject(socket, 'bad-code', 'room code required');
      return;
    }
    const pilotId = `p${this.nextPilot}`;
    const opened = join(this.lobby, { pilotId, name, generation: socket.connectionId });
    if (!opened.ok) {
      this.reject(socket, opened.code, opened.message ?? opened.code);
      return;
    }
    this.nextPilot += 1;
    const session = this.newSession(pilotId, info, socket);
    this.sendWelcome(session);
    this.publishLobby();
    this.sendMeta(session);
    this.logEvent('roster', { reason: 'join', pilotId, revision: this.lobby.revision });
  }

  private resumeSession(session: Session, name: string, info: RoomSocketInfo, socket: RoomSocket): void {
    // A fresh authenticated generation replaces the old socket. The session stores its current
    // connection id, so the superseded socket's close cannot delete the new one (B2).
    if (session.socket.open) session.socket.close(CLOSE.superseded, 'superseded');
    session.socket = socket;
    session.generation += 1;
    session.remoteAddress = info.remoteAddress;
    session.origin = info.origin;
    session.graceEndsAtTick = null;
    session.lastSeenTick = this.roomTick;
    session.needBaseline = this.world !== null;
    session.eventCursor = this.eventLog.length;
    session.unsentSnapshot = null;
    session.pendingCritical.length = 0;
    session.pendingCriticalBytes = 0;
    session.socketBufferedBytes = 0;
    session.pendingBaseline = null;
    this.byConnection.set(socket.connectionId, session);
    const seat = seatFor(this.lobby, session.pilotId);
    if (seat) {
      seat.connectionGeneration = socket.connectionId;
      if (seat.name !== name) setPilot(this.lobby, session.pilotId, { name });
    }
    notePresence(this.lobby, session.pilotId, 'connected');
    session.previousTokenHash = session.tokenHash;
    session.previousTokenExpiresAt = this.roomTick + RULES.previousTokenGraceS * RELEASE.physicsHz;
    this.sendWelcome(session);
    this.publishLobby();
    this.sendMeta(session);
    this.logEvent('roster', { reason: 'reconnect', pilotId: session.pilotId, revision: this.lobby.revision });
  }

  private newSession(pilotId: Id, info: RoomSocketInfo, socket: RoomSocket): Session {
    const session: Session = {
      sessionId: `s${this.nextSession++}`,
      pilotId,
      generation: 1,
      socket,
      remoteAddress: info.remoteAddress,
      origin: info.origin,
      operator: false,
      order: this.nextOrder++,
      tokenHash: '',
      previousTokenHash: null,
      previousTokenExpiresAt: 0,
      table: new StringTable(),
      deliverySeq: 0,
      eventCursor: this.eventLog.length,
      receipts: new Map(),
      expiredReceipts: new Set(),
      lastCommandSeq: 0,
      unsentSnapshot: null,
      pendingCritical: [],
      pendingCriticalBytes: 0,
      socketBufferedBytes: 0,
      congestedSinceTick: null,
      pendingBaseline: null,
      needBaseline: false,
      lastSeenTick: this.roomTick,
      graceEndsAtTick: null,
    };
    this.sessions.set(pilotId, session);
    this.byConnection.set(socket.connectionId, session);
    this.mintToken(session);
    return session;
  }

  private sendWelcome(session: Session): void {
    const token = this.mintToken(session);
    session.socket.sendControl({
      t: 'welcome',
      protocol: RELEASE.protocol,
      contentVersion: RELEASE.contentVersion,
      // `epoch` is a string in the contract; before launch it names the lobby, and the client only
      // asks for a baseline outside the lobby.
      epoch: this.epoch ?? 'lobby',
      tick: this.worldTick,
      pilotId: session.pilotId,
      sessionId: session.sessionId,
      resumeToken: token,
      generation: session.generation,
      phase: this.phase,
      host: this.info(),
      seat: seatFor(this.lobby, session.pilotId)?.seat ?? -1,
    });
    if (this.world !== null) this.beginBaseline(session);
  }

  private mintToken(session: Session): string {
    const token = randomToken();
    session.tokenHash = hashToken(token);
    this.resumeIndex.set(session.tokenHash, session.pilotId);
    return token;
  }

  detach(connectionId: number): void {
    const session = this.byConnection.get(connectionId);
    if (!session || session.socket.connectionId !== connectionId) return;
    this.byConnection.delete(connectionId);
    session.unsentSnapshot = null;
    session.pendingCritical.length = 0;
    session.pendingCriticalBytes = 0;
    session.pendingBaseline = null;
    session.socketBufferedBytes = 0;
    if (this.world) releaseInput(this.world, session.pilotId);
    notePresence(this.lobby, session.pilotId, 'reconnecting');
    session.graceEndsAtTick = this.roomTick + RULES.reconnectSeconds * RELEASE.physicsHz;
    this.transferCaptainIf(session.pilotId);
    this.publishLobby();
    this.logEvent('roster', { reason: 'seat', pilotId: session.pilotId, revision: this.lobby.revision });
  }

  /** Explicit leave forfeits the grace window; the body leaves the world immediately. */
  leave(socket: RoomSocket): void {
    const session = this.byConnection.get(socket.connectionId);
    if (session) this.dropSession(session.pilotId);
  }

  private dropSession(pilotId: Id): void {
    const session = this.sessions.get(pilotId);
    if (!session) return;
    if (this.byConnection.get(session.socket.connectionId) === session) this.byConnection.delete(session.socket.connectionId);
    if (session.socket.open) session.socket.close(CLOSE.normal, 'shutdown');
    this.removePilotFromWorld(pilotId);
    leave(this.lobby, pilotId);
    this.sessions.delete(pilotId);
    for (const [hash, owner] of this.resumeIndex) if (owner === pilotId) this.resumeIndex.delete(hash);
    this.publishLobby();
    this.logEvent('roster', { reason: 'leave', pilotId, revision: this.lobby.revision });
  }

  private removePilotFromWorld(pilotId: Id): void {
    const world = this.world;
    if (!world) return;
    const pilot = world.ships.get(pilotId);
    if (!pilot) return;
    const body = bodyOf(world, pilot.bodyId);
    this.logEvent('life', {
      lifeId: pilot.lifeId,
      shipId: `ship:${pilotId}`,
      pilotId,
      life: 'destroyed',
      position: body?.position ?? { x: 0, y: 0 },
      respawnAtTick: null,
    });
    removePilot(world, pilotId);
  }

  private transferCaptainIf(pilotId: Id): void {
    if (this.lobby.captainId !== pilotId) return;
    let oldest: Session | null = null;
    for (const session of this.sessions.values()) {
      if (!session.socket.open || session.pilotId === pilotId) continue;
      const seat = seatFor(this.lobby, session.pilotId);
      if (!seat || seat.isBot) continue;
      if (!oldest || session.order < oldest.order) oldest = session;
    }
    if (!oldest) return;
    this.lobby.captainId = oldest.pilotId;
    this.lobby.revision += 1;
    this.logEvent('roster', { reason: 'captain', pilotId: oldest.pilotId, revision: this.lobby.revision });
  }

  // -------------------------------------------------------------------------------------------
  // Operator claim and shutdown
  // -------------------------------------------------------------------------------------------

  /**
   * One-use, loopback-only operator claim (B2). A remote loopback address is required on top of the
   * Origin check the transport already performed; `Host: localhost` alone is not evidence. The claim
   * is consumed here, so the same token can never be replayed; a fresh claim for operator reclaim is
   * minted only by the authenticated loopback admin route.
   */
  claimOperator(socket: RoomSocket, token: string): boolean {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || session.socket.connectionId !== socket.connectionId) return false;
    if (!isLoopback(session.remoteAddress)) return false;
    const claim = this.pendingClaim;
    if (!claim || claim.token !== token) return false;
    if (Date.parse(claim.expiresAt) <= this.now()) return false;
    this.pendingClaim = null;
    this.claimedOperator = true;
    session.operator = true;
    if (!seatFor(this.lobby, session.pilotId)) {
      join(this.lobby, { pilotId: session.pilotId, name: this.resolved.hostName, generation: session.generation });
      this.sendMeta(session);
    }
    this.lobby.captainId = session.pilotId;
    this.lobby.revision += 1;
    this.publishLobby();
    this.logEvent('roster', { reason: 'captain', pilotId: session.pilotId, revision: this.lobby.revision });
    return true;
  }

  /** Authenticated loopback shutdown waits for a save acknowledgement (B2/B3). */
  async shutdown(): Promise<{ ok: boolean; saved: boolean }> {
    const saved = await this.saveNow();
    this.closed = true;
    this.stopLoop();
    for (const session of this.sessions.values()) {
      if (!session.socket.open) continue;
      session.socket.sendControl({ t: 'goodbye', code: 'ok', reason: 'shutdown' });
      session.socket.close(CLOSE.shuttingDown, 'shutdown');
    }
    return { ok: saved, saved };
  }

  // -------------------------------------------------------------------------------------------
  // Message intake
  // -------------------------------------------------------------------------------------------

  command(socket: RoomSocket, requestId: Id, raw: unknown): CommandResult {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || session.socket.connectionId !== socket.connectionId) {
      // A connection that never completed a handshake owns no pilot, so it owns no mutation. It
      // still gets an answer instead of a command that never resolves.
      const denial: CommandResult = { requestId, ok: false, code: 'denied', message: 'no session' };
      socket.sendControl({ t: 'command-result', result: denial });
      return denial;
    }
    session.lastSeenTick = this.roomTick;
    const cached = session.receipts.get(requestId);
    if (cached) return cached.result;
    if (session.expiredReceipts.has(requestId)) {
      return this.recordReceipt(session, requestId, { requestId, ok: false, code: 'receipt-expired' });
    }
    const parsed = validateCommand(raw);
    if (!parsed.ok) {
      return this.recordReceipt(session, requestId, { requestId, ok: false, code: 'denied', message: `${parsed.code}:${parsed.detail}` });
    }
    // Each mutation carries a monotonic per-session sequence; a sequence already outside the
    // retained window is rejected as expired rather than replayed (B3).
    const outcome = this.applyCommand(session, parsed.value);
    return this.recordReceipt(session, requestId, { requestId, ...outcome });
  }

  private recordReceipt(session: Session, requestId: Id, result: CommandResult): CommandResult {
    session.receipts.set(requestId, { result, atMs: this.now() });
    this.pruneReceipts(session);
    session.socket.sendControl({ t: 'command-result', result });
    return result;
  }

  private pruneReceipts(session: Session): void {
    const cutoff = this.now() - this.receiptRetentionMs;
    for (const [id, receipt] of session.receipts) {
      if (receipt.atMs <= cutoff) {
        session.receipts.delete(id);
        this.markExpired(session, id);
      }
    }
    if (session.receipts.size <= RULES.maxReceipts) return;
    const ordered = [...session.receipts.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
    const excess = ordered.length - RULES.maxReceipts;
    for (let index = 0; index < excess; index++) {
      const [id] = ordered[index]!;
      session.receipts.delete(id);
      this.markExpired(session, id);
    }
  }

  private markExpired(session: Session, requestId: Id): void {
    session.expiredReceipts.add(requestId);
    if (session.expiredReceipts.size > RULES.maxReceipts) {
      const oldest = session.expiredReceipts.values().next().value;
      if (oldest !== undefined) session.expiredReceipts.delete(oldest);
    }
  }

  input(socket: RoomSocket, raw: unknown): InputReceipt | null {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || session.socket.connectionId !== socket.connectionId) return null;
    session.lastSeenTick = this.roomTick;
    const pilot = this.world?.ships.get(session.pilotId);
    if (!this.world || !pilot) return null;
    const parsed = parseInputFrame(raw, this.epoch, pilot.lifeId);
    if (!parsed.ok) return { seq: 0, result: 'invalid' };
    const receipt = applyInput(this.world, session.pilotId, parsed.value);
    session.socket.sendControl({ t: 'receipt', receipt });
    return receipt;
  }

  release(socket: RoomSocket): void {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || !this.world) return;
    releaseInput(this.world, session.pilotId);
  }

  ping(socket: RoomSocket, nonce: number, clientTimeMs: number): void {
    const session = this.byConnection.get(socket.connectionId);
    if (!session) return;
    session.lastSeenTick = this.roomTick;
    session.socket.sendControl({ t: 'pong', nonce, clientTimeMs, tick: this.worldTick, serverTimeMs: this.now() });
  }

  /** Client-initiated baseline (late join, epoch change, recovery) — one per two seconds. */
  requestBaseline(socket: RoomSocket): boolean {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || this.world === null || !session.socket.open) return false;
    this.beginBaseline(session);
    return true;
  }

  /**
   * Verified install notice. The client adapter installs and carries on without sending this, so
   * the room never blocks a phase on it; when it does arrive it shortens recovery by forcing a
   * full-body snapshot immediately instead of waiting for the next rock tick.
   */
  baselineReady(socket: RoomSocket, transferId: Id, verified: boolean): boolean {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || session.socket.connectionId !== socket.connectionId) return false;
    const pending = session.pendingBaseline;
    if (!pending || pending.transferId !== transferId || !verified) return false;
    session.needBaseline = false;
    this.flushEvents(session);
    this.queueSnapshot(session, true);
    return true;
  }

  /** Bun is ready for more bytes again, so the replaced snapshot can go out. */
  drain(socket: RoomSocket): void {
    const session = this.byConnection.get(socket.connectionId);
    if (!session || session.socket.connectionId !== socket.connectionId) return;
    session.socketBufferedBytes = 0;
    session.congestedSinceTick = null;
    this.flushCritical(session);
    this.flushSnapshot(session);
  }

  private reject(socket: RoomSocket, code: CommandCode, message: string): void {
    socket.sendControl({ t: 'reject', code, message });
    socket.close(CLOSE.rejected, 'rejected');
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  private applyCommand(session: Session, command: Command): { ok: boolean; code: CommandCode; revision?: number; message?: string } {
    const pilotId = session.pilotId;
    switch (command.kind) {
      case 'edit-lobby': {
        const stale = this.checkRevision(command.expectedRevision);
        if (stale) return stale;
        if (this.phase !== 'lobby') return { ok: false, code: 'wrong-phase' };
        const result = editLobby(this.lobby, pilotId, command.patch);
        if (result.ok) this.publishLobby();
        return result;
      }
      case 'set-pilot': {
        const stale = this.checkRevision(command.expectedRevision);
        if (stale) return stale;
        if (this.phase !== 'lobby' && command.fit !== undefined) return { ok: false, code: 'wrong-phase', message: 'fit is locked after deploy' };
        const result = setPilot(this.lobby, pilotId, {
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.teamId !== undefined ? { teamId: command.teamId } : {}),
          ...(command.fit !== undefined ? { fit: command.fit } : {}),
        });
        if (result.ok) this.publishLobby();
        return result;
      }
      case 'ready': {
        const stale = this.checkRevision(command.expectedRevision);
        if (stale) return stale;
        if (this.phase !== 'lobby') return { ok: false, code: 'wrong-phase' };
        const result = setReady(this.lobby, pilotId, command.ready);
        if (result.ok) this.publishLobby();
        return result;
      }
      case 'start': {
        const stale = this.checkRevision(command.expectedRevision);
        if (stale) return stale;
        if (this.phase !== 'lobby') return { ok: false, code: 'wrong-phase' };
        if (this.lobby.captainId !== pilotId) return { ok: false, code: 'not-captain' };
        const check = startCheck(this.lobby, pilotId);
        if (!check.ok) return { ok: false, code: 'denied', message: check.blockers.join('; ') };
        this.launch();
        return { ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'bot-fill': {
        const stale = this.checkRevision(command.expectedRevision);
        if (stale) return stale;
        if (this.phase !== 'lobby') return { ok: false, code: 'wrong-phase' };
        const result = setBotFill(this.lobby, pilotId, command.total, command.difficulty);
        if (result.ok) this.publishLobby();
        return result;
      }
      case 'captain': {
        const stale = this.checkRevision(command.expectedRevision);
        if (stale) return stale;
        const result = command.action === 'transfer'
          ? transferCaptain(this.lobby, pilotId, command.pilotId)
          : removeSeat(this.lobby, pilotId, command.pilotId);
        if (result.ok) {
          if (command.action === 'remove-seat') this.dropSession(command.pilotId);
          else this.publishLobby();
        }
        return result;
      }
      case 'return-lobby': {
        if (this.lobby.captainId !== pilotId) return { ok: false, code: 'not-captain' };
        if (this.phase !== 'debrief') return { ok: false, code: 'wrong-phase' };
        this.returnToLobby();
        return { ok: true, code: 'ok' };
      }
      case 'leave': {
        this.dropSession(pilotId);
        return { ok: true, code: 'ok' };
      }
      case 'reload': {
        const world = this.world;
        const pilot = world?.ships.get(pilotId);
        if (!world || !pilot) return { ok: false, code: 'wrong-phase' };
        const weapon = pilot.weapons.find(candidate => candidate.slotId === command.slotId);
        if (!weapon) return { ok: false, code: 'denied', message: 'no such slot' };
        if (!beginReload(weapon, world.tick)) return { ok: false, code: 'denied', message: 'nothing to reload' };
        return { ok: true, code: 'ok' };
      }
      case 'sensor-mode': {
        const pilot = this.world?.ships.get(pilotId);
        if (!pilot) return { ok: false, code: 'wrong-phase' };
        pilot.scanning = command.mode === 'active';
        return { ok: true, code: 'ok' };
      }
      case 'vote': {
        if (!this.campaignSource) return { ok: false, code: 'unsupported', message: 'no decision is open' };
        const outcome = this.campaignSource.commitDecision(command.decisionId, command.optionId);
        return outcome.committed ? { ok: true, code: 'ok' } : { ok: false, code: 'unsupported', message: outcome.code };
      }
      case 'extraction': {
        if (this.lobby.mode !== 'campaign' || (this.phase !== 'live' && this.phase !== 'extraction')) return { ok: false, code: 'wrong-phase' };
        if (this.lobby.captainId !== pilotId) return { ok: false, code: 'not-captain' };
        if (command.action === 'cancel') {
          this.phase = 'live';
          this.phaseEndsAtTick = null;
          if (this.world) this.world.phase = 'live';
          this.sendMeta(session);
          return { ok: true, code: 'ok' };
        }
        if (command.action === 'confirm') {
          void this.settle();
          return { ok: true, code: 'ok' };
        }
        this.phase = 'extraction';
        this.phaseEndsAtTick = this.roomTick + RULES.extractionSeconds * RELEASE.physicsHz;
        if (this.world) this.world.phase = 'extraction';
        this.broadcastMeta();
        return { ok: true, code: 'ok' };
      }
      case 'utility': {
        if (!this.world) return { ok: false, code: 'wrong-phase' };
        const outcome = applyUtility(this.world, pilotId, command.slotId, command.targetId, command.active);
        return { ok: outcome.ok, code: outcome.ok ? 'ok' : 'denied' };
      }
      case 'crew-order': {
        if (!this.world) return { ok: false, code: 'wrong-phase' };
        return applyCrewOrder(this.world, pilotId, command.order, command.contactId)
          ? { ok: true, code: 'ok' }
          : { ok: false, code: 'denied' };
      }
      case 'request-respawn': {
        if (!this.world) return { ok: false, code: 'wrong-phase' };
        return requestRespawn(this.world, pilotId) ? { ok: true, code: 'ok' } : { ok: false, code: 'wrong-phase' };
      }
      case 'interact': {
        if (!this.world || !this.campaignSource) return { ok: false, code: 'unsupported' };
        const resolved = this.campaignSource.resolve(command.entityId);
        if (!resolved) return { ok: false, code: 'denied', message: 'nothing to interact with' };
        const seated = seatFor(this.lobby, pilotId);
        // A client names the objective, not the individual core: the room picks the nearest free item
        // and the campaign runtime still decides whether that reading is close or slow enough.
        let itemId = resolved.itemId;
        if (itemId === null && this.world.mission) {
          const body = bodyOf(this.world, this.world.ships.get(pilotId)?.bodyId ?? -1);
          itemId = nearestFreeItem(this.world.mission, resolved.objectiveId, body?.position ?? { x: 0, y: 0 })?.id ?? null;
        }
        const facts = interactFacts(this.world, pilotId, resolved.objectiveId, itemId);
        if (!facts) return { ok: false, code: 'wrong-phase' };
        const outcome = this.campaignSource.interact({
          pilotId,
          isBot: seated?.isBot ?? false,
          objectiveId: resolved.objectiveId,
          itemId,
          tick: this.worldTick,
          facts,
        });
        // The campaign decides whether this *counts*; the room decides where the item physically is.
        // An item that was already counted is still pick-up-able, or an archive lost in space could
        // never be carried home again, and the pilot would see a failure for a real pickup.
        if (itemId !== null && (outcome.code === 'ok' || outcome.code === 'already-recovered')) {
          recoverItem(this.world, pilotId, itemId);
        } else if (!outcome.accepted) {
          return { ok: false, code: 'denied', message: outcome.code };
        }
        this.interactions.set(pilotId, { objectiveId: resolved.objectiveId, itemId });
        this.publishObjectivesIfChanged();
        return { ok: true, code: 'ok' };
      }
      case 'recovery':
      case 'inventory':
        // Campaign recovery costs and the economy live with the persistent campaign, which the
        // launcher wires; the room refuses rather than inventing their rules.
        return { ok: false, code: 'unsupported' };
    }
  }

  private checkRevision(expected: number): { ok: false; code: CommandCode; revision: number } | null {
    return expected === this.lobby.revision ? null : { ok: false, code: 'stale-revision', revision: this.lobby.revision };
  }

  // -------------------------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------------------------

  private launch(): void {
    this.epochCounter += 1;
    this.epoch = `${this.roomId}-e${this.epochCounter}`;
    const teams = this.lobby.mode === 'team-deathmatch' ? PVP_TEAMS : [TEAM_CREW, TEAM_HOSTILE];
    this.world = createWorld({
      epoch: this.epoch,
      mode: this.lobby.mode,
      mapId: this.lobby.mapId,
      seed: this.seed,
      matchSeconds: this.resolved.matchSeconds,
      teams,
    });
    for (const seat of this.lobby.seats) {
      if (!seat) continue;
      addPilot(this.world, { pilotId: seat.pilotId, name: seat.name, teamId: seat.teamId, fit: seat.fit, isBot: seat.isBot });
      noteLife(this.lobby, seat.pilotId, 'alive');
    }
    if (this.lobby.mode === 'campaign') {
      const mission = missionDefinition(this.lobby.missionId ?? CAMPAIGN_MISSIONS[0]!.id);
      if (mission) createMission(this.world, mission);
    }
    this.phase = 'loading';
    this.phaseEndsAtTick = this.roomTick + RULES.loadingDeadlineS * RELEASE.physicsHz;
    this.world.phase = 'loading';
    this.resultReceipt = null;
    this.debrief = null;
    this.eventLog.length = 0;
    this.eventLogBytes = 0;
    for (const session of this.sessions.values()) {
      session.eventCursor = 0;
      session.deliverySeq = 0;
      session.pendingBaseline = null;
      session.unsentSnapshot = null;
      session.pendingCritical.length = 0;
      session.pendingCriticalBytes = 0;
      session.needBaseline = session.socket.open;
      // The connection's string table is not reset here: the baseline is a delta from whatever the
      // two sides already share, and a fresh session starts cold on both sides anyway.
      if (session.needBaseline) this.beginBaseline(session);
    }
    this.publishLobby();
    this.broadcastMeta();
  }

  private async settle(): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    this.phase = 'settlement';
    this.phaseEndsAtTick = null;
    if (this.world) {
      this.world.phase = 'settlement';
      releaseAll(this.world);
    }
    this.resultReceipt = `${this.epoch}:result`;
    this.debrief = this.buildDebrief();
    this.broadcastMeta();
    await this.saveNow();
    this.phase = 'debrief';
    this.settling = false;
    this.broadcastMeta();
  }

  private returnToLobby(): void {
    this.world = null;
    this.epoch = null;
    this.phase = 'lobby';
    this.phaseEndsAtTick = null;
    for (const seat of this.lobby.seats) {
      if (!seat) continue;
      seat.life = 'staged';
      seat.readyAtRevision = null;
    }
    this.lobby.revision += 1;
    this.debrief = null;
    this.resultReceipt = null;
    this.saveState = 'clean';
    this.publishLobby();
    this.broadcastMeta();
  }

  private buildDebrief(): DebriefView {
    const world = this.world;
    const result = world?.result ?? null;
    const pilots: DebriefView['pilots'] = world
      ? [...world.ledger.tallies.values()].map(tally => ({
        pilotId: tally.pilotId,
        name: tally.name,
        teamId: tally.teamId,
        kills: tally.kills,
        assists: tally.assists,
        deaths: tally.deaths,
        departed: tally.departed,
      }))
      : [];
    const settlement = this.lobby.mode === 'campaign' ? this.campaignSource?.settlement() ?? null : null;
    return {
      resultId: this.resultReceipt ?? `${this.epoch}:result`,
      outcome: result?.outcome ?? (this.lobby.mode === 'campaign' ? 'mission-complete' : 'no-contest'),
      winningTeamId: result?.winningTeamId ?? null,
      rewardCredits: settlement?.rewardCredits ?? 0,
      repairCredits: 0,
      receiptId: settlement?.receiptId ?? this.resultReceipt,
      nextMissionId: settlement?.nextMissionId ?? null,
      pilots,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Fixed-step loop
  // -------------------------------------------------------------------------------------------

  startLoop(): void {
    if (this.closed || this.loopTimer !== null) return;
    this.loopLastMs = this.now();
    const stepMs = 1000 / RELEASE.physicsHz;
    const schedule = (): void => {
      if (this.closed) return;
      this.loopTimer = setTimeout(() => {
        const now = this.now();
        const due = Math.floor((now - this.loopLastMs) / stepMs);
        if (due <= 0) {
          schedule();
          return;
        }
        const steps = Math.min(due, MAX_CATCH_UP_STEPS);
        if (due > MAX_CATCH_UP_STEPS) {
          // Overload slows simulation time; the timestep itself never grows (B4).
          this.overloadLoops += 1;
          this.loopLastMs = now;
        } else {
          this.loopLastMs += steps * stepMs;
        }
        this.caughtUpSteps += steps;
        this.advance(steps);
        schedule();
      }, 1);
    };
    schedule();
  }

  stopLoop(): void {
    if (this.loopTimer !== null) clearTimeout(this.loopTimer);
    this.loopTimer = null;
  }

  /** Runs `steps` authority steps. The loop and the tests use the same entry point. */
  advance(steps: number): void {
    for (let index = 0; index < steps; index++) this.stepOnce();
  }

  /**
   * Sustained campaign work (B8): while a pilot holds an interaction the room keeps measuring and the
   * campaign keeps deciding. An engagement ends when the pilot dies, leaves the objective's reach, or
   * the objective stops being active; nothing here is guessed.
   */
  private feedInteractions(): void {
    if (this.interactions.size === 0) return;
    const world = this.world;
    const source = this.campaignSource;
    if (!world || !source) {
      this.interactions.clear();
      return;
    }
    for (const [pilotId, engagement] of [...this.interactions]) {
      const pilot = world.ships.get(pilotId);
      if (!pilot || pilot.life !== 'alive') {
        this.interactions.delete(pilotId);
        continue;
      }
      const facts = interactFacts(world, pilotId, engagement.objectiveId, engagement.itemId);
      if (!facts) {
        this.interactions.delete(pilotId);
        continue;
      }
      const outcome = source.observe({
        pilotId,
        isBot: seatFor(this.lobby, pilotId)?.isBot ?? false,
        objectiveId: engagement.objectiveId,
        itemId: engagement.itemId,
        tick: this.worldTick,
        facts,
      });
      const active = source.viewObjectives().some(objective => objective.id === engagement.objectiveId && objective.state === 'active');
      if (!outcome.accepted && !active) this.interactions.delete(pilotId);
      else if (engagement.itemId !== null && (outcome.code === 'ok' || outcome.code === 'already-recovered')) {
        recoverItem(world, pilotId, engagement.itemId);
      }
    }
  }

  /**
   * Publish objective progress when it moves. The signature is a small integer over the visible
   * state, which is enough to notice a completion, a failure or a counted item.
   */
  private publishObjectivesIfChanged(): void {
    if (!this.campaignSource) return;
    const objectives = this.campaignSource.viewObjectives();
    let signature = objectives.length * 31;
    for (const objective of objectives) {
      signature = (Math.imul(signature, 33) + objective.state.length * 7 + objective.completed * 3 + objective.required) | 0;
    }
    if (signature === this.objectivesSignature) return;
    this.objectivesSignature = signature;
    this.broadcastMeta();
  }

  private stepOnce(): void {
    this.roomTick += 1;
    if (this.phase === 'live' || this.phase === 'extraction') {
      stepWorld(this.world!);
      this.drainWorldEvents();
      this.feedInteractions();
      this.campaignSource?.advance(this.worldTick);
      // Objective progress rides the view, so a completion (or a timed hold finishing) has to be
      // published; checked a few times a second rather than every tick to keep the loop allocation-free.
      if (this.roomTick % 6 === 0) this.publishObjectivesIfChanged();
      if (this.phase === 'live' && this.world?.result) {
        void this.settle();
      } else if (this.phase === 'extraction' && this.phaseEndsAtTick !== null && this.roomTick >= this.phaseEndsAtTick) {
        void this.settle();
      } else if (this.sessions.size === 0) {
        // Every human is gone (reservations already expired), so the room checkpoints and stops
        // rather than simulating an arena nobody is watching. Bots live only as seats; they never
        // hold a session, so an all-bot field is an empty room too.
        void this.settle();
      }
    } else if (this.phase === 'loading') {
      if (this.loadingComplete() || (this.phaseEndsAtTick !== null && this.roomTick >= this.phaseEndsAtTick)) {
        this.phase = 'countdown';
        this.phaseEndsAtTick = this.roomTick + RULES.countdownSeconds * RELEASE.physicsHz;
        if (this.world) {
          this.world.phase = 'countdown';
          releaseAll(this.world);
        }
        this.broadcastMeta();
      }
    } else if (this.phase === 'countdown' && this.phaseEndsAtTick !== null && this.roomTick >= this.phaseEndsAtTick) {
      this.phase = 'live';
      this.phaseEndsAtTick = null;
      if (this.world) this.world.phase = 'live';
      this.broadcastMeta();
    }
    this.expireReservations();
    // Ship state only exists once the match is running; a lobby or a countdown has nothing to send.
    if ((this.phase === 'live' || this.phase === 'extraction') && this.roomTick % this.snapshotInterval === 0) {
      this.broadcastSnapshot();
    }
    if (this.roomTick % 240 === 0) this.checkStale();
    if (this.roomTick % 120 === 0) this.broadcastMeta();
  }

  /** A baseline is complete once every connected session has received its frames. */
  private loadingComplete(): boolean {
    for (const session of this.sessions.values()) {
      if (session.socket.open && session.needBaseline) return false;
    }
    return true;
  }

  private drainWorldEvents(): void {
    const world = this.world;
    if (!world || world.events.length === 0) return;
    for (const event of world.events) this.logEvent(event.kind, event.payload);
    world.events.length = 0;
  }

  private checkStale(): void {
    for (const session of this.sessions.values()) {
      if (this.roomTick - session.lastSeenTick <= this.staleTicks) continue;
      this.detach(session.socket.connectionId);
    }
  }

  private expireReservations(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.graceEndsAtTick === null || session.graceEndsAtTick > this.roomTick) continue;
      this.logEvent('notice', { code: 'disconnect-grace', message: `${session.pilotId} abandoned`, forPilotId: null });
      this.dropSession(session.pilotId);
    }
    for (const [hash, pilotId] of [...this.resumeIndex]) {
      const session = this.sessions.get(pilotId);
      if (!session || (hash === session.previousTokenHash && session.previousTokenExpiresAt < this.roomTick)) {
        this.resumeIndex.delete(hash);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots, events and baselines
  // -------------------------------------------------------------------------------------------

  private broadcastSnapshot(): void {
    for (const session of this.sessions.values()) {
      this.queueSnapshot(session, false);
      this.flushEvents(session);
    }
  }

  private queueSnapshot(session: Session, forceBodies: boolean): void {
    if (!session.socket.open || !this.world || session.needBaseline) return;
    if (session.congestedSinceTick !== null && this.roomTick - session.congestedSinceTick > 2 * RELEASE.physicsHz) {
      // Over two seconds of congestion is not a hiccup; the client is closed with a typed reason.
      session.socket.close(CLOSE.slowClient, 'slow-client');
      this.detach(session.socket.connectionId);
      return;
    }
    const includeBodies = forceBodies || this.roomTick % this.rockInterval === 0;
    try {
      session.unsentSnapshot = encodeSnapshot(this.buildSnapshot(session, includeBodies), session.table);
    } catch {
      // A frame that would break a decoder cap means this connection's table drifted; restart it
      // from a verified baseline rather than sending a frame the peer must reject.
      this.beginBaseline(session);
      return;
    }
    this.flushSnapshot(session);
  }

  private flushSnapshot(session: Session): void {
    if (!session.socket.open || session.unsentSnapshot === null || session.socketBufferedBytes > 0) return;
    const bytes = session.unsentSnapshot;
    session.unsentSnapshot = null;
    const status = session.socket.sendBinary(bytes);
    if (status === -1) {
      // Bun already queued bytes it will not let us replace; stop sending until `drain`.
      session.socketBufferedBytes += bytes.length;
      if (session.congestedSinceTick === null) session.congestedSinceTick = this.roomTick;
      session.unsentSnapshot = bytes;
      return;
    }
    if (status === 0 || session.socketBufferedBytes + bytes.length > RULES.socketBufferBytes) {
      session.socket.close(CLOSE.slowClient, 'slow-client-buffer');
      this.detach(session.socket.connectionId);
    }
  }

  private flushCritical(session: Session): void {
    if (!session.socket.open) return;
    while (session.pendingCritical.length > 0) {
      const bytes = session.pendingCritical[0]!;
      const status = session.socket.sendBinary(bytes);
      if (status === -1) return;
      session.pendingCritical.shift();
      session.pendingCriticalBytes -= bytes.length;
      if (status === 0) {
        session.socket.close(CLOSE.slowClient, 'slow-client-buffer');
        this.detach(session.socket.connectionId);
        return;
      }
    }
  }

  private pushCritical(session: Session, bytes: Uint8Array): void {
    if (!session.socket.open) return;
    if (session.pendingCriticalBytes + bytes.length > RULES.snapshotBacklogBytes) {
      // Critical backlog is bounded; a client that cannot keep up loses its baseline and resyncs.
      session.pendingCritical.length = 0;
      session.pendingCriticalBytes = 0;
      session.pendingBaseline = null;
      session.needBaseline = true;
      session.socket.close(CLOSE.slowClient, 'slow-client-buffer');
      this.detach(session.socket.connectionId);
      return;
    }
    session.pendingCritical.push(bytes);
    session.pendingCriticalBytes += bytes.length;
    if (session.socketBufferedBytes === 0) this.flushCritical(session);
  }

  private buildSnapshot(session: Session, includeBodies: boolean): Snapshot {
    const world = this.world!;
    const pilot = world.ships.get(session.pilotId) ?? null;
    const ships: ShipView[] = [];
    for (const candidate of world.ships.values()) ships.push(shipView(world, candidate));
    return {
      header: {
        codec: RELEASE.protocol,
        epoch: world.epoch,
        baselineId: this.lastBaseline ?? `${world.epoch}:b0`,
        stateSeq: this.roomTick,
        tick: world.tick,
        eventWatermark: this.eventLog.length,
        flags: 0,
      },
      self: pilot ? selfAuthority(world, pilot) : null,
      ships,
      bodies: includeBodies ? rockBodyViews(world) : [],
      projectiles: projectileViews(world),
      contacts: world.contacts.get(session.pilotId) ?? [],
      objectives: this.campaignSource?.viewObjectives() ?? EMPTY_OBJECTIVES,
      teamScores: { ...world.ledger.teamScores },
      inventoryRevision: this.lobby.revision,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------------------------

  private broadcastMeta(): void {
    for (const session of this.sessions.values()) this.sendMeta(session);
  }

  private sendMeta(session: Session): void {
    if (!session.socket.open) return;
    session.socket.sendControl({ t: 'meta', meta: this.metaFor(session) });
  }

  private metaFor(session: Session): ViewMeta {
    const world = this.world;
    return {
      phase: this.phase,
      link: 'online',
      pilotId: session.pilotId,
      epoch: this.epoch,
      tick: this.worldTick,
      lobby: lobbyView(this.lobby),
      campaign: this.campaignView(),
      host: this.hostViewFor(session),
      debrief: this.debrief,
      save: this.saveState,
      teamScores: world ? { ...world.ledger.teamScores } : {},
      objectives: this.campaignSource?.viewObjectives() ?? EMPTY_OBJECTIVES,
      respawnAtTick: world?.ships.get(session.pilotId)?.respawnAtTick ?? null,
      phaseEndsAtTick: this.phaseEndsAtTick,
      map: world === null ? null : {
        id: world.map.id,
        baselineHash: mapHashOf(world.map),
        generatorVersion: world.map.generatorVersion,
        boundsRadiusM: world.map.boundsRadiusM,
        stationIds: world.map.stationIds,
      },
      economy: null,
    };
  }

  private hostViewFor(session: Session): HostView {
    const captain = this.lobby.captainId === session.pilotId;
    return {
      isOperator: session.operator,
      guestOrigin: this.guestOrigin,
      selectedAdapter: this.selectedAdapter,
      roomCodeVisibleToCaptain: captain ? this.lobby.roomCode : null,
      canStop: session.operator,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------------------------

  private logEvent<K extends SessionEventKind>(kind: K, payload: EventPayloadByKind[K]): void {
    const epoch = this.world?.epoch ?? this.epoch ?? 'lobby';
    const eventId = `${epoch}:${this.eventLog.length}`;
    const bytes = JSON.stringify(payload)?.length ?? 0;
    this.eventLog.push({ eventId, epoch, tick: this.worldTick, kind, payload, bytes });
    this.eventLogBytes += bytes;
    this.pruneEventLog();
  }

  private pruneEventLog(): void {
    const newest = this.eventLog.length > 0 ? this.eventLog[this.eventLog.length - 1]!.tick : 0;
    while (this.eventLog.length > 0) {
      const head = this.eventLog[0]!;
      if (this.eventLogBytes <= RULES.maxReplayBytes && newest - head.tick <= RULES.replaySeconds * RELEASE.physicsHz) break;
      this.eventLog.shift();
      this.eventLogBytes -= head.bytes;
      for (const session of this.sessions.values()) if (session.eventCursor > 0) session.eventCursor -= 1;
    }
  }

  private flushEvents(session: Session): void {
    if (!session.socket.open || session.needBaseline) return;
    while (session.eventCursor < this.eventLog.length) {
      const logged = this.eventLog[session.eventCursor]!;
      session.eventCursor += 1;
      if (!eventVisibleTo(logged, session.pilotId)) continue;
      session.deliverySeq += 1;
      const event: SessionEvent = {
        deliverySeq: session.deliverySeq,
        tick: logged.tick,
        epoch: logged.epoch,
        eventId: logged.eventId,
        kind: logged.kind,
        payload: logged.payload,
      };
      session.socket.sendControl({ t: 'event', event });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Baseline transfer
  // -------------------------------------------------------------------------------------------

  private beginBaseline(session: Session): void {
    if (!this.world || !session.socket.open) return;
    session.needBaseline = true;
    session.unsentSnapshot = null;
    session.pendingCritical.length = 0;
    session.pendingCriticalBytes = 0;
    let frames: Uint8Array[];
    try {
      // Frames are interned against the connection's live table: a fresh session is cold on both
      // sides, and a resume continues the table the two sides already share.
      frames = encodeBaselineFrames(this.buildSnapshot(session, true), session.table);
    } catch {
      // More entities than the codec will hold in bounded frames; the client waits for the next
      // attempt rather than receiving a frame it must reject.
      return;
    }
    if (frames.length === 0) return;
    const transferId = payloadHash(frames);
    const totalBytes = frames.reduce((sum, frame) => sum + frame.length, 0);
    session.pendingBaseline = { transferId, tick: this.world.tick, frames: frames.length };
    session.eventCursor = this.eventLog.length;
    this.lastBaseline = transferId;
    session.socket.sendControl({
      t: 'baseline-header',
      header: {
        transferId,
        mapHash: mapHashOf(this.world.map),
        epoch: this.world.epoch,
        tick: this.world.tick,
        chunkCount: frames.length,
        totalBytes,
      },
    });
    for (const frame of frames) this.pushCritical(session, frame);
    session.socket.sendControl({ t: 'baseline-end', transferId, verified: true });
    session.needBaseline = false;
    this.flushEvents(session);
  }

  // -------------------------------------------------------------------------------------------
  // Delivery helpers
  // -------------------------------------------------------------------------------------------

  private publishLobby(): void {
    const lobby: LobbyView = lobbyView(this.lobby);
    for (const session of this.sessions.values()) session.socket.sendControl({ t: 'lobby', lobby });
  }

  // -------------------------------------------------------------------------------------------
  // Persistence: one bounded writer that coalesces periodic checkpoints
  // -------------------------------------------------------------------------------------------

  private async saveNow(): Promise<boolean> {
    if (!this.store || !this.campaignId || !this.world) {
      this.saveState = 'clean';
      return true;
    }
    const store = this.store;
    const campaignId = this.campaignId;
    const previous = this.pendingSave;
    const promise = (async (): Promise<boolean> => {
      if (previous) await previous;
      this.saveState = 'pending';
      const at = new Date(this.now()).toISOString();
      const result = await store.writeCheckpoint({ campaignId, state: this.checkpointState(), at });
      if (result.ok) {
        this.saveState = 'saved';
        this.lastSavedAt = result.value.at;
        this.logEvent('save', { state: 'saved', at: result.value.at, reason: null });
        return true;
      }
      this.saveState = 'failed';
      this.logEvent('save', { state: 'failed', at: null, reason: result.message });
      return false;
    })();
    this.pendingSave = promise;
    const saved = await promise;
    if (this.pendingSave === promise) this.pendingSave = null;
    return saved;
  }

  /** Coherent checkpoint at the current tick: no sockets, no DOM, no wall-clock timers. */
  checkpointState(): CheckpointState {
    const world = this.world!;
    const ships = [...world.ships.values()].map(pilot => {
      const body = bodyOf(world, pilot.bodyId)!;
      return {
        pilotId: pilot.pilotId,
        lifeId: pilot.lifeId,
        teamId: pilot.teamId,
        life: pilot.life,
        position: { ...body.position },
        velocity: { ...body.velocity },
        angle: body.angle,
        angularVelocity: body.angularVelocity,
        hull: pilot.hull,
        hullMax: pilot.hullMax,
        fuelKg: pilot.fuelKg,
        heatMJ: pilot.heatMJ,
        capacitorMJ: pilot.capacitorMJ,
        respawnAtTick: pilot.respawnAtTick,
        weapons: pilot.weapons.map(weapon => ({
          slotId: weapon.slotId,
          magazine: weapon.magazine,
          reserve: weapon.reserve,
          reloadEndsAtTick: weapon.reloadEndsAtTick,
          chargeFraction: weapon.chargeFraction,
          readyAtTick: weapon.readyAtTick,
        })),
        kills: pilot.score.kills,
        assists: pilot.score.assists,
        deaths: pilot.score.deaths,
      };
    });
    const rocks = rockViews(world).map(({ rock, body }) => ({
      contentId: rock.contentId,
      generation: body.generation,
      position: { ...body.position },
      velocity: { ...body.velocity },
      angle: body.angle,
      angularVelocity: body.angularVelocity,
      radiusM: rock.radiusM,
      hull: rock.hull,
      hullMax: rock.hullMax,
      splitDepth: rock.splitDepth,
      cracked: rock.cracked,
    }));
    const objectives = (this.campaignSource?.viewObjectives() ?? EMPTY_OBJECTIVES).map(objective => ({
      objectiveId: objective.id,
      state: objective.state,
      completed: objective.completed,
      required: objective.required,
    }));
    const pendingActions = [...world.ships.values()].flatMap(pilot => pilot.queued.map(frame => ({
      pilotId: pilot.pilotId,
      seq: frame.seq,
      applyAtTick: frame.applyAtTick,
      intent: frame.intent,
    })));
    return {
      tick: world.tick,
      epoch: world.epoch,
      rng: { mission: createRng(world.seed, 'mission').state(), fracture: world.fractureRng.state() },
      ships,
      rocks,
      objectives,
      pendingActions,
      baselineRevision: this.lobby.revision,
    };
  }

  /**
   * Campaign view for the client (B8/B9). Credits, inventory, mission states and recorded decisions
   * come from the host's own record, never from a second set of rules: a mission is complete when its
   * receipt exists, the next one in the chain is available, and everything after that is locked.
   */
  campaignView(): CampaignView | null {
    if (!this.campaignId) return null;
    const snapshot = this.campaign;
    const receipts = new Set((snapshot?.receipts ?? []).map(receipt => receipt.receiptId));
    let unlockedNext = false;
    const missions = CAMPAIGN_MISSIONS.map((mission, index) => {
      const complete = receipts.has(mission.receiptId);
      const previousComplete = index === 0 || receipts.has(CAMPAIGN_MISSIONS[index - 1]!.receiptId);
      const available = !complete && previousComplete && !unlockedNext;
      if (available) unlockedNext = true;
      return { id: mission.id, title: mission.title, sectorId: mission.sectorId, state: complete ? 'complete' as const : available ? 'available' as const : 'locked' as const };
    });
    return {
      id: snapshot?.campaign.id ?? this.campaignId,
      name: snapshot?.campaign.name ?? this.campaignId,
      credits: snapshot?.campaign.credits ?? 0,
      inventoryRevision: snapshot?.campaign.inventoryRevision ?? this.lobby.revision,
      inventory: (snapshot?.inventory ?? []).map(item => ({
        instanceId: item.instanceId,
        partId: item.partId,
        health: item.health,
        reservedByPilotId: item.reservedByPilotId,
      })),
      missions,
      decisions: (snapshot?.decisions ?? []).map(decision => ({ id: decision.decisionId, optionId: decision.optionId })),
      activeVote: null,
      saveOwner: 'host',
      lastSavedAt: snapshot?.campaign.lastSavedAt ?? this.lastSavedAt,
    };
  }

  /**
   * The host's campaign record, loaded once. Until it arrives the view reports zeroes rather than
   * inventing a balance, and the broadcast that follows tells the clients when it is real.
   */
  private async hydrateCampaign(): Promise<void> {
    if (!this.store || !this.campaignId || this.campaign !== null) return;
    const loaded = await this.store.loadCampaign(this.campaignId);
    if (!loaded.ok) return;
    this.campaign = loaded.value;
    this.broadcastMeta();
  }
}

// ---------------------------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------------------------

function selfAuthority(world: WorldState, pilot: PilotRuntime): SelfAuthority {
  const body = bodyOf(world, pilot.bodyId)!;
  const prediction: PredictionState = {
    tick: world.tick,
    position: { ...body.position },
    velocity: { ...body.velocity },
    angle: body.angle,
    angularVelocity: body.angularVelocity,
    fuelKg: pilot.fuelKg,
    heatMJ: pilot.heatMJ,
    capacitorMJ: pilot.capacitorMJ,
    angularAssist: pilot.activeInput?.intent.angularAssist ?? true,
  };
  const weapons: WeaponView[] = pilot.weapons.map(weapon => ({
    slotId: weapon.slotId,
    partId: weapon.partId,
    group: weapon.group,
    autoDefense: weapon.spec.behavior === 'point-defense',
    magazine: weapon.magazine,
    reserve: weapon.reserve,
    reloadEndsAtTick: weapon.reloadEndsAtTick,
    chargeFraction: weapon.chargeFraction,
    readyAtTick: weapon.readyAtTick,
    blockedReason: weapon.blockedReason,
  }));
  const derived: DerivedFit = pilot.derived;
  return {
    tick: world.tick,
    ship: shipView(world, pilot),
    derived,
    activeInput: pilot.activeInput,
    scheduledInputs: pilot.queued.filter(frame => frame.applyAtTick > world.tick),
    receivedSeq: pilot.receivedSeq,
    appliedSeq: pilot.appliedSeq,
    predictionState: prediction,
    weapons,
  };
}

function rockBodyViews(world: WorldState): BodyView[] {
  const views: BodyView[] = [];
  for (const { rock, body } of rockViews(world)) {
    views.push({
      id: rock.contentId,
      generation: body.generation,
      visualId: rock.contentId,
      renderSeed: rock.renderSeed,
      position: { ...body.position },
      velocity: { ...body.velocity },
      angle: body.angle,
      angularVelocity: body.angularVelocity,
      shape: { kind: 'circle', radiusM: rock.radiusM },
      collidable: body.collidable,
      hull: rock.hull,
      hullMax: rock.hullMax,
    });
  }
  return views;
}

function eventVisibleTo(logged: LoggedEvent, pilotId: Id): boolean {
  if (logged.kind !== 'notice' && logged.kind !== 'save') return true;
  const target = (logged.payload as { forPilotId?: Id | null }).forPilotId;
  return target === null || target === undefined || target === pilotId;
}

function parseInputFrame(value: unknown, epoch: string | null, lifeId: string | null): Result<InputFrame> {
  if (typeof value !== 'object' || value === null) return { ok: false, code: 'not-object', detail: 'input frame' };
  const frame = value as Record<string, unknown>;
  if (epoch !== null && frame.epoch !== epoch) return { ok: false, code: 'bad-id', detail: 'epoch mismatch' };
  if (typeof frame.lifeId !== 'string' || frame.lifeId.length === 0 || frame.lifeId.length > 64) {
    return { ok: false, code: 'bad-id', detail: 'life id' };
  }
  void lifeId;
  const seq = safeInteger(frame.seq, 0, 0xffffffff);
  if (!seq.ok) return seq;
  const targetTick = safeInteger(frame.targetTick, 0, 0xffffffff);
  if (!targetTick.ok) return targetTick;
  const intent = validateFlightIntent(frame.intent);
  if (!intent.ok) return intent;
  return {
    ok: true,
    value: { epoch: String(frame.epoch), lifeId: String(frame.lifeId), seq: seq.value, targetTick: targetTick.value, intent: intent.value },
  };
}

/** SHA-256 of a resume token. Tokens are never stored in the clear server-side (B3). */
export function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(token);
  return hasher.digest('hex');
}

/** ≥128 random bits, URL-safe. Rotated on every welcome. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `t${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
