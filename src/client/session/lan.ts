/**
 * LAN session adapter (Plan B1/B3/B4). The only place in the client that touches a socket, and the
 * only real implementation of `SessionPort`.
 *
 * In order of what the plan cares about:
 *   - handshake with a bounded deadline, resumable with a token, never a silent fallback to solo;
 *   - inputs sampled at their own cadence (B4.1), independently of render cadence, as full intents;
 *   - snapshots decoded from the binary codec, own ship reconciled through `Predictor`, remote ships
 *     interpolated with an adaptive delay;
 *   - a bounded, jittered reconnect inside the 60 s grace window;
 *   - one idempotent teardown for error, close and timeout.
 */

import { HEADER_BYTES, StringTable, decodeSnapshot } from '../../shared/codec.ts';
import type {
  ClientView, Command, CommandResult, ConnectOptions, ContactView, FlightIntent, Id, InputFrame, LinkState,
  NoticeCode, ObjectiveView, ProjectileView, Screen, SessionEvent, SessionPort, ShipView, Snapshot,
} from '../../shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../../shared/contracts.ts';
import type { ServerMessage, ViewMeta } from '../../shared/protocol.ts';
import { PROTOCOL_VERSION, SOCKET_PATH, parseServerMessage } from '../../shared/protocol.ts';
import { deriveFit } from '../../shared/catalog.ts';
import { Predictor, RemoteInterpolator, renderTickFor } from './prediction.ts';

export interface SocketLike {
  readyState: number;
  /** Browsers default to `blob`; the codec needs bytes, so the adapter asks for an ArrayBuffer. */
  binaryType?: string;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface LanSessionOptions {
  /** Overrides the address from `ConnectOptions`; mainly for tests and an explicit dev proxy. */
  url?: string;
  /** Injected so tests drive the transport without a network. */
  socketFactory?: SocketFactory;
  now?: () => number;
  inputHz?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  reconnectGraceMs?: number;
}

type ResolvedOptions = Required<Pick<LanSessionOptions, 'inputHz' | 'connectTimeoutMs' | 'commandTimeoutMs' | 'heartbeatMs' | 'staleMs' | 'reconnectGraceMs'>> & Pick<LanSessionOptions, 'url' | 'socketFactory' | 'now'>;

const DEFAULTS: Required<Pick<LanSessionOptions, 'inputHz' | 'connectTimeoutMs' | 'commandTimeoutMs' | 'heartbeatMs' | 'staleMs' | 'reconnectGraceMs'>> = {
  inputHz: RELEASE.inputHz,
  connectTimeoutMs: 5000,
  commandTimeoutMs: 10000,
  heartbeatMs: 5000,
  staleMs: 15000,
  reconnectGraceMs: RELEASE.reconnectSeconds * 1000,
};

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 5000] as const;
const READY_STATE_OPEN = 1;

