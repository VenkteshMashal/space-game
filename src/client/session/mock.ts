/**
 * Deterministic SessionPort fixture (Plan A1). A's shell tests drive lobby, link, life and
 * settlement outcomes through this instead of a socket: everything the authority would announce is
 * scripted on a scenario timeline and reached with `advance(ms)`, so no test waits on a network or
 * on wall-clock time.
 *
 * The fixture stays honest about the boundary. Commands go through the shared validator and answer
 * with the real CommandResult codes, scripted announcements are the real SessionEvent DTOs, and
 * `view()` is deep-frozen exactly like the adapter-backed one.
 */

import type {
  ClientView,
  Command,
  CommandResult,
  ConnectOptions,
  DebriefView,
  EventPayloadByKind,
  Fit,
  FlightIntent,
  Id,
  Life,
  LinkState,
  LobbyView,
  Mode,
  Phase,
  Presence,
  RosterEntry,
  Screen,
  SelfAuthority,
  SessionEvent,
  SessionEventKind,
  SessionPort,
  ShipView,
} from '../../shared/contracts.ts';
import { RELEASE } from '../../shared/contracts.ts';
import { defaultFit, deriveFit } from '../../shared/catalog.ts';
import { validateCommand } from '../../shared/validate.ts';

const LOCAL_ID: Id = 'pilot-1';
const LOCAL_SHIP_ID: Id = 'ship-1';
const TEAM_A: Id = 'team-a';
const TEAM_B: Id = 'team-b';
const CHASSIS_ID: Id = 'kestrel';
const MAP_ID: Id = 'belt';
/** Two 1 ms ticks are enough to observe `handshake`; nothing here opens a socket. */
const CONNECT_STEP_MS = 1;
const RESPAWN_SECONDS = 5;
const LIVE_PHASES: readonly Phase[] = ['countdown', 'live', 'extraction', 'settlement'];

const SCREEN_BY_PHASE: Readonly<Record<Phase, Screen>> = {
  lobby: 'lobby',
  loading: 'flight',
  countdown: 'flight',
  live: 'flight',
  extraction: 'flight',
  settlement: 'flight',
  debrief: 'debrief',
};

type RosterReason = EventPayloadByKind['roster']['reason'];

export type MockReleaseReason = Parameters<SessionPort['releaseControls']>[0];

export type MockConnectCode = 'aborted' | 'loading-failed' | 'reconnect-failed' | 'already-connected' | 'disposed';

/** Typed connect failure, so a test can tell an abort from a scripted handshake failure. */
export class MockSessionError extends Error {
  readonly code: MockConnectCode;

  constructor(code: MockConnectCode, message: string) {
    super(message);
    this.name = 'MockSessionError';
    this.code = code;
  }
}

/** An event as a scenario writes it; the session stamps deliverySeq, tick, epoch and eventId. */
export type MockEventDraft = {
  [K in SessionEventKind]: { kind: K; payload: EventPayloadByKind[K] };
}[SessionEventKind];

/** One scripted timeline entry. `advance` runs entries in ascending `atMs` order. */
export type MockStep =
  | { readonly atMs: number; readonly kind: 'link'; readonly link: LinkState }
  | { readonly atMs: number; readonly kind: 'phase'; readonly phase: Phase }
  | { readonly atMs: number; readonly kind: 'life'; readonly life: Life }
  | { readonly atMs: number; readonly kind: 'save'; readonly save: ClientView['save'] }
  | { readonly atMs: number; readonly kind: 'score'; readonly teamScores: Readonly<Record<Id, number>> }
  | { readonly atMs: number; readonly kind: 'event'; readonly event: MockEventDraft }
  | { readonly atMs: number; readonly kind: 'gap'; readonly count: number };

export type MockLinkFailure = 'none' | 'loading' | 'reconnect';

/** A named A1 case: who is in the lobby, where the session starts and what the timeline does. */
export interface MockScenario {
  /** A1 case name; a failing test reads as the case rather than as a line number. */
  readonly name: string;
  /** Occupied seats at connect, including the local pilot: 1 is an empty lobby, 8 is full. */
  readonly seats: number;
  /** Seats belonging to humans; the remaining occupied seats are bots. */
  readonly humans: number;
  readonly phase: Phase;
  readonly life: Life;
  readonly mode: Mode;
  readonly joinPolicy: LobbyView['joinPolicy'];
  readonly save: ClientView['save'];
  readonly teamScores: Readonly<Record<Id, number>>;
  /** Fail the connect itself, the way a rejected resume or a blown loading deadline does. */
  readonly linkFailure: MockLinkFailure;
  readonly script: readonly MockStep[];
}

