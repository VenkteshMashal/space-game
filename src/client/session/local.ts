/**
 * Offline SessionPort (Plan B9, offline half of B1). The same kernel, the same DTOs and the same
 * state axes as a LAN room, but the authority lives in a Web Worker and the campaign lives in an
 * IndexedDB namespace on this device. Nothing here reaches the network: connect opens a worker, not
 * a socket, which is what makes a prepared install work on a plane.
 *
 * Two things this port refuses to pretend:
 *   - a page with no host and no durable storage (an opaque `file://` origin) cannot resume a
 *     campaign after a cold reload, so it never offers to;
 *   - a failed write blocks the campaign transition at settlement and reports `save: 'failed'`,
 *     because a debrief that claims a save that did not land is worse than a visible error.
 */

import { EMPTY_FLIGHT_INTENT, RELEASE } from '../../shared/contracts.ts';
import type {
  BodyView,
  ClientView,
  Command,
  CommandResult,
  ConnectOptions,
  DebriefView,
  EventPayloadByKind,
  FlightIntent,
  Id,
  LinkState,
  Phase,
  Screen,
  SelfAuthority,
  SessionEvent,
  SessionEventKind,
  SessionPort,
  ShipView,
  WeaponView,
} from '../../shared/contracts.ts';
import { CATALOG, defaultFit } from '../../shared/catalog.ts';
import { CAMPAIGN_START, PVP, RULES } from '../../shared/balance.ts';
import { hash32, hex8 } from '../../shared/ids.ts';
import { PVP_TEAMS, TEAM_CREW, TEAM_HOSTILE } from '../../shared/teams.ts';
import { validateCommand } from '../../shared/validate.ts';
import { evaluateResult } from '../../sim/score.ts';
import { campaignSource } from '../../sim/campaign/source.ts';
import { CAMPAIGN_MISSIONS, missionDefinition } from '../../sim/campaign/missions.ts';
import { nearestFreeItem } from '../../sim/mission.ts';
import type { CampaignSource } from '../../server/room.ts';
import { createMission, interactFacts, recoverItem, applyUtility, applyCrewOrder, requestRespawn } from '../../sim/world.ts';
import {
  addPilot,
  applyInput,
  beginMatch,
  bodyOf,
  createWorld,
  projectileViews,
  releaseInput,
  rockViews,
  shipView,
  stepWorld,
} from '../../sim/world.ts';
import type { PilotRuntime, WorldState } from '../../sim/world.ts';
import type { WeaponRuntime } from '../../sim/weapons.ts';
import {
  createLobby,
  editLobby,
  leave,
  noteLife,
  removeSeat,
  setBotFill,
  setPilot,
  setReady,
  startCheck,
  transferCaptain,
  view as lobbyView,
} from '../../sim/lobby.ts';
import type { LobbyState } from '../../sim/lobby.ts';
import type {
  CampaignRecord,
  CampaignSnapshot,
  CheckpointAction,
  CheckpointRock,
  CheckpointShip,
  CheckpointState,
  InventoryItem,
  StoredCheckpoint,
  StoredSettlement,
} from '../../server/store-port.ts';

const LOCAL_LINK_MS = 1;
const MAX_CATCH_UP = 8;
const CHECKPOINT_TICKS = 15 * RELEASE.physicsHz;
const SNAPSHOT_TICKS = 4;
const RETAINED_CHECKPOINTS = 3;

const SCREEN_BY_PHASE: Readonly<Record<Phase, Screen>> = {
  lobby: 'lobby',
  loading: 'lobby',
  countdown: 'flight',
  live: 'flight',
  extraction: 'flight',
  settlement: 'flight',
  debrief: 'debrief',
};

export type LocalReleaseReason = Parameters<SessionPort['releaseControls']>[0];

/** Where an offline campaign is stored. `auto` prefers IndexedDB and falls back to memory. */
export type OfflineStorageKind = 'auto' | 'memory';

export interface LocalSessionOptions {
  /** Storage backend; `auto` prefers IndexedDB and falls back to memory on an opaque origin. */
  storage?: OfflineStorageKind;
  /** Arena length override for a short sortie; the arena's own limit applies otherwise. */
  matchSeconds?: number;
  /** `drain` spends the whole catch-up budget every timer tick instead of pacing to wall clock. */
  pace?: 'realtime' | 'drain';
  /** Campaign to resume; null starts a fresh namespace. */
  campaignId?: Id | null;
  campaignName?: string;
}

/** The bounded campaign record the offline host round-trips through device storage. */
export interface OfflineStorage {
  readonly durable: boolean;
  load(namespace: Id): Promise<CampaignSnapshot | null>;
  save(namespace: Id, snapshot: CampaignSnapshot): Promise<void>;
  list(): Promise<readonly CampaignRecord[]>;
}

export class LocalSessionError extends Error {
  readonly code: 'unsupported' | 'aborted' | 'disposed' | 'storage' | 'worker';

