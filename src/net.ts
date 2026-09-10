import { defaultLoadout } from './physics';
import { createRocks, mapById } from './world';
import type { LobbyPlayer, Loadout, PackedInput, PlayerMeta, RenderView, Rock, S2C, ScoreRow, TeamId, WireBullet, WirePlayer, WorldEvent } from './world';

/** ~3 snapshot intervals at 30 Hz: survives one dropped packet without extrapolating. */
const INTERP_DELAY = 100;
const SNAPSHOT_RING = 3;

export const DEFAULT_PORT = 8080;

/** Same origin in production; the Vite dev server on 5173 pairs with `bun run dev:server`. */
export function socketUrl(location: Location = window.location): string {
  if (location.port === '5173') return `ws://127.0.0.1:${DEFAULT_PORT}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export type NetHandlers = {
  onWelcome(msg: Extract<S2C, { t: 'welcome' }>): void;
  onLobby(msg: Extract<S2C, { t: 'lobby' }>): void;
  onBegin(msg: Extract<S2C, { t: 'begin' }>): void;
  onRocksFull(rocks: Rock[]): void;
  onEvents(events: WorldEvent[]): void;
  onDebrief(rows: ScoreRow[]): void;
  onBye(id: string): void;
  onClose(): void;
};

type Snapshot = { recvAt: number; players: WirePlayer[]; bullets: WireBullet[] };

export class Net {
  you = '';
  isHost = false;
  latency = 0;
  mapId = '';
  hostUrl = '';
  worldTime = 0;
  rocks = new Map<number, Rock>();
  /** Rocks this client has fractured or destroyed from server events. Diagnostics for the field guard. */
  splits = 0;
  gone = 0;

  private ws: WebSocket;
  private handlers: NetHandlers;
  private buf: Snapshot[] = [];
  private seq = 0;
  private rockAccumulator = 0;
  private name: string;
  private rosterOf = new Map<string, PlayerMeta>();
  private renderPlayers: WirePlayer[] = [];
  private renderBullets: WireBullet[] = [];
  private viewOut: RenderView = { players: this.renderPlayers, bullets: this.renderBullets };

  constructor(name: string, handlers: NetHandlers, url = socketUrl()) {
    this.name = name;
    this.handlers = handlers;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => this.send({ t: 'hello', name }));
    this.ws.addEventListener('message', event => this.receive(JSON.parse(String(event.data)) as S2C));
    this.ws.addEventListener('close', () => handlers.onClose());
    this.ws.addEventListener('error', () => handlers.onClose());
  }

  private send(message: unknown) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }

  sendInput(input: PackedInput) { this.send({ t: 'input', seq: ++this.seq, i: input }); }
  sendLobby(team: TeamId, loadout: Loadout, ready: boolean) {
    this.lastTeam = team; this.lastLoadout = loadout; this.lastReady = ready;
    this.send({ t: 'lobby', team, loadout, ready, name: this.name });
  }
  /** The map picker rides on the lobby message: only the host's choice is honoured server-side. */
  chooseMap(id: string) { this.send({ t: 'lobby', team: this.lastTeam, loadout: this.lastLoadout, ready: this.lastReady, name: this.name, mapId: id }); }
  start() { this.send({ t: 'start' }); }
  end() { this.send({ t: 'end' }); }

  private receive(msg: S2C) {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you; this.isHost = msg.you_is_host; this.mapId = msg.mapId; this.hostUrl = msg.host;
        this.handlers.onWelcome(msg);
        break;
      case 'lobby':
        this.mapId = msg.mapId;
        this.handlers.onLobby(msg);
        break;
      case 'begin': {
        this.mapId = msg.mapId;
        this.rosterOf = new Map(msg.players.map(p => [p.id, p]));
        this.rocks = createRocks(mapById(msg.mapId));
        this.buf.length = 0;
        this.handlers.onBegin(msg);
        break;
      }
      case 'rocksFull':
        this.rocks = new Map(msg.rocks.map(r => [r.id, r]));
        this.handlers.onRocksFull(msg.rocks);
        break;
      case 'snap':
        this.buf.push({ recvAt: performance.now(), players: msg.p, bullets: msg.b });
        if (this.buf.length > SNAPSHOT_RING) this.buf.shift();
        this.worldTime = msg.k / 120;
        break;
      case 'ev':
        this.applyEvents(msg.e);
        this.handlers.onEvents(msg.e);
        break;
      case 'debrief':
        this.handlers.onDebrief(msg.players);
        break;
      case 'pong':
        this.latency = Math.round(performance.now() - msg.c);
        break;
      case 'bye':
        this.handlers.onBye(msg.id);
        break;
    }
  }

  /** Late joiners are the only clients that ever see a whole rock field; everyone else gets events. */
  private applyEvents(events: WorldEvent[]) {
    for (const event of events) {
      if (event.e === 'rockSplit') {
        this.rocks.delete(event.id);
        for (const child of event.children) this.rocks.set(child.id, child);
        this.splits++;
      } else if (event.e === 'rockGone') {
        this.rocks.delete(event.id);
        this.gone++;
      }
    }
  }

  /**
   * Rock velocity is constant with no rock-vs-rock collision, so local integration never diverges from
   * the server, provided it uses the same fixed step. Frame deltas are accumulated, not consumed raw.
   */
  integrateRocks(dt: number) {
    this.rockAccumulator = Math.min(this.rockAccumulator + dt, 0.5);
    while (this.rockAccumulator >= 1 / 120) {
      for (const rock of this.rocks.values()) {
        if (rock.vx || rock.vy) { rock.x += rock.vx / 120; rock.y += rock.vy / 120; }
      }
      this.rockAccumulator -= 1 / 120;
    }
  }

  ping() { this.send({ t: 'ping', c: Math.round(performance.now()) }); }
  close() { this.ws.close(); }
  lastTeam: TeamId = 'blue';
  lastLoadout: Loadout = defaultLoadout('kestrel');
  lastReady = false;

  playerMeta(id: string) { return this.rosterOf.get(id); }

  private writeBullets(a: WireBullet[] | undefined, b: WireBullet[], t: number) {
    const out = this.renderBullets;
    for (let i = 0; i < b.length; i++) {
      const target = b[i];
      let slot = out[i];
      if (!slot) { slot = { ...target }; out.push(slot); }
      const prev = a?.find(p => p.id === target.id);
      slot.id = target.id; slot.vx = target.vx; slot.vy = target.vy; slot.tm = target.tm;
      slot.x = prev ? prev.x + (target.x - prev.x) * t : target.x;
      slot.y = prev ? prev.y + (target.y - prev.y) * t : target.y;
    }
    out.length = b.length;
  }

  private writePlayers(a: WirePlayer[] | undefined, b: WirePlayer[], t: number) {
    const out = this.renderPlayers;
    for (const target of b) {
      let slot = out.find(p => p.id === target.id);
      if (!slot) { slot = { ...target }; out.push(slot); }
      const prev = a?.find(p => p.id === target.id);
      if (!prev) { Object.assign(slot, target); continue; }
      slot.id = target.id;
      slot.x = prev.x + (target.x - prev.x) * t;
      slot.y = prev.y + (target.y - prev.y) * t;
      slot.vx = prev.vx + (target.vx - prev.vx) * t;
      slot.vy = prev.vy + (target.vy - prev.vy) * t;
      // Shortest arc, so a ship crossing the ±PI seam does not spin the long way round.
      slot.a = prev.a + wrapPi(target.a - prev.a) * t;
      slot.av = prev.av + (target.av - prev.av) * t;
      slot.hp = prev.hp + (target.hp - prev.hp) * t;
      slot.fu = prev.fu + (target.fu - prev.fu) * t;
      slot.ht = prev.ht + (target.ht - prev.ht) * t;
      slot.th = prev.th + (target.th - prev.th) * t;
      slot.ac = prev.ac + (target.ac - prev.ac) * t;
      slot.rcs = target.rcs; slot.dead = target.dead; slot.k = target.k; slot.d = target.d; slot.ack = target.ack;
    }
    for (let i = out.length - 1; i >= 0; i--) if (!b.some(p => p.id === out[i].id)) out.splice(i, 1);
  }

  /**
   * Interpolated world for this frame. Returns the same arrays every call, so rendering allocates nothing.
   * On a stall it holds the newest snapshot rather than extrapolating.
   */
  view(nowMs: number): RenderView {
    const ring = this.buf;
    if (!ring.length) { this.renderPlayers.length = 0; this.renderBullets.length = 0; return this.viewOut; }
    const newest = ring[ring.length - 1];
    const oldest = ring[0];
    const renderAt = nowMs - INTERP_DELAY;
    if (ring.length === 1 || renderAt >= newest.recvAt) {
      this.writePlayers(undefined, newest.players, 0);
      this.writeBullets(undefined, newest.bullets, 0);
      return this.viewOut;
    }
    if (renderAt <= oldest.recvAt) {
      this.writePlayers(undefined, oldest.players, 0);
      this.writeBullets(undefined, oldest.bullets, 0);
      return this.viewOut;
    }
    for (let i = ring.length - 1; i > 0; i--) {
      const b = ring[i], a = ring[i - 1];
      if (a.recvAt <= renderAt && renderAt <= b.recvAt) {
        const span = b.recvAt - a.recvAt;
        const t = span > 0 ? (renderAt - a.recvAt) / span : 0;
        this.writePlayers(a.players, b.players, t);
        this.writeBullets(a.bullets, b.bullets, t);
        return this.viewOut;
      }
    }
    this.writePlayers(undefined, newest.players, 0);
    this.writeBullets(undefined, newest.bullets, 0);
    return this.viewOut;
  }

  localPlayer(): WirePlayer | undefined { return this.renderPlayers.find(p => p.id === this.you); }
  bullets(): WireBullet[] { return this.renderBullets; }
}

export function wrapPi(angle: number) { return ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; }