function scenario(name: string, over: Partial<MockScenario> = {}): MockScenario {
  const base: MockScenario = {
    name,
    seats: 1,
    humans: 1,
    phase: 'lobby',
    life: 'staged',
    mode: 'skirmish',
    joinPolicy: 'open',
    save: 'clean',
    teamScores: {},
    linkFailure: 'none',
    script: [],
  };
  return Object.freeze({ ...base, ...over, script: Object.freeze([...(over.script ?? base.script)]) });
}

// ---------------------------------------------------------------------------------------------
// A1 cases. Lobby shape is the fixture; the interesting transitions are the timeline, driven by
// `advance`, or the commands the test issues against it.
// ---------------------------------------------------------------------------------------------

export const emptyLobbyScenario = (): MockScenario => scenario('empty-lobby');

export const fullLobbyScenario = (): MockScenario => scenario('full-lobby', { seats: 8, humans: 1 });

export const captainTransferScenario = (): MockScenario => scenario('captain-transfer', { seats: 3, humans: 3 });

export const invalidFitScenario = (): MockScenario => scenario('invalid-fit', { seats: 2, humans: 1 });

export const loadingFailureScenario = (): MockScenario => scenario('loading-failure', { linkFailure: 'loading' });

export const aliveScenario = (): MockScenario => scenario('alive', { phase: 'live', life: 'alive' });

export const disabledScenario = (): MockScenario => scenario('disabled', { phase: 'live', life: 'disabled' });

export const deadScenario = (): MockScenario => scenario('dead', { phase: 'live', life: 'destroyed' });

/** Live match, packet stall: three deliveries are lost, then the link resumes on a fresh epoch. */
export const packetStallScenario = (): MockScenario =>
  scenario('packet-stall', {
    phase: 'live',
    life: 'alive',
    mode: 'team-deathmatch',
    script: [
      {
        atMs: 400,
        kind: 'event',
        event: {
          kind: 'shot',
          payload: {
            shotId: 'shot-1',
            slotId: 'w1',
            weaponId: 'gun-autocannon',
            ownerLifeId: 'life-1',
            position: { x: 0, y: 0 },
            velocity: { x: 400, y: 0 },
            state: 'armed',
            expiresAtTick: 240,
          },
        },
      },
      { atMs: 500, kind: 'link', link: 'reconnecting' },
      { atMs: 500, kind: 'gap', count: 3 },
      { atMs: 2_000, kind: 'link', link: 'online' },
      {
        atMs: 2_000,
        kind: 'event',
        event: { kind: 'roster', payload: { reason: 'reconnect', pilotId: LOCAL_ID, revision: 1 } },
      },
    ],
  });

/** Lobby stall: the seat is visibly reconnecting and the pilot is alive again when it resumes. */
export const reconnectSuccessScenario = (): MockScenario =>
  scenario('reconnect-success', {
    seats: 2,
    humans: 2,
    script: [
      { atMs: 500, kind: 'link', link: 'reconnecting' },
      { atMs: 1_500, kind: 'link', link: 'online' },
    ],
  });

export const reconnectFailureScenario = (): MockScenario => scenario('reconnect-failure', { linkFailure: 'reconnect' });

/** Equal totals at the horn; sudden death ends on the first unequal end-of-tick score (B7). */
export const scoreTieScenario = (): MockScenario =>
  scenario('score-tie', {
    phase: 'live',
    life: 'alive',
    mode: 'team-deathmatch',
    teamScores: { [TEAM_A]: 30, [TEAM_B]: 30 },
    script: [
      { atMs: 5_000, kind: 'phase', phase: 'settlement' },
      { atMs: 5_000, kind: 'score', teamScores: { [TEAM_A]: 31, [TEAM_B]: 30 } },
    ],
  });

export const settlementPendingScenario = (): MockScenario =>
  scenario('settlement-pending', {
    phase: 'settlement',
    life: 'alive',
    save: 'pending',
    script: [{ atMs: 2_000, kind: 'save', save: 'saved' }],
  });