export function socketUrl(address: string | undefined, location: { protocol: string; host: string } | null): string {
  if (address && address.length > 0) {
    const trimmed = address.replace(/\/+$/, '');
    if (/^wss?:\/\//.test(trimmed)) return `${trimmed}${SOCKET_PATH}`;
    if (trimmed.startsWith('https://')) return `wss://${trimmed.slice(8)}${SOCKET_PATH}`;
    if (trimmed.startsWith('http://')) return `ws://${trimmed.slice(7)}${SOCKET_PATH}`;
    return `ws://${trimmed}${SOCKET_PATH}`;
  }
  if (location) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${SOCKET_PATH}`;
  return `ws://127.0.0.1:8080${SOCKET_PATH}`;
}

const EMPTY_META: ViewMeta = {
  phase: null, link: 'idle', pilotId: null, epoch: null, tick: 0, lobby: null, campaign: null, host: null,
  debrief: null, save: 'clean', teamScores: {}, objectives: [], respawnAtTick: null, phaseEndsAtTick: null, map: null, economy: null,
};

const EMPTY_VIEW: ClientView = {
  phase: null, screenHint: 'title', link: 'idle', pilotId: null, epoch: null, tick: 0, lobby: null, self: null,
  ships: [], contacts: [], bodies: [], projectiles: [], weapons: [], map: null, campaign: null, host: null,
  debrief: null, teamScores: {}, objectives: [], respawnAtTick: null, phaseEndsAtTick: null, save: 'clean',
};

/** Frame type lives at byte 6 of every codec frame; the codec validates everything else. */
export function frameTypeOf(bytes: Uint8Array): number {
  return bytes.length >= HEADER_BYTES ? bytes[6]! : 0;
}

export class LanSession implements SessionPort {
  private readonly options: ResolvedOptions;
  private socket: SocketLike | null = null;
  private readonly table = new StringTable();
  private meta: ViewMeta = EMPTY_META;
  private ships: readonly ShipView[] = [];
  private bodies: ClientView['bodies'] = [];
  private projectiles: readonly ProjectileView[] = [];
  private contacts: readonly ContactView[] = [];
  private weapons: ClientView['weapons'] = [];
  private self: ClientView['self'] = null;
  private viewCache: ClientView = EMPTY_VIEW;
  private readonly subscribers = new Set<(view: ClientView) => void>();
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  private readonly pendingCommands = new Map<Id, { resolve: (result: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private predictor: Predictor | null = null;
  private predictorKey = '';
  private readonly remotes = new Map<Id, RemoteInterpolator>();
  private intent: FlightIntent = { ...EMPTY_FLIGHT_INTENT };
  private intentDirty = true;
  private inputSeq = 0;
  private inputTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectDeadline: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private reconnectDeadline = 0;
  private lastTrafficMs = 0;
  private resumeToken: string | null = null;
  /** The launcher's one-use operator claim, held until the handshake completes. */
  private operatorClaim: string | null = null;
  private connectOptions: ConnectOptions | null = null;
  private url: string;
  private closed = false;
  private link: LinkState = 'idle';
  private latencyMs = 0;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private lastEventWatermark = 0;
  private baselineChunks: Uint8Array[] = [];
  private baselineOpen = false;
  private abortListener: (() => void) | null = null;

  constructor(options: LanSessionOptions = {}) {
    this.options = { ...DEFAULTS, ...options } as ResolvedOptions;
    this.url = options.url ?? socketUrl(undefined, browserLocation());
  }

  connect(options: ConnectOptions, signal: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('session disposed'));
    this.connectOptions = options;
    this.url = this.options.url ?? socketUrl(options.address, browserLocation());
    this.setLink('connecting');
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      const abort = (): void => {
        this.failConnect(new Error('connect aborted'));
        this.closeIo('connect aborted');
      };
      this.abortListener = abort;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      this.connectDeadline = setTimeout(() => this.failConnect(new Error('handshake timeout')), this.options.connectTimeoutMs);
      this.openSocket();
    });
  }

  view(): ClientView {
    return this.viewCache;
  }

  /**
   * Rendered poses for the local ship (predicted) and remote ships (interpolated). The renderer asks
   * for these every frame; nothing else in the client is allowed to interpolate.
   */
  poses(dtSeconds: number, renderTick?: number): Map<Id, { position: { x: number; y: number }; angle: number }> {
    this.predictor?.decay(dtSeconds);
    const tick = renderTick ?? renderTickFor(this.meta.tick, this.remoteDelayMs() + this.latencyMs / 2);
    const poses = new Map<Id, { position: { x: number; y: number }; angle: number }>();
    const predicted = this.predictor ? this.predictor.predict(this.meta.tick, this.intent) : null;
    for (const ship of this.ships) {
      const local = ship.pilotId !== null && ship.pilotId === this.meta.pilotId;
      if (local && predicted && this.predictor) {
        poses.set(ship.id, { position: this.predictor.renderPosition(predicted), angle: predicted.angle });
        continue;
      }
      const sample = this.remotes.get(ship.id)?.sample(tick);
      poses.set(ship.id, sample ? { position: sample.position, angle: sample.angle } : { position: ship.position, angle: ship.angle });
    }
    return poses;
  }

  latency(): number {
    return this.latencyMs;
  }

  reconciliation(): { correcting: boolean; corrections: number } {
    return { correcting: this.predictor?.correcting() ?? false, corrections: this.predictor?.corrections() ?? 0 };
  }

  subscribe(listener: (view: ClientView) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  events(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  command(command: Command, requestId: Id): Promise<CommandResult> {
    if (this.closed || this.socket === null || this.socket.readyState !== READY_STATE_OPEN) {
      return Promise.resolve({ requestId, ok: false, code: 'denied', message: 'not connected' });
    }
    return new Promise<CommandResult>(resolve => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        resolve({ requestId, ok: false, code: 'denied', message: 'no response' });
      }, this.options.commandTimeoutMs);
      this.pendingCommands.set(requestId, { resolve, timer });
      this.send({ t: 'command', requestId, command });
    });
  }

  setIntent(intent: FlightIntent): void {
    this.intent = intent;
    this.intentDirty = true;
  }

  releaseControls(reason: 'blur' | 'hidden' | 'overlay' | 'pointer-cancel' | 'disconnect' | 'life-change'): void {
    this.intent = { ...EMPTY_FLIGHT_INTENT };
    this.intentDirty = true;
    // A dropped pointer and a hidden tab both need the authority to stop holding fire; only a real
    // disconnection or life change has nothing left to tell the server about.
    if (reason === 'disconnect' || reason === 'life-change') return;
    this.send({ t: 'release', epoch: this.meta.epoch ?? '', lifeId: this.self?.ship.lifeId ?? '', seq: ++this.inputSeq });
  }

  /** Ask for a fresh baseline; used after a renderer context restore (B4/B6). */
  requestBaseline(): void {
    this.baselineOpen = false;
    this.baselineChunks = [];
    this.send({ t: 'baseline-request' });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.releaseControls('disconnect');
    this.closed = true;
    this.closeIo('disposed');
    this.subscribers.clear();
    this.eventListeners.clear();
  }

  // ---- transport ---------------------------------------------------------------------------

  private openSocket(): void {
    const factory = this.options.socketFactory ?? defaultSocketFactory;
    const socket = factory(this.url);
    this.socket = socket;
    // A browser WebSocket hands binary frames over as Blobs unless it is asked for array buffers,
    // and the codec cannot read a Blob.
    if (typeof socket.binaryType === 'string' || socket.binaryType === undefined) socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      if (this.closed) return;
      this.setLink('handshake');
      // The launcher hands the operator a one-use claim in the URL fragment; it is consumed over
      // loopback and then erased, so it is never replayed by a reload, a bookmark or a screenshot.
      // It travels after the handshake, when the room has a connection to attach it to.
      this.operatorClaim ??= takeOperatorClaim();
      this.send({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        contentVersion: RELEASE.contentVersion,
        name: this.connectOptions?.pilotName ?? 'Pilot',
        roomCode: this.connectOptions?.roomCode ?? null,
        resumeToken: this.resumeToken,
        campaignId: this.connectOptions?.campaignId ?? null,
      });
    });
    socket.addEventListener('message', event => this.onFrame(event.data));
    socket.addEventListener('close', () => this.onClose());
    socket.addEventListener('error', () => this.onClose());
  }

  private onFrame(data: unknown): void {
    if (this.closed) return;
    this.lastTrafficMs = this.now();
    if (typeof data === 'string') {
      const parsed = parseServerMessage(data);
      if (parsed.ok) this.onServerMessage(parsed.value);
      return;
    }
    // Some embeddings ignore the arraybuffer request, so a Blob is read rather than dropped.
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then(buffer => this.onFrame(buffer)).catch(() => undefined);
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) return;
    if (frameTypeOf(bytes) === 1) {
      const decoded = decodeSnapshot(bytes, this.table);
      if (decoded.ok) this.applySnapshot(decoded.value);
      return;
    }
    // Baseline chunks are whole codec frames; hold them until the envelope verifies.
    if (this.baselineOpen) this.baselineChunks.push(bytes);
  }

  private onServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome': {
        this.resumeToken = message.resumeToken;
        this.reconnectAttempt = 0;
        this.reconnectDeadline = 0;
        if (this.operatorClaim !== null) {
          // One use only: the room consumes it, and a later reconnect must not replay it.
          this.send({ t: 'claim', token: this.operatorClaim });
          this.operatorClaim = null;
        }
        this.meta = { ...this.meta, pilotId: message.pilotId, epoch: message.epoch, tick: message.tick, phase: message.phase };
        this.setLink('online');
        this.startHeartbeat();
        this.startInputLoop();
        if (message.phase !== 'lobby') this.send({ t: 'baseline-request' });
        this.resolveConnect?.();
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.clearConnectDeadline();
        return;
      }
      case 'reject':
        this.failConnect(new Error(`${message.code}: ${message.message}`));
        this.closeIo(`rejected: ${message.code}`);
        return;
      case 'lobby':
        this.meta = { ...this.meta, lobby: message.lobby };
        this.publish();
        return;
      case 'meta': {
        const previousEpoch = this.meta.epoch;
        this.meta = message.meta;
        if (this.meta.epoch !== previousEpoch) {
          this.predictor = null;
          this.predictorKey = '';
          this.remotes.clear();
        }
        this.publish();
        return;
      }
      case 'receipt':
        // A receipt for a dead life means our prediction is stale; the next snapshot resets it.
        if (message.receipt.result === 'wrong-life') this.predictor = null;
        return;
      case 'command-result': {
        const pending = this.pendingCommands.get(message.result.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingCommands.delete(message.result.requestId);
        pending.resolve(message.result);
        return;
      }
      case 'baseline-header':
        this.baselineOpen = true;
        this.baselineChunks = [];
        this.setLink('loading');
        return;
      case 'baseline-end': {
        // Verified before install: a partially received or mismatched baseline is never applied.
        const chunks = this.baselineChunks;
        this.baselineOpen = false;
        this.baselineChunks = [];
        if (message.verified) this.installBaseline(chunks);
        this.setLink('online');
        return;
      }
      case 'event':
        this.lastEventWatermark = Math.max(this.lastEventWatermark, message.event.deliverySeq);
        for (const listener of this.eventListeners) listener(message.event);
        return;
      case 'notice':
        this.emitNotice(message.code, message.message);
        return;
      case 'pong':
        this.latencyMs = Math.max(0, this.now() - message.clientTimeMs);
        return;
      case 'goodbye':
        this.setLink('failed');
        this.closeIo(message.reason);
        return;
    }
  }

  private emitNotice(code: NoticeCode, text: string): void {
    const event: SessionEvent = {
      deliverySeq: this.lastEventWatermark,
      tick: this.meta.tick,
      epoch: this.meta.epoch ?? '',
      eventId: `notice:${code}:${this.meta.tick}`,
      kind: 'notice',
      payload: { code, message: text, forPilotId: this.meta.pilotId },
    } as SessionEvent;
    for (const listener of this.eventListeners) listener(event);
  }

  private installBaseline(chunks: readonly Uint8Array[]): void {
    for (const chunk of chunks) {
      if (frameTypeOf(chunk) !== 1) continue;
      const decoded = decodeSnapshot(chunk, this.table);
      if (decoded.ok) this.applySnapshot(decoded.value);
    }
  }

  private applySnapshot(snapshot: Snapshot): void {
    // A snapshot from a *newer* epoch is a new match: adopt it and drop state that belonged to the
    // previous one. A single socket cannot deliver an older epoch after a newer one, and refusing a
    // changed epoch outright left the flight screen with no world at all.
    if (this.meta.epoch !== null && snapshot.header.epoch !== this.meta.epoch) {
      this.predictor = null;
      this.predictorKey = '';
      this.remotes.clear();
    }
    this.meta = { ...this.meta, epoch: snapshot.header.epoch, tick: snapshot.header.tick, teamScores: snapshot.teamScores };
    this.ships = snapshot.ships;
    this.bodies = snapshot.bodies;
    this.projectiles = snapshot.projectiles;
    this.contacts = snapshot.contacts;
    this.weapons = snapshot.self ? snapshot.self.weapons : [];
    const previous = this.self;
    this.self = snapshot.self;
    if (snapshot.self) {
      const key = `${snapshot.self.ship.lifeId}:${snapshot.header.epoch}`;
      if (this.predictorKey !== key) {
        this.predictor = new Predictor(deriveFit(snapshot.self.ship.fit), snapshot.self.ship.fit.powerPriority);
        this.predictor.setLife(snapshot.self.ship.lifeId, snapshot.header.epoch);
        this.predictorKey = key;
      }
      this.predictor!.reconcile(snapshot.self.predictionState, snapshot.self.appliedSeq, previous?.predictionState ?? null);
    }
    for (const ship of snapshot.ships) {
      const local = ship.pilotId !== null && ship.pilotId === this.meta.pilotId;
      if (local) continue;
      let remote = this.remotes.get(ship.id);
      if (!remote) {
        remote = new RemoteInterpolator();
        this.remotes.set(ship.id, remote);
      }
      remote.push({ tick: snapshot.header.tick, position: ship.position, velocity: ship.velocity, angle: ship.angle });
    }
    this.publish();
  }

  private startInputLoop(): void {
    if (this.inputTimer !== undefined) return;
    // A fixed interval, not a recursive timeout: the sample rate must not drift with send cost.
    const periodMs = Math.max(1, Math.round(1000 / this.options.inputHz));
    this.inputTimer = setInterval(() => {
      if (this.closed) return;
      this.sendInput();
    }, periodMs);
  }

  private sendInput(): void {
    const self = this.self;
    if (!self) return;
    // A held control must be re-sent inside the server's 30-tick lease, or the ship would stop
    // thrusting 250 ms after the last change. Idle is silent: an empty intent is sent once, then
    // nothing until the pilot touches a control again.
    if (!this.intentDirty && !hasHeldControl(this.intent)) return;
    // Aim a little ahead of the newest snapshot so the authority schedules instead of correcting.
    const lead = Math.round((this.latencyMs / 2 / 1000) * RELEASE.physicsHz);
    const frame: InputFrame = {
      epoch: this.meta.epoch ?? '',
      lifeId: self.ship.lifeId,
      seq: ++this.inputSeq,
      targetTick: this.meta.tick + Math.max(1, lead),
      intent: this.intent,
    };
    this.predictor?.recordInput({ seq: frame.seq, applyAtTick: frame.targetTick, intent: frame.intent });
    this.send({ t: 'input', frame });
    this.intentDirty = false;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      if (this.now() - this.lastTrafficMs > this.options.staleMs) {
        this.beginReconnect();
        return;
      }
      this.send({ t: 'ping', nonce: (++this.inputSeq) & 0xffffffff, clientTimeMs: this.now() });
    }, this.options.heartbeatMs);
  }

  private beginReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined || !this.resumeToken) {
      if (!this.resumeToken) this.setLink('failed');
      return;
    }
    this.setLink('reconnecting');
    if (this.reconnectDeadline === 0) this.reconnectDeadline = this.now() + this.options.reconnectGraceMs;
    this.stopTimers();
    this.socket?.close(1000, 'stale');
    this.socket = null;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || !this.connectOptions) return;
      if (this.now() > this.reconnectDeadline) {
        this.setLink('failed');
        return;
      }
      this.openSocket();
    }, delay);
  }

  private send(message: unknown): void {
    if (this.socket === null || this.socket.readyState !== READY_STATE_OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      this.onClose();
    }
  }

  private onClose(): void {
    if (this.closed) return;
    if (this.link === 'connecting' || this.link === 'handshake') {
      this.failConnect(new Error('connection closed during handshake'));
      return;
    }
    if (this.resumeToken) this.beginReconnect();
    else this.setLink('failed');
  }

  private failConnect(error: Error): void {
    this.setLink('failed');
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.clearConnectDeadline();
  }

  private clearConnectDeadline(): void {
    clearTimeout(this.connectDeadline);
    this.connectDeadline = undefined;
  }

  private stopTimers(): void {
    clearInterval(this.inputTimer);
    clearInterval(this.heartbeatTimer);
    this.inputTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private closeIo(reason: string): void {
    this.stopTimers();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ requestId: 'unknown', ok: false, code: 'denied', message: reason });
    }
    this.pendingCommands.clear();
    this.socket?.close(1000, reason);
    this.socket = null;
  }

  private setLink(link: LinkState): void {
    this.link = link;
    this.meta = { ...this.meta, link };
    this.publish();
  }

  private publish(): void {
    this.viewCache = Object.freeze({
      ...EMPTY_VIEW,
      ...this.meta,
      link: this.link,
      screenHint: screenFor(this.meta, this.link),
      self: this.self,
      ships: this.ships,
      bodies: this.bodies,
      projectiles: this.projectiles,
      contacts: this.contacts,
      weapons: this.weapons,
      objectives: this.meta.objectives as readonly ObjectiveView[],
    }) as ClientView;
    for (const listener of this.subscribers) listener(this.viewCache);
  }

  private remoteDelayMs(): number {
    let delay = 100;
    for (const remote of this.remotes.values()) {
      remote.adapt(0);
      delay = remote.delayMs;
    }
    return delay;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

const defaultSocketFactory: SocketFactory = url => new WebSocket(url) as unknown as SocketLike;

/**
 * Read the operator claim from the launcher's URL fragment and take it out of the address bar. Only
 * a token shaped exactly like the launcher's is accepted, and it is never logged.
 */
function takeOperatorClaim(): string | null {
  const location = globalThis.location;
  if (!location || typeof location.hash !== 'string' || location.hash.length === 0) return null;
  const match = /(?:^|[#&])op=([A-Za-z0-9_-]{16,128})/.exec(location.hash);
  if (!match) return null;
  try {
    globalThis.history?.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {
    // A history replacement can be refused in exotic embeddings; the claim still travels once.
  }
  return match[1]!;
}

function browserLocation(): { protocol: string; host: string } | null {
  return typeof globalThis.location === 'object' && globalThis.location !== null
    ? { protocol: globalThis.location.protocol, host: globalThis.location.host }
    : null;
}

/** Any control the pilot is still holding, i.e. anything the lease has to keep alive. */
function hasHeldControl(intent: FlightIntent): boolean {
  return intent.thrust !== 0 || intent.turn !== 0 || intent.strafe !== 0
    || intent.brake || intent.boost || intent.fireMask !== 0;
}

function screenFor(meta: ViewMeta, link: LinkState): Screen {
  switch (meta.phase) {
    case 'lobby': return 'lobby';
    case 'loading':
    case 'countdown':
    case 'live':
    case 'extraction':
    case 'settlement': return 'flight';
    case 'debrief': return 'debrief';
    default: return link === 'failed' ? 'title' : 'title';
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