  constructor(code: LocalSessionError['code'], message: string) {
    super(message);
    this.name = 'LocalSessionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Worker protocol. Every message is a plain DTO, so structured clone is the whole transport.
// ---------------------------------------------------------------------------------------------

export interface LocalConfig {
  storage: OfflineStorageKind;
  pace: 'realtime' | 'drain';
  matchSeconds: number;
  campaignId: Id | null;
  campaignName: string;
}

export type HostRequest =
  | { t: 'connect'; options: ConnectOptions; config: LocalConfig }
  | { t: 'command'; requestId: Id; command: Command }
  | { t: 'intent'; intent: FlightIntent }
  | { t: 'release'; reason: LocalReleaseReason }
  | { t: 'pause'; paused: boolean }
  | { t: 'dispose' };

export type HostReply =
  | { t: 'ready'; view: ClientView }
  | { t: 'view'; view: ClientView; events: SessionEvent[] }
  | { t: 'result'; requestId: Id; result: CommandResult }
  | { t: 'failed'; code: string; message: string };

// ---------------------------------------------------------------------------------------------
// Main-thread port
// ---------------------------------------------------------------------------------------------

/** What an unconnected adapter reports: idle link, title screen, no world. */
const DISCONNECTED_VIEW: ClientView = Object.freeze({
  phase: null, screenHint: 'title', link: 'idle', pilotId: null, epoch: null, tick: 0, lobby: null, self: null,
  ships: [], contacts: [], bodies: [], projectiles: [], weapons: [], map: null, campaign: null, host: null,
  debrief: null, teamScores: {}, objectives: [], respawnAtTick: null, phaseEndsAtTick: null, save: 'clean',
}) as ClientView;

export class LocalSession implements SessionPort {
  private readonly options: LocalSessionOptions;
  private worker: Worker | null = null;
  private readonly results = new Map<Id, CommandResult>();
  private readonly pending = new Map<Id, (result: CommandResult) => void>();
  private readonly viewListeners = new Set<(view: ClientView) => void>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private current: ClientView | null = null;
  private link: LinkState = 'idle';
  private ready: PromiseWithResolvers<void> | null = null;
  private disposed = false;
  private paused = false;

  constructor(options: LocalSessionOptions = {}) {
    this.options = options;
  }

  /** True while the authority room lives in a worker thread, never on this one. */
  get hostedOffThread(): boolean {
    return this.worker !== null;
  }

  get linkState(): LinkState {
    return this.link;
  }

  async connect(options: ConnectOptions, signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new LocalSessionError('disposed', 'session is disposed');
    if (this.worker) throw new LocalSessionError('worker', 'session is already connected');
    if (signal.aborted) throw new LocalSessionError('aborted', 'connect aborted');
    const worker = this.spawnWorker();
    this.worker = worker;
    this.link = 'connecting';
    this.ready = Promise.withResolvers<void>();
    worker.onmessage = (event: MessageEvent<HostReply>) => this.handle(event.data);
    worker.onerror = (event: ErrorEvent) => {
      this.link = 'failed';
      this.ready?.reject(new LocalSessionError('worker', event.message));
    };
    const config: LocalConfig = {
      storage: this.options.storage ?? 'auto',
      pace: this.options.pace ?? 'realtime',
      matchSeconds: this.options.matchSeconds ?? PVP.timeLimitS,
      campaignId: this.options.campaignId ?? null,
      campaignName: this.options.campaignName ?? 'Offline campaign',
    };
    const failed = new Promise<never>((_, reject) => {
      worker.addEventListener('error', event => reject(new LocalSessionError('worker', (event as ErrorEvent).message)));
    });
    worker.postMessage({ t: 'connect', options, config } satisfies HostRequest);
    try {
      await Promise.race([this.ready.promise, failed, abortSignal(signal)]);
    } catch (cause) {
      await this.dispose(cause instanceof Error ? cause.message : 'connect failed');
      throw cause instanceof LocalSessionError ? cause : new LocalSessionError('aborted', 'connect aborted');
    }
    this.link = 'handshake';
    await sleep(LOCAL_LINK_MS, signal);
    this.link = 'loading';
    await sleep(LOCAL_LINK_MS, signal);
    this.link = 'online';
    this.publish(this.current);
  }

  view(): ClientView {
    // A port must always be able to answer `view()`: the shell reads it immediately after building
    // the adapter, before connect resolves. Before the room answers this is a disconnected view.
    return this.current ?? DISCONNECTED_VIEW;
  }

  subscribe(listener: (view: ClientView) => void): () => void {
    this.viewListeners.add(listener);
    return () => {
      this.viewListeners.delete(listener);
    };
  }

  events(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async command(command: Command, requestId: Id): Promise<CommandResult> {
    const cached = this.results.get(requestId);
    if (cached) return cached;
    if (!this.worker) return { requestId, ok: false, code: 'denied', message: 'not connected' };
    const { promise, resolve } = Promise.withResolvers<CommandResult>();
    this.pending.set(requestId, resolve);
    this.worker.postMessage({ t: 'command', requestId, command } satisfies HostRequest);
    const result = await promise;
    this.results.set(requestId, result);
    return result;
  }

  setIntent(intent: FlightIntent): void {
    this.worker?.postMessage({ t: 'intent', intent } satisfies HostRequest);
  }

  releaseControls(reason: LocalReleaseReason): void {
    this.worker?.postMessage({ t: 'release', reason } satisfies HostRequest);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.worker?.postMessage({ t: 'pause', paused } satisfies HostRequest);
  }

  async dispose(reason = 'disposed'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    this.link = 'idle';
    for (const resolve of this.pending.values()) resolve({ requestId: 'dispose', ok: false, code: 'denied', message: reason });
    this.pending.clear();
    this.viewListeners.clear();
    this.eventListeners.clear();
    worker?.postMessage({ t: 'dispose' } satisfies HostRequest);
    worker?.terminate();
  }

  private spawnWorker(): Worker {
    if (typeof Worker === 'undefined') throw new LocalSessionError('unsupported', 'this runtime has no Web Worker');
    try {
      return new Worker(new URL('./local-worker.ts', import.meta.url), { type: 'module', name: 'drift-offline' });
    } catch (cause) {
      throw new LocalSessionError('worker', `offline worker did not start: ${(cause as Error).message}`);
    }
  }

  private handle(reply: HostReply): void {
    switch (reply.t) {
      case 'ready':
        this.current = reply.view;
        this.ready?.resolve();
        return;
      case 'view':
        for (const event of reply.events) for (const listener of [...this.eventListeners]) listener(event);
        this.current = reply.view;
        this.publish(reply.view);
        return;
      case 'result': {
        const resolve = this.pending.get(reply.requestId);
        if (resolve) {
          this.pending.delete(reply.requestId);
          resolve(reply.result);
        }
        return;
      }
      case 'failed':
        this.link = 'failed';
        this.ready?.reject(new LocalSessionError('storage', reply.message));
        return;
    }
  }

  private publish(view: ClientView | null): void {
    if (!view) return;
    for (const listener of [...this.viewListeners]) listener(view);
  }
}

function abortSignal(signal: AbortSignal): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  if (signal.aborted) reject(new LocalSessionError('aborted', 'connect aborted'));
  else signal.addEventListener('abort', () => reject(new LocalSessionError('aborted', 'connect aborted')), { once: true });
  return promise;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new LocalSessionError('aborted', 'connect aborted'));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

// ---------------------------------------------------------------------------------------------
// Worker-side host: the offline authority room
// ---------------------------------------------------------------------------------------------

export interface LocalHost {
  request(request: HostRequest): Promise<void>;
}

/** `storage` is the dependency seam: production omits it, a test injects a device that fails. */
export function createLocalHost(post: (reply: HostReply) => void, now: () => number = () => Date.now(), storage: OfflineStorage | null = null): LocalHost {
  return new OfflineRoom(post, now, storage);
}

class OfflineRoom implements LocalHost {
  private readonly post: (reply: HostReply) => void;
  private readonly now: () => number;
  private storage: OfflineStorage | null;
  private config: LocalConfig = { storage: 'auto', pace: 'realtime', matchSeconds: PVP.timeLimitS, campaignId: null, campaignName: 'Offline campaign' };
  private pilotId: Id = 'pilot-local';
  private lobby: LobbyState | null = null;
  private world: WorldState | null = null;
  private snapshot: CampaignSnapshot | null = null;
  private phase: Phase = 'lobby';
  private save: ClientView['save'] = 'clean';
  private matchCount = 0;
  private events: SessionEvent[] = [];
  private deliverySeq = 0;
  private intentSeq = 0;
  private pendingIntent: FlightIntent | null = null;
  private lastStepMs = 0;
  private countdownTicks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settling = false;
  private closed = false;
  private paused = false;
  private accumulator = 0;
  private lastPublishMs = 0;
  private mission: CampaignSource | null = null;
  private engagement: { objectiveId: Id; itemId: Id | null } | null = null;

  constructor(post: (reply: HostReply) => void, now: () => number, storage: OfflineStorage | null) {
    this.post = post;
    this.now = now;
    this.storage = storage;
  }

  async request(request: HostRequest): Promise<void> {
    if (this.closed && request.t !== 'dispose') return;
    switch (request.t) {
      case 'connect':
        await this.connect(request.options, request.config);
        return;
      case 'command':
        await this.command(request.requestId, request.command);
        return;
      case 'intent':
        this.pendingIntent = request.intent;
        return;
      case 'release':
        this.pendingIntent = null;
        if (this.world) releaseInput(this.world, this.pilotId);
        return;
      case 'pause':
        this.paused = request.paused;
        this.pendingIntent = null;
        this.lastStepMs = this.now();
        this.accumulator = 0;
        if (this.world) releaseInput(this.world, this.pilotId);
        return;
      case 'dispose':
        this.closed = true;
        this.stopLoop();
        return;
    }
  }

  private async connect(options: ConnectOptions, config: LocalConfig): Promise<void> {
    this.config = config;
    this.pilotId = `pilot-${hex8(hash32(options.pilotName))}`;
    try {
      this.storage = this.storage ?? (await createOfflineStorage(config.storage));
      this.snapshot = config.campaignId === null ? null : await this.storage.load(config.campaignId);
    } catch (cause) {
      this.post({ t: 'failed', code: 'storage', message: (cause as Error).message });
      return;
    }
    if (!this.snapshot) this.snapshot = freshCampaign(config.campaignName, this.pilotId, this.now());
    this.lobby = createLobby({
      captainId: this.pilotId,
      name: options.pilotName,
      mode: 'skirmish',
      mapId: 'belt',
      joinPolicy: 'open',
      seatCount: RELEASE.maxHumans,
    });
    this.phase = 'lobby';
    this.post({ t: 'ready', view: this.view() });
  }

  private async command(requestId: Id, raw: Command): Promise<void> {
    const parsed = validateCommand(raw);
    const result = parsed.ok ? this.apply(requestId, parsed.value) : { requestId, ok: false as const, code: 'denied' as const, message: parsed.detail };
    // The view lands before its result, so a client that reads the revision it just changed sees it.
    this.publish();
    this.post({ t: 'result', requestId, result });
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  private apply(requestId: Id, command: Command): CommandResult {
    if (!this.lobby) return { requestId, ok: false, code: 'denied', message: 'offline lobby is not open' };
    const seated = this.lobby.seats.some(candidate => candidate?.pilotId === this.pilotId);
    if (!seated) return { requestId, ok: false, code: 'denied', message: 'offline seat is missing' };
    const captain = this.lobby.captainId === this.pilotId;

    // Shop revisions are inventory revisions, not lobby revisions: they are valid outside the lobby.
    if ('expectedRevision' in command && command.kind !== 'inventory') {
      if (this.phase !== 'lobby') return { requestId, ok: false, code: 'wrong-phase', message: `lobby commands are not accepted in ${this.phase}` };
      if (command.expectedRevision !== this.lobby.revision) return { requestId, ok: false, code: 'stale-revision', revision: this.lobby.revision };
    }

    switch (command.kind) {
      case 'edit-lobby': {
        const outcome = editLobby(this.lobby, this.pilotId, command.patch);
        if (!outcome.ok) return { ...outcome, requestId };
        this.emitRoster('seat');
        return { requestId, ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'set-pilot': {
        const outcome = setPilot(this.lobby, this.pilotId, { name: command.name, teamId: command.teamId, fit: command.fit });
        if (!outcome.ok) return { ...outcome, requestId };
        this.emitRoster('seat');
        return { requestId, ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'ready': {
        const outcome = setReady(this.lobby, this.pilotId, command.ready);
        if (!outcome.ok) return { ...outcome, requestId };
        this.emitRoster('ready');
        return { requestId, ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'start': {
        if (!captain) return { requestId, ok: false, code: 'not-captain' };
        const check = startCheck(this.lobby, this.pilotId);
        if (!check.ok) return { requestId, ok: false, code: 'denied', message: check.blockers.join(', ') };
        this.deploy();
        return { requestId, ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'bot-fill': {
        if (!captain) return { requestId, ok: false, code: 'not-captain' };
        const outcome = setBotFill(this.lobby, this.pilotId, command.total, command.difficulty);
        if (!outcome.ok) return { ...outcome, requestId };
        this.emitRoster('join');
        return { requestId, ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'captain': {
        if (!captain) return { requestId, ok: false, code: 'not-captain' };
        const outcome = command.action === 'transfer'
          ? transferCaptain(this.lobby, this.pilotId, command.pilotId)
          : removeSeat(this.lobby, this.pilotId, command.pilotId);
        if (!outcome.ok) return { ...outcome, requestId };
        this.emitRoster(command.action === 'transfer' ? 'captain' : 'leave');
        return { requestId, ok: true, code: 'ok', revision: this.lobby.revision };
      }
      case 'inventory':
        return this.purchase(requestId, command.action, command.itemId, command.expectedRevision);
      case 'recovery': {
        if (command.action !== 'retry-checkpoint') return { requestId, ok: false, code: 'unsupported', message: `offline recovery/${command.action}` };
        if (this.save !== 'failed') return { requestId, ok: false, code: 'denied', message: `save is ${this.save}` };
        void this.persist(this.phase === 'settlement');
        return { requestId, ok: true, code: 'ok' };
      }
      case 'request-respawn':
      case 'sensor-mode':
      case 'reload':
      case 'utility':
      case 'crew-order':
      case 'interact':
      case 'vote':
      case 'extraction':
        return this.matchCommand(requestId, command);
      case 'return-lobby': {
        if (this.phase !== 'debrief') return { requestId, ok: false, code: 'wrong-phase', message: this.phase };
        this.returnToLobby();
        return { requestId, ok: true, code: 'ok' };
      }
      case 'leave': {
        leave(this.lobby, this.pilotId);
        this.emitRoster('leave');
        return { requestId, ok: true, code: 'ok' };
      }
    }
  }

  /** Live commands the offline authority can honour without a mission graph. */
  private matchCommand(requestId: Id, command: Command): CommandResult {
    const world = this.world;
    if (!world) return { requestId, ok: false, code: 'wrong-phase', message: 'no match is running' };
    const pilot = world.ships.get(this.pilotId);
    if (!pilot) return { requestId, ok: false, code: 'denied', message: 'no ship for this pilot' };
    switch (command.kind) {
      case 'request-respawn': {
        return requestRespawn(world, this.pilotId) ? { requestId, ok: true, code: 'ok' } : { requestId, ok: false, code: 'wrong-life', message: pilot.life };
      }
      case 'reload': {
        const weapon = pilot.weapons.find(candidate => candidate.slotId === command.slotId);
        if (!weapon) return { requestId, ok: false, code: 'denied', message: `unknown slot ${command.slotId}` };
        if (weapon.reserve === null || weapon.reserve <= 0) return { requestId, ok: false, code: 'denied', message: 'no reserve' };
        weapon.reloadEndsAtTick = world.tick + Math.round((weapon.spec.reloadS ?? 0) * RELEASE.physicsHz);
        return { requestId, ok: true, code: 'ok' };
      }
      case 'sensor-mode': {
        pilot.scanning = command.mode === 'active';
        return { requestId, ok: true, code: 'ok' };
      }
      case 'utility': {
        const result = applyUtility(world, this.pilotId, command.slotId, command.targetId, command.active);
        return { requestId, ok: result.ok, code: result.ok ? 'ok' : 'denied' };
      }
      case 'crew-order':
        return { requestId, ok: applyCrewOrder(world, this.pilotId, command.order, command.contactId), code: 'ok' };
      case 'interact': {
        const resolved = this.mission?.resolve(command.entityId);
        if (!resolved || !world.mission) return { requestId, ok: false, code: 'denied', message: 'Select an active objective.' };
        const position = bodyOf(world, pilot.bodyId)?.position ?? { x: 0, y: 0 };
        this.engagement = { ...resolved, itemId: resolved.itemId ?? nearestFreeItem(world.mission, resolved.objectiveId, position)?.id ?? null };
        const result = this.observeMission();
        return { requestId, ok: result.accepted, code: result.accepted ? 'ok' : 'denied', message: result.code };
      }
      default:
        // Mission-graph commands are refused rather than silently ignored: a solo skirmish has no
        // objectives, docking volumes or votes, and pretending otherwise would be a lie.
        return { requestId, ok: false, code: 'unsupported', message: `${command.kind} needs the campaign runtime` };
    }
  }

  /** Offline shop: the same 10× part price and per-hull repair the host applies (B7). */
  private purchase(requestId: Id, action: 'buy' | 'repair' | 'restock', itemId: Id, expectedRevision: number): CommandResult {
    const snapshot = this.snapshot;
    if (!snapshot) return { requestId, ok: false, code: 'denied', message: 'no campaign' };
    if (snapshot.campaign.inventoryRevision !== expectedRevision) return { requestId, ok: false, code: 'stale-revision', revision: snapshot.campaign.inventoryRevision };
    const part = CATALOG.partById.get(itemId);
    if (action === 'buy' && !part) return { requestId, ok: false, code: 'denied', message: `unknown part ${itemId}` };
    const target = action === 'repair' ? snapshot.inventory.find(item => item.instanceId === itemId) : undefined;
    if (action === 'repair' && !target) return { requestId, ok: false, code: 'denied', message: `unknown instance ${itemId}` };
    const cost = action === 'buy'
      ? (part?.cost ?? 0) * CAMPAIGN_START.shopPriceMultiplier
      : action === 'repair'
        ? CAMPAIGN_START.repairCostPerHull * Math.max(0, 100 - (target?.health ?? 100))
        : CAMPAIGN_START.repairCostPerHull * 10;
    if (cost > snapshot.campaign.credits) return { requestId, ok: false, code: 'denied', message: `insufficient credits: ${cost}` };
    const nextInventory = mutationInventory(snapshot, action, itemId, this.pilotId);
    this.snapshot = {
      ...snapshot,
      campaign: { ...snapshot.campaign, credits: snapshot.campaign.credits - cost, inventoryRevision: snapshot.campaign.inventoryRevision + 1 },
      inventory: nextInventory,
    };
    void this.persist(false);
    return { requestId, ok: true, code: 'ok', revision: this.lobby?.revision };
  }

  // -------------------------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------------------------

  private deploy(): void {
    const lobby = this.lobby!;
    this.matchCount += 1;
    const epoch = `offline-${hex8(hash32(`${this.snapshot?.campaign.id ?? 'campaign'}:${this.matchCount}`))}`;
    const definition = lobby.mode === 'campaign' ? missionDefinition(lobby.missionId ?? CAMPAIGN_MISSIONS[0]!.id) : null;
    if (definition) { lobby.missionId = definition.id; lobby.mapId = definition.sectorId; }
    this.mission = definition ? campaignSource(definition.id, hash32(epoch)) : null;
    this.engagement = null;
    const teams = lobby.mode === 'team-deathmatch' ? PVP_TEAMS : [TEAM_CREW, TEAM_HOSTILE];
    const world = createWorld({ epoch, mode: lobby.mode, mapId: lobby.mapId, seed: hash32(epoch), matchSeconds: this.config.matchSeconds, teams });
    for (const seat of lobby.seats) {
      if (!seat) continue;
      addPilot(world, { pilotId: seat.pilotId, name: seat.name, teamId: seat.teamId, fit: seat.fit, isBot: seat.isBot });
    }
    if (lobby.mode === 'skirmish') {
      for (let index = 0; index < 2; index++) addPilot(world, {
        pilotId: `raider-${index}`, name: `Cinder ${index + 1}`, teamId: TEAM_HOSTILE,
        fit: defaultFit('needle'), isBot: true,
      });
    }
    if (definition) createMission(world, definition);
    world.phase = 'countdown';
    this.world = world;
    this.phase = 'countdown';
    this.countdownTicks = RULES.countdownSeconds * RELEASE.physicsHz;
    this.emit({ kind: 'roster', payload: { reason: 'join', pilotId: this.pilotId, revision: lobby.revision } });
    this.startLoop();
    // Deployment is a checkpoint point (B9), not just the 15-second cadence and settlement.
    void this.persist(false);
    this.publish();
  }

  private startLoop(): void {
    this.stopLoop();
    this.lastStepMs = this.now();
    this.accumulator = 0;
    const interval = this.config.pace === 'drain' ? 0 : 1000 / RELEASE.physicsHz;
    this.timer = setInterval(() => this.tick(), interval);
  }

  private stopLoop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** At most `MAX_CATCH_UP` steps per wake-up: a stalled page resumes at the newest state (B4). */
  private tick(): void {
    if (this.closed || this.world === null) return;
    const now = this.now();
    if (this.paused) { this.lastStepMs = now; return; }
    this.accumulator = Math.min(MAX_CATCH_UP / RELEASE.physicsHz, this.accumulator + Math.max(0, now - this.lastStepMs) / 1000);
    const steps = this.config.pace === 'drain' ? MAX_CATCH_UP : Math.floor(this.accumulator * RELEASE.physicsHz + 1e-8);
    if (this.config.pace !== 'drain') this.accumulator -= steps / RELEASE.physicsHz;
    this.lastStepMs = now;
    for (let step = 0; step < steps; step++) {
      if (this.phase === 'countdown') {
        this.countdownTicks -= 1;
        if (this.countdownTicks > 0) continue;
        beginMatch(this.world, 'live');
        this.phase = 'live';
        this.lastStepMs = this.now();
        continue;
      }
      if (this.phase !== 'live') break;
      this.feedIntent();
      stepWorld(this.world);
      this.observeMission();
      this.mission?.advance(this.world.tick);
      const outcome = this.mission?.outcome?.();
      if (outcome && outcome !== 'in-progress') this.world.result = { outcome, winningTeamId: outcome === 'mission-complete' ? TEAM_CREW : null };
      if (this.world.tick % CHECKPOINT_TICKS === 0) void this.persist(false);
      if (this.resolveResult()) break;
    }
    if (this.phase !== 'settlement' && (now - this.lastPublishMs >= 1000 / (RELEASE.physicsHz / SNAPSHOT_TICKS) || this.config.pace === 'drain')) {
      this.lastPublishMs = now;
      this.publish();
    }
  }

  /** Every recorded intent becomes a scheduled frame; the world decides when it applies (B4). */
  private feedIntent(): void {
    const world = this.world!;
    const pilot = world.ships.get(this.pilotId);
    if (!pilot || pilot.life !== 'alive' || this.pendingIntent === null) return;
    this.intentSeq += 1;
    applyInput(world, this.pilotId, {
      epoch: world.epoch,
      lifeId: pilot.lifeId,
      seq: this.intentSeq,
      targetTick: world.tick + 1,
      intent: this.pendingIntent,
    });
  }

  private observeMission(): { accepted: boolean; code: string } {
    if (!this.world || !this.mission || !this.engagement) return { accepted: false, code: 'no-objective' };
    const facts = interactFacts(this.world, this.pilotId, this.engagement.objectiveId, this.engagement.itemId);
    if (!facts) return { accepted: false, code: 'unavailable' };
    const result = this.mission.observe({ ...this.engagement, pilotId: this.pilotId, isBot: false, tick: this.world.tick, facts });
    if (this.engagement.itemId && (result.code === 'ok' || result.code === 'already-recovered')) recoverItem(this.world, this.pilotId, this.engagement.itemId);
    if (!this.mission.viewObjectives().some(o => o.id === this.engagement?.objectiveId && o.state === 'active')) this.engagement = null;
    return result;
  }

  private resolveResult(): boolean {
    const world = this.world!;
    if (world.result === null && world.mode === 'skirmish' && world.tick >= world.matchEndsAtTick) {
      // Co-op outcomes come from the mission graph; until one drives the sortie it ends on the arena
      // clock under the same timeout-and-sudden-death rule the deathmatch ledger already uses.
      const occupied = world.ledger.teams.filter(teamId => [...world.ships.values()].some(pilot => pilot.teamId === teamId && pilot.life !== 'spectating'));
      const result = evaluateResult(world.ledger, { tick: world.tick, matchEndsAtTick: world.matchEndsAtTick, activeTeams: world.ledger.teams, teamsWithCombatants: occupied });
      if (result) {
        world.result = result;
        world.events.push({ kind: 'result', payload: { resultId: `${world.epoch}:result`, outcome: result.outcome, winningTeamId: result.winningTeamId } });
      }
    }
    if (world.result === null) return false;
    this.phase = 'settlement';
    world.phase = 'settlement';
    this.stopLoop();
    this.emit({ kind: 'result', payload: { resultId: `${world.epoch}:result`, outcome: world.result.outcome, winningTeamId: world.result.winningTeamId } });
    this.settle();
    return true;
  }

  private settle(): void {
    const world = this.world!;
    const snapshot = this.snapshot!;
    // The shared wallet is paid once per resolved settlement, never once per pilot (B7); a retry
    // after a failed write reuses the same result id, so it can never pay twice either.
    const reward = world.result?.outcome === 'mission-complete' ? this.mission?.settlement() : null;
    const resultId = reward ? `mission:${this.lobby!.missionId}` : `${world.epoch}:result`;
    if (!snapshot.settlements.some(entry => entry.resultId === resultId)) {
      const credits = snapshot.campaign.credits + (reward?.rewardCredits ?? 0);
      const settlement: StoredSettlement = { resultId, receiptId: reward?.receiptId ?? `${world.epoch}-receipt`, credits };
      this.snapshot = { ...snapshot, campaign: { ...snapshot.campaign, credits }, settlements: [...snapshot.settlements, settlement],
        receipts: reward ? [...snapshot.receipts, { objectiveId: this.lobby!.missionId!, itemId: 'complete', receiptId: settlement.receiptId }] : snapshot.receipts,
        decisions: this.mission?.decisions?.() ?? snapshot.decisions };
    }
    for (const seat of this.lobby?.seats ?? []) {
      if (seat) noteLife(this.lobby!, seat.pilotId, world.ships.get(seat.pilotId)?.life ?? 'staged');
    }
    void this.persist(true);
  }

  private returnToLobby(): void {
    const next = this.world?.result?.outcome === 'mission-complete' ? this.mission?.settlement()?.nextMissionId : null;
    if (next && this.lobby) this.lobby.missionId = next;
    this.world = null;
    this.phase = 'lobby';
    this.save = 'clean';
    this.stopLoop();
    const lobby = this.lobby;
    if (lobby) {
      lobby.revision += 1;
      for (const seat of lobby.seats) if (seat && !seat.isBot) seat.readyAtRevision = null;
    }
    this.publish();
  }

  /** One write path: a settlement gates the debrief, a periodic checkpoint never blocks play. */
  private async persist(gatesPhase: boolean): Promise<void> {
    if (this.settling) {
      if (gatesPhase) setTimeout(() => { void this.persist(true); }, 20);
      return;
    }
    const storage = this.storage;
    if (!storage) return;
    this.settling = true;
    this.save = 'pending';
    this.publish();
    try {
      const saved = this.withCheckpoint();
      await storage.save(saved.campaign.id, saved);
      this.snapshot = { ...this.snapshot!, checkpoints: saved.checkpoints, campaign: { ...this.snapshot!.campaign, lastSavedAt: saved.campaign.lastSavedAt } };
      this.save = 'saved';
      if (gatesPhase && this.phase === 'settlement') this.phase = 'debrief';
      this.emit({ kind: 'save', payload: { state: 'saved', at: new Date(this.now()).toISOString(), reason: null } });
    } catch (cause) {
      this.save = 'failed';
      this.emit({ kind: 'save', payload: { state: 'failed', at: null, reason: (cause as Error).message } });
    } finally {
      this.settling = false;
      this.publish();
    }
  }

  private withCheckpoint(): CampaignSnapshot {
    const snapshot = this.snapshot!;
    if (this.world === null) return snapshot;
    const at = new Date(this.now()).toISOString();
    const checkpoint: StoredCheckpoint = { checkpointId: `cp-${this.world.epoch}-${this.world.tick}`, state: checkpointOf(this.world), at };
    // The newest checkpoint plus two predecessors: the same retention the host store applies (B9).
    const checkpoints = [checkpoint, ...snapshot.checkpoints].slice(0, RETAINED_CHECKPOINTS);
    return { ...snapshot, checkpoints, campaign: { ...snapshot.campaign, lastSavedAt: at } };
  }

  // -------------------------------------------------------------------------------------------
  // View and events
  // -------------------------------------------------------------------------------------------

  private emit<K extends SessionEventKind>(draft: { kind: K; payload: EventPayloadByKind[K] }): void {
    this.deliverySeq += 1;
    const world = this.world;
    this.events.push({
      deliverySeq: this.deliverySeq,
      tick: world?.tick ?? 0,
      epoch: world?.epoch ?? 'lobby',
      eventId: `${draft.kind}-${this.deliverySeq}`,
      kind: draft.kind,
      payload: draft.payload,
    });
  }

  private emitRoster(reason: EventPayloadByKind['roster']['reason']): void {
    this.emit({ kind: 'roster', payload: { reason, pilotId: this.pilotId, revision: this.lobby?.revision ?? 0 } });
  }

  private publish(): void {
    const events = this.events;
    this.events = [];
    this.post({ t: 'view', view: this.view(), events });
  }

  private view(): ClientView {
    const lobby = this.lobby;
    const world = this.world;
    const snapshot = this.snapshot!;
    const self = world?.ships.get(this.pilotId) ?? null;
    const ships: ShipView[] = [];
    let weapons: WeaponView[] = [];
    if (world) {
      for (const pilot of world.ships.values()) ships.push(shipView(world, pilot));
      if (self) weapons = self.weapons.map(weaponView);
    }
    return {
      phase: this.phase,
      screenHint: SCREEN_BY_PHASE[this.phase],
      link: 'online',
      pilotId: this.pilotId,
      epoch: world?.epoch ?? null,
      tick: world?.tick ?? 0,
      lobby: this.phase === 'lobby' && lobby ? lobbyView(lobby) : null,
      self: world && self ? selfAuthority(world, self) : null,
      ships,
      contacts: world && self ? (world.contacts.get(this.pilotId) ?? []) : [],
      bodies: world ? bodyViews(world) : [],
      projectiles: world ? projectileViews(world) : [],
      weapons,
      map: world
        ? {
            id: world.map.id,
            baselineHash: `${world.map.id}:${hex8(world.map.seed)}`,
            generatorVersion: world.map.generatorVersion,
            boundsRadiusM: world.map.boundsRadiusM,
            stationIds: world.map.stationIds,
          }
        : null,
      campaign: {
        id: snapshot.campaign.id,
        name: snapshot.campaign.name,
        credits: snapshot.campaign.credits,
        inventoryRevision: snapshot.campaign.inventoryRevision,
        inventory: snapshot.inventory.map(item => ({
          instanceId: item.instanceId,
          partId: item.partId,
          health: item.health,
          reservedByPilotId: item.reservedByPilotId,
        })),
        missions: CAMPAIGN_MISSIONS.map((mission, index) => {
          const complete = snapshot.receipts.some(r => r.objectiveId === mission.id);
          const available = index === 0 || snapshot.receipts.some(r => r.objectiveId === CAMPAIGN_MISSIONS[index - 1]!.id);
          return { id: mission.id, title: mission.title, sectorId: mission.sectorId, state: complete ? 'complete' : available ? 'available' : 'locked' };
        }),
        decisions: snapshot.decisions.map(decision => ({ id: decision.decisionId, optionId: decision.optionId })),
        activeVote: null,
        // A namespace that is not durable is not offered for resume; a device save is claimed only
        // when the bytes actually survive the page (B9: no cold reload of an unhosted page).
        saveOwner: this.storage?.durable ? 'device' : 'host',
        lastSavedAt: snapshot.campaign.lastSavedAt,
      },
      host: null,
      debrief: this.phase === 'debrief' ? this.debrief() : null,
      teamScores: world ? { ...world.ledger.teamScores } : {},
      objectives: this.mission?.viewObjectives() ?? [],
      respawnAtTick: self?.respawnAtTick ?? null,
      phaseEndsAtTick: this.phase === 'countdown' ? (world?.tick ?? 0) + this.countdownTicks : null,
      save: this.save,
    };
  }

  private debrief(): DebriefView {
    const world = this.world;
    const result = world?.result ?? null;
    const resultId = world ? `${world.epoch}:result` : null;
    return {
      resultId: resultId ?? 'result',
      outcome: result?.outcome ?? 'no-contest',
      winningTeamId: result?.winningTeamId ?? null,
      rewardCredits: result?.outcome === 'mission-complete' ? this.mission?.settlement()?.rewardCredits ?? 0 : 0,
      repairCredits: 0,
      receiptId: resultId === null ? null : this.snapshot!.settlements.find(entry => entry.resultId === resultId)?.receiptId ?? null,
      nextMissionId: result?.outcome === 'mission-complete' ? this.mission?.settlement()?.nextMissionId ?? null : null,
      pilots: (this.lobby?.seats ?? []).flatMap(seat => {
        if (!seat) return [];
        const tally = world?.ships.get(seat.pilotId)?.score;
        return [{ pilotId: seat.pilotId, name: seat.name, teamId: seat.teamId, kills: tally?.kills ?? 0, assists: tally?.assists ?? 0, deaths: tally?.deaths ?? 0, departed: false }];
      }),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// DTO builders
// ---------------------------------------------------------------------------------------------

function weaponView(weapon: WeaponRuntime): WeaponView {
  return {
    slotId: weapon.slotId,
    partId: weapon.partId,
    group: weapon.group,
    autoDefense: weapon.group === null,
    magazine: weapon.magazine,
    reserve: weapon.reserve,
    reloadEndsAtTick: weapon.reloadEndsAtTick,
    chargeFraction: weapon.chargeFraction,
    readyAtTick: weapon.readyAtTick,
    blockedReason: weapon.blockedReason,
  };
}

function selfAuthority(world: WorldState, pilot: PilotRuntime): SelfAuthority {
  const body = bodyOf(world, pilot.bodyId)!;
  return {
    tick: world.tick,
    ship: shipView(world, pilot),
    derived: pilot.derived,
    activeInput: pilot.activeInput,
    scheduledInputs: pilot.queued,
    receivedSeq: pilot.receivedSeq,
    appliedSeq: pilot.appliedSeq,
    predictionState: {
      tick: world.tick,
      position: { ...body.position },
      velocity: { ...body.velocity },
      angle: body.angle,
      angularVelocity: body.angularVelocity,
      fuelKg: pilot.fuelKg,
      heatMJ: pilot.heatMJ,
      capacitorMJ: pilot.capacitorMJ,
      angularAssist: pilot.activeInput?.intent.angularAssist ?? EMPTY_FLIGHT_INTENT.angularAssist,
    },
    weapons: pilot.weapons.map(weaponView),
  };
}

function bodyViews(world: WorldState): ClientView['bodies'] {
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
      shape: body.shape,
      collidable: body.collidable,
      hull: rock.hull,
      hullMax: rock.hullMax,
    });
  }
  for (const pilot of world.ships.values()) {
    const body = bodyOf(world, pilot.bodyId);
    if (!body) continue;
    views.push({
      id: `ship:${pilot.pilotId}`,
      generation: body.generation,
      visualId: `ship:${pilot.pilotId}`,
      renderSeed: pilot.spawnSalt,
      position: { ...body.position },
      velocity: { ...body.velocity },
      angle: body.angle,
      angularVelocity: body.angularVelocity,
      shape: body.shape,
      collidable: body.collidable,
      hull: pilot.hull,
      hullMax: pilot.hullMax,
    });
  }
  return views;
}

function checkpointOf(world: WorldState): CheckpointState {
  const ships: CheckpointShip[] = [];
  const pendingActions: CheckpointAction[] = [];
  for (const pilot of world.ships.values()) {
    const body = bodyOf(world, pilot.bodyId);
    if (!body) continue;
    ships.push({
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
    });
    for (const input of pilot.queued) pendingActions.push({ pilotId: pilot.pilotId, seq: input.seq, applyAtTick: input.applyAtTick, intent: input.intent });
  }
  const rocks: CheckpointRock[] = rockViews(world).map(({ rock, body }) => ({
    contentId: rock.contentId,
    generation: rock.generation,
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
  return {
    tick: world.tick,
    epoch: world.epoch,
    rng: { fracture: world.fractureRng.state() },
    ships,
    rocks,
    objectives: [],
    pendingActions,
    baselineRevision: world.map.generatorVersion,
  };
}

function freshCampaign(name: string, pilotId: Id, nowMs: number): CampaignSnapshot {
  return {
    campaign: {
      id: `offline-${hex8(hash32(`${pilotId}:${nowMs}`))}`,
      name,
      credits: CAMPAIGN_START.credits,
      inventoryRevision: 1,
      createdAt: new Date(nowMs).toISOString(),
      lastSavedAt: null,
    },
    inventory: [],
    checkpoints: [],
    receipts: [],
    decisions: [],
    settlements: [],
  };
}

/** A bought instance is reserved to the pilot who paid for it; a repair touches the same instance. */
function mutationInventory(snapshot: CampaignSnapshot, action: 'buy' | 'repair' | 'restock', itemId: Id, pilotId: Id): readonly InventoryItem[] {
  if (action === 'buy') {
    const instance: InventoryItem = { instanceId: `inst-${snapshot.inventory.length + 1}-${itemId}`, partId: itemId, health: 100, reservedByPilotId: pilotId };
    return [...snapshot.inventory, instance];
  }
  if (action === 'repair') return snapshot.inventory.map(item => (item.instanceId === itemId ? { ...item, health: 100 } : item));
  return snapshot.inventory;
}

// ---------------------------------------------------------------------------------------------
// Offline storage backends
// ---------------------------------------------------------------------------------------------

const OFFLINE_DB = 'drift-offline';
const OFFLINE_STORE = 'campaigns';

async function createOfflineStorage(kind: OfflineStorageKind): Promise<OfflineStorage> {
  const memory = new MemoryOfflineStorage();
  if (kind === 'memory') return memory;
  try {
    return await IndexedDbOfflineStorage.open();
  } catch {
    // An opaque origin (`file://`) has no IndexedDB; a page with no host cannot promise a resume.
    return memory;
  }
}

class MemoryOfflineStorage implements OfflineStorage {
  /** Memory is not a device: this namespace is never offered for a cold reload. */
  readonly durable = false;
  private readonly campaigns = new Map<Id, CampaignSnapshot>();

  async load(namespace: Id): Promise<CampaignSnapshot | null> {
    return this.campaigns.get(namespace) ?? null;
  }

  async save(namespace: Id, snapshot: CampaignSnapshot): Promise<void> {
    this.campaigns.set(namespace, snapshot);
  }

  async list(): Promise<readonly CampaignRecord[]> {
    return [...this.campaigns.values()].map(entry => entry.campaign);
  }
}

class IndexedDbOfflineStorage implements OfflineStorage {
  /** IndexedDB survives the page, so this namespace may be offered for a cold reload. */
  readonly durable = true;

  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IndexedDbOfflineStorage> {
    const global = globalThis as unknown as { indexedDB?: IDBFactory };
    if (!global.indexedDB) throw new Error('no IndexedDB');
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const request = global.indexedDB.open(OFFLINE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) db.createObjectStore(OFFLINE_STORE, { keyPath: 'campaign.id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    return new IndexedDbOfflineStorage(await promise);
  }

  async load(namespace: Id): Promise<CampaignSnapshot | null> {
    const record = await this.transaction('readonly', store => store.get(namespace));
    return (record as CampaignSnapshot | undefined) ?? null;
  }

  /** One transaction per checkpoint: a campaign is written whole or not at all. */
  async save(namespace: Id, snapshot: CampaignSnapshot): Promise<void> {
    await this.transaction('readwrite', store => store.put(snapshot, namespace));
  }

  async list(): Promise<readonly CampaignRecord[]> {
    const records = (await this.transaction('readonly', store => store.getAll())) as CampaignSnapshot[];
    return records.map(record => record.campaign);
  }

  private transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const tx = this.db.transaction(OFFLINE_STORE, mode);
    const request = run(tx.objectStore(OFFLINE_STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    return promise;
  }
}