export const settlementFailedScenario = (): MockScenario =>
  scenario('settlement-failed', {
    phase: 'settlement',
    life: 'alive',
    save: 'pending',
    script: [{ atMs: 2_000, kind: 'save', save: 'failed' }],
  });

/** A finished match; `return-lobby` + `start` is the second match and its fresh epoch. */
export const secondMatchScenario = (): MockScenario => scenario('second-match', { phase: 'debrief', life: 'alive', save: 'saved' });

/**
 * A legal loaner build. `defaultFit` currently lists every fitted slot in its fire groups, which
 * `deriveFit` rejects as unknown-fire-group-slot, so the fixture keeps the reference build and
 * rebuilds the groups from the weapon slots alone.
 */
function loanerFit(chassisId: Id): Fit {
  const base = defaultFit(chassisId);
  const weapons = Object.keys(base.slots).filter(slotId => slotId.startsWith('w'));
  const half = Math.ceil(weapons.length / 2);
  return { ...base, fireGroups: [weapons.slice(0, half), weapons.slice(half)].filter(group => group.length > 0) };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

/** Bounded, abort-aware pause. The only real time a mock session ever consumes. */
function settle(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const signalAbort = (): void => reject(new MockSessionError('aborted', 'connect aborted'));
  if (signal.aborted) {
    signalAbort();
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    signalAbort();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

export class MockSession implements SessionPort {
  private readonly scenario: MockScenario;
  private readonly steps: readonly MockStep[];
  private readonly results = new Map<Id, CommandResult>();
  private readonly viewListeners = new Set<(view: ClientView) => void>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private readonly fit: Fit;

  private roster: RosterEntry[];
  private captainId: Id = LOCAL_ID;
  private pilotName = 'You';
  private revision = 1;
  private mode: Mode;
  private joinPolicy: LobbyView['joinPolicy'];
  private mapId: Id = MAP_ID;
  private missionId: Id | null = null;
  private botFill: LobbyView['botFill'] = null;
  private link: LinkState = 'idle';
  private phase: Phase;
  private presence: Presence = 'connected';
  private epoch: Id | null = null;
  private epochCount = 0;
  private life: Life = 'staged';
  private lifeId: Id = 'life-1';
  private lifeCount = 1;
  private respawnAtTick: number | null = null;
  private teamScores: Record<Id, number>;
  private save: ClientView['save'];
  private outcome: DebriefView['outcome'] = 'victory';
  private tick = 0;
  private clockMs = 0;
  private cursor = 0;
  private deliverySeq = 0;
  private failureSpent = false;
  private disposed = false;
  private dirty = false;
  private cached: ClientView | null = null;
  private latestIntent: FlightIntent | null = null;
  private latestRelease: MockReleaseReason | null = null;

  constructor(scenario: MockScenario = emptyLobbyScenario()) {
    this.scenario = scenario;
    this.steps = Object.freeze([...scenario.script].sort((a, b) => a.atMs - b.atMs));
    this.phase = scenario.phase;
    this.mode = scenario.mode;
    this.joinPolicy = scenario.joinPolicy;
    this.teamScores = { ...scenario.teamScores };
    this.save = scenario.save;
    this.fit = loanerFit(CHASSIS_ID);
    this.roster = this.seatRoster(scenario.seats, scenario.humans);
    this.setLife(scenario.life, false);
    if (this.phase !== 'lobby') this.epoch = this.mintEpoch();
  }

  async connect(options: ConnectOptions, signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new MockSessionError('disposed', 'session is disposed');
    if (this.link !== 'idle' && this.link !== 'failed') throw new MockSessionError('already-connected', `link is ${this.link}`);
    this.pilotName = options.pilotName;
    this.local().name = options.pilotName;
    try {
      this.setLink('connecting');
      this.push();
      await settle(CONNECT_STEP_MS, signal);
      this.setLink('handshake');
      this.push();
      await settle(CONNECT_STEP_MS, signal);
    } catch (cause) {
      // An aborted connect is a dead session: the link fails, subscribers stop, nothing lingers.
      this.setLink('failed');
      this.push();
      await this.dispose();
      throw cause instanceof MockSessionError ? cause : new MockSessionError('aborted', 'connect aborted');
    }
    // The scripted connect failure is one-shot, so the same port can prove the retry path (B1:
    // loading failures see retry/leave, a dead resume token gets a fresh connect).
    if (this.scenario.linkFailure !== 'none' && !this.failureSpent) {
      this.failureSpent = true;
      if (this.scenario.linkFailure === 'loading') {
        this.setLink('loading');
        this.push();
      }
      this.setLink('failed');
      this.push();
      const code = this.scenario.linkFailure === 'loading' ? 'loading-failed' : 'reconnect-failed';
      throw new MockSessionError(code, `${this.scenario.name} does not reach online`);
    }
    this.setLink('online');
    this.push();
  }

  view(): ClientView {
    this.cached ??= freezeDeep(this.buildView());
    return this.cached;
  }

  subscribe(listener: (view: ClientView) => void): () => void {
    if (this.disposed) return () => {};
    this.viewListeners.add(listener);
    return () => {
      this.viewListeners.delete(listener);
    };
  }

  events(listener: (event: SessionEvent) => void): () => void {
    if (this.disposed) return () => {};
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async command(command: Command, requestId: Id): Promise<CommandResult> {
    // Duplicate request IDs replay the original answer instead of applying the mutation twice (B1).
    const cached = this.results.get(requestId);
    if (cached) return cached;
    const result = this.apply(requestId, command);
    this.results.set(requestId, result);
    this.push();
    return result;
  }

  setIntent(intent: FlightIntent): void {
    if (this.disposed) return;
    this.latestIntent = intent;
  }

  releaseControls(reason: MockReleaseReason): void {
    if (this.disposed) return;
    this.latestIntent = null;
    this.latestRelease = reason;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.viewListeners.clear();
    this.eventListeners.clear();
  }

  /** Latest intent handed to the adapter; not part of ClientView, so tests read it here. */
  get intent(): FlightIntent | null {
    return this.latestIntent;
  }

  get releaseReason(): MockReleaseReason | null {
    return this.latestRelease;
  }

  /** Test-only time driver: runs every scripted step up to `clockMs + ms`. */
  advance(ms: number): void {
    if (this.disposed) return;
    const target = this.clockMs + Math.max(0, ms);
    while (this.cursor < this.steps.length && this.steps[this.cursor]!.atMs <= target) {
      const step = this.steps[this.cursor]!;
      this.setClock(step.atMs);
      this.runStep(step);
      this.cursor += 1;
    }
    this.setClock(target);
    this.push();
  }

  // -------------------------------------------------------------------------------------------
  // State machine.
  // -------------------------------------------------------------------------------------------

  private seatRoster(seats: number, humans: number): RosterEntry[] {
    const occupied = Math.max(1, Math.min(RELEASE.maxHumans, seats));
    const humanSeats = Math.max(1, Math.min(occupied, humans));
    const entries: RosterEntry[] = [];
    for (let seat = 0; seat < occupied; seat++) {
      const bot = seat >= humanSeats;
      const pilotId = seat === 0 ? LOCAL_ID : bot ? `bot-${seat + 1}` : `pilot-${seat + 1}`;
      entries.push({
        pilotId,
        name: seat === 0 ? this.pilotName : bot ? `Bot ${seat + 1}` : `Pilot ${seat + 1}`,
        teamId: this.teamFor(seat),
        isBot: bot,
        presence: 'connected',
        life: 'staged',
        // Ready acknowledgements are revision-bound; only the local pilot can re-ready itself.
        readyRevision: seat === 0 ? null : this.revision,
        fit: this.fit,
        pingMs: bot ? null : 12 + seat,
        seat,
      });
    }
    return entries;
  }

  private teamFor(seat: number): Id {
    return this.mode === 'team-deathmatch' && seat % 2 === 1 ? TEAM_B : TEAM_A;
  }

  private local(): RosterEntry {
    return this.roster[0]!;
  }

  private mintEpoch(): Id {
    this.epochCount += 1;
    return `epoch-${this.epochCount}`;
  }

  private setClock(ms: number): void {
    if (ms <= this.clockMs) return;
    this.clockMs = ms;
    this.tick = Math.round((ms * RELEASE.physicsHz) / 1000);
    this.dirty = true;
  }

  private setLink(link: LinkState): void {
    if (this.link === link) return;
    // A link that comes back from a stall resumes on a fresh epoch: no dropped baseline is reused.
    // A lobby has no match epoch, so there is nothing to replace there.
    const resumed = this.link === 'reconnecting' && link === 'online' && this.phase !== 'lobby';
    this.link = link;
    this.presence = link === 'reconnecting' ? 'reconnecting' : link === 'failed' ? 'left' : 'connected';
    this.local().presence = this.presence;
    if (resumed) this.epoch = this.mintEpoch();
    this.dirty = true;
  }

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === 'lobby') this.epoch = null;
    else if (this.epoch === null) this.epoch = this.mintEpoch();
    this.dirty = true;
  }

  private setLife(life: Life, announce = true): void {
    if (this.life === life) return;
    this.life = life;
    this.local().life = life;
    if (life === 'destroyed') {
      this.lifeCount += 1;
      this.lifeId = `life-${this.lifeCount}`;
      this.respawnAtTick = this.tick + RESPAWN_SECONDS * RELEASE.physicsHz;
    } else if (life === 'alive' || life === 'disabled') {
      this.respawnAtTick = null;
    }
    this.dirty = true;
    if (announce) {
      this.emit({
        kind: 'life',
        payload: {
          lifeId: this.lifeId,
          shipId: LOCAL_SHIP_ID,
          pilotId: LOCAL_ID,
          life,
          position: { x: 0, y: 0 },
          respawnAtTick: this.respawnAtTick,
        },
      });
    }
  }

  private setSave(state: ClientView['save']): void {
    if (this.save === state) return;
    this.save = state;
    this.dirty = true;
    // Only the states the authority announces travel as events; 'clean' is local bookkeeping.
    if (state !== 'clean') this.emit({ kind: 'save', payload: { state, at: null, reason: null } });
  }

  /** Lobby edits bump the revision and revoke every readiness acknowledgement (B1). */
  private editLobby(): void {
    this.revision += 1;
    for (const entry of this.roster) entry.readyRevision = null;
    this.dirty = true;
  }

  private blockers(roster: readonly RosterEntry[]): string[] {
    const blockers: string[] = [];
    const humans = roster.filter(entry => !entry.isBot && entry.presence !== 'left');
    if (humans.length === 0) blockers.push('No pilots in the lobby');
    for (const entry of humans) {
      if (entry.readyRevision !== this.revision) blockers.push(`Waiting for ${entry.name}`);
      if (!deriveFit(entry.fit).valid) blockers.push(`Invalid fit: ${entry.name}`);
    }
    if (this.mode === 'team-deathmatch') {
      const teams = new Map<Id, number>();
      for (const entry of humans) teams.set(entry.teamId, (teams.get(entry.teamId) ?? 0) + 1);
      const sizes = [...teams.values()];
      if (sizes.length > 1 && Math.max(...sizes) - Math.min(...sizes) > 1) blockers.push('Teams are unbalanced');
    }
    return blockers;
  }

  private runStep(step: MockStep): void {
    switch (step.kind) {
      case 'link':
        this.setLink(step.link);
        break;
      case 'phase':
        this.setPhase(step.phase);
        break;
      case 'life':
        this.setLife(step.life);
        break;
      case 'save':
        this.setSave(step.save);
        break;
      case 'score':
        this.teamScores = { ...step.teamScores };
        this.dirty = true;
        break;
      case 'event':
        this.emit(step.event);
        break;
      case 'gap':
        // A recipient cursor jumps over announcements the stalled link never delivered.
        this.deliverySeq += step.count;
        break;
    }
  }

  private emit(draft: MockEventDraft): void {
    this.deliverySeq += 1;
    const event: SessionEvent = {
      deliverySeq: this.deliverySeq,
      tick: this.tick,
      epoch: this.epoch ?? 'lobby',
      eventId: `${draft.kind}-${this.deliverySeq}`,
      kind: draft.kind,
      payload: draft.payload,
    };
    const published = freezeDeep(event);
    for (const listener of [...this.eventListeners]) listener(published);
  }

  private push(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.cached = null;
    const view = this.view();
    for (const listener of [...this.viewListeners]) listener(view);
  }

  private accept(requestId: Id, reason: RosterReason, pilotId: Id = LOCAL_ID): CommandResult {
    this.emit({ kind: 'roster', payload: { reason, pilotId, revision: this.revision } });
    return { requestId, ok: true, code: 'ok', revision: this.revision };
  }

  private apply(requestId: Id, raw: Command): CommandResult {
    const parsed = validateCommand(raw);
    if (!parsed.ok) return { requestId, ok: false, code: 'denied', message: parsed.detail };
    const command = parsed.value;
    if ('expectedRevision' in command) {
      if (this.phase !== 'lobby') return { requestId, ok: false, code: 'wrong-phase', message: `lobby commands are not accepted in ${this.phase}` };
      if (command.expectedRevision !== this.revision) return { requestId, ok: false, code: 'stale-revision', revision: this.revision };
    }
    const captain = this.local().pilotId === this.captainId;
    switch (command.kind) {
      case 'edit-lobby': {
        if (command.patch.mode !== undefined) this.mode = command.patch.mode;
        if (command.patch.mapId !== undefined) this.mapId = command.patch.mapId;
        if (command.patch.missionId !== undefined) this.missionId = command.patch.missionId;
        if (command.patch.joinPolicy !== undefined) this.joinPolicy = command.patch.joinPolicy;
        this.editLobby();
        return this.accept(requestId, 'seat');
      }
      case 'set-pilot': {
        if (command.fit) {
          const derived = deriveFit(command.fit);
          // A rejected build leaves the previous fit in place; the client keeps its draft (A4).
          if (!derived.valid) return { requestId, ok: false, code: 'invalid-fit', message: derived.errors.join(', ') };
          this.local().fit = command.fit;
        }
        if (command.name !== undefined) this.local().name = command.name;
        if (command.teamId !== undefined) this.local().teamId = command.teamId;
        this.editLobby();
        return this.accept(requestId, 'seat');
      }
      case 'ready': {
        const ack = command.ready ? this.revision : null;
        if (this.local().readyRevision !== ack) {
          this.local().readyRevision = ack;
          this.dirty = true;
        }
        return this.accept(requestId, 'ready');
      }
      case 'start': {
        if (!captain) return { requestId, ok: false, code: 'not-captain' };
        const blockers = this.blockers(this.roster);
        if (blockers.length > 0) return { requestId, ok: false, code: 'denied', message: blockers.join(', ') };
        this.setPhase('loading');
        this.setLink('loading');
        return { requestId, ok: true, code: 'ok', revision: this.revision };
      }
      case 'captain': {
        if (!captain) return { requestId, ok: false, code: 'not-captain' };
        const target = this.roster.find(entry => entry.pilotId === command.pilotId);
        if (!target) return { requestId, ok: false, code: 'denied', message: `unknown seat ${command.pilotId}` };
        if (command.action === 'transfer') {
          if (target.isBot || target.presence === 'left') return { requestId, ok: false, code: 'denied', message: 'captain must be a connected human' };
          this.captainId = target.pilotId;
          this.editLobby();
          return this.accept(requestId, 'captain', target.pilotId);
        }
        if (target.readyRevision === this.revision) return { requestId, ok: false, code: 'denied', message: `${target.name} is ready` };
        this.roster = this.roster.filter(entry => entry !== target);
        this.editLobby();
        return this.accept(requestId, 'leave', target.pilotId);
      }
      case 'bot-fill': {
        if (!captain) return { requestId, ok: false, code: 'not-captain' };
        const humans = this.roster.filter(entry => !entry.isBot).length;
        if (command.total < humans) return { requestId, ok: false, code: 'denied', message: `${command.total} seats is below ${humans} pilots` };
        while (this.roster.length < command.total) this.roster.push(this.botSeat(this.roster.length));
        this.botFill = { total: command.total, difficulty: command.difficulty };
        this.editLobby();
        return this.accept(requestId, 'join');
      }
      case 'request-respawn': {
        if (this.life !== 'destroyed') return { requestId, ok: false, code: 'wrong-life', message: this.life };
        this.setLife('respawning');
        return { requestId, ok: true, code: 'ok' };
      }
      case 'recovery': {
        if (command.action !== 'retry-checkpoint') return { requestId, ok: false, code: 'unsupported', message: `recovery/${command.action}` };
        if (this.save !== 'failed') return { requestId, ok: false, code: 'denied', message: `save is ${this.save}` };
        this.setSave('saved');
        return { requestId, ok: true, code: 'ok' };
      }
      case 'return-lobby': {
        if (this.phase !== 'debrief') return { requestId, ok: false, code: 'wrong-phase', message: this.phase };
        this.revision = 1;
        this.roster = this.seatRoster(this.scenario.seats, this.scenario.humans);
        this.captainId = LOCAL_ID;
        this.botFill = null;
        this.teamScores = {};
        this.save = 'clean';
        this.setPhase('lobby');
        return { requestId, ok: true, code: 'ok' };
      }
      case 'leave': {
        this.presence = 'left';
        this.local().presence = 'left';
        this.dirty = true;
        return this.accept(requestId, 'leave');
      }
      default:
        return { requestId, ok: false, code: 'unsupported', message: `${command.kind} is not modelled by MockSession` };
    }
  }

  private botSeat(seat: number): RosterEntry {
    return {
      pilotId: `bot-${seat + 1}`,
      name: `Bot ${seat + 1}`,
      teamId: this.teamFor(seat),
      isBot: true,
      presence: 'connected',
      life: 'staged',
      readyRevision: null,
      fit: this.fit,
      pingMs: null,
      seat,
    };
  }

  // -------------------------------------------------------------------------------------------
  // View.
  // -------------------------------------------------------------------------------------------

  private buildView(): ClientView {
    const inMatch = LIVE_PHASES.includes(this.phase);
    const self = inMatch ? this.buildSelf() : null;
    return {
      phase: this.phase,
      screenHint: SCREEN_BY_PHASE[this.phase],
      link: this.link,
      pilotId: LOCAL_ID,
      epoch: this.epoch,
      tick: this.tick,
      lobby: this.phase === 'lobby' ? this.buildLobby() : null,
      self,
      ships: self ? [self.ship] : [],
      contacts: [],
      bodies: [],
      projectiles: [],
      weapons: self ? self.weapons : [],
      map: inMatch ? { id: MAP_ID, baselineHash: 'belt-1-baseline', generatorVersion: 1, boundsRadiusM: 6000, stationIds: ['station-relay'] } : null,
      campaign: null,
      host: null,
      debrief: this.phase === 'debrief' ? this.buildDebrief() : null,
      teamScores: { ...this.teamScores },
      objectives: [],
      respawnAtTick: this.respawnAtTick,
      phaseEndsAtTick: null,
      save: this.save,
    };
  }

  private buildLobby(): LobbyView {
    const roster = this.roster.map(entry => ({ ...entry }));
    const starters = this.blockers(roster);
    return {
      revision: this.revision,
      captainId: this.captainId,
      mode: this.mode,
      mapId: this.mapId,
      missionId: this.missionId,
      joinPolicy: this.joinPolicy,
      roster,
      canStart: starters.length === 0,
      startBlockers: starters,
      botFill: this.botFill,
    };
  }

  private buildDebrief(): DebriefView {
    return {
      resultId: 'result-1',
      outcome: this.outcome,
      winningTeamId: null,
      rewardCredits: 0,
      repairCredits: 0,
      receiptId: null,
      nextMissionId: null,
      pilots: this.roster.map(entry => ({ pilotId: entry.pilotId, name: entry.name, teamId: entry.teamId, kills: 0, assists: 0, deaths: 0, departed: false })),
    };
  }

  private buildSelf(): SelfAuthority {
    const fit = this.local().fit;
    const derived = deriveFit(fit);
    const hull = this.life === 'destroyed' ? 0 : this.life === 'disabled' ? Math.round(derived.hullMax / 4) : derived.hullMax;
    const ship: ShipView = {
      id: LOCAL_SHIP_ID,
      pilotId: LOCAL_ID,
      lifeId: this.lifeId,
      teamId: this.local().teamId,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      angularVelocity: 0,
      fit,
      hull,
      hullMax: derived.hullMax,
      fuelKg: this.life === 'destroyed' ? 0 : derived.fuelCapacityKg,
      fuelMaxKg: derived.fuelCapacityKg,
      heatMJ: 0,
      heatMaxMJ: derived.heatCapacityMJ,
      capacitorMJ: derived.capacitorMJ,
      life: this.life,
    };
    return {
      tick: this.tick,
      ship,
      derived,
      activeInput: null,
      scheduledInputs: [],
      receivedSeq: 0,
      appliedSeq: 0,
      predictionState: {
        tick: this.tick,
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        angularVelocity: 0,
        fuelKg: ship.fuelKg,
        heatMJ: 0,
        capacitorMJ: derived.capacitorMJ,
        angularAssist: true,
      },
      weapons: derived.weaponSlots.map(slot => ({
        slotId: slot.slotId,
        partId: slot.partId,
        group: null,
        autoDefense: false,
        magazine: slot.magazine,
        reserve: slot.reserve,
        reloadEndsAtTick: null,
        chargeFraction: 0,
        readyAtTick: 0,
        blockedReason: null,
      })),
    };
  }
}
