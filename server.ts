import { networkInterfaces } from 'node:os';
import { createShip, defaultLoadout } from './src/physics';
import { MAPS, TEAMS, createRocks, mapById, sanitizeLoadout, spawnPlayer, stepWorld, unpackInput } from './src/world';
import type { C2S, LobbyPlayer, Player, PlayerMeta, Rock, S2C, ScoreRow, TeamId, WireBullet, WirePlayer, World } from './src/world';

const PORT = Number(process.env.PORT ?? 8080);
const TICK = 1 / 120;
const BROADCAST_EVERY = 4;                       // 30 Hz
const DIST = './dist';
const MAX_NAME = 16;

type Sock = { id: string; name: string; isHost: boolean };
type Socket = Bun.ServerWebSocket<Sock>;

const world: World = {
  tick: 0, time: 0, phase: 'lobby', map: MAPS[0],
  players: new Map(), rocks: new Map(), bullets: [], events: [],
  nextEntityId: MAPS[0].rockCount + 1000,
};
const ready = new Set<string>();
const address = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
const lanUrl = `http://${address}:${PORT}`;
let mapId = MAPS[0].id;
let hostId: string | null = null;

const cleanName = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) || 'Pilot';
const round = (_key: string, value: unknown) => typeof value === 'number' ? Math.round(value * 100) / 100 : value;

function wirePlayer(p: Player): WirePlayer {
  const s = p.ship;
  return {
    id: p.id, x: s.position.x, y: s.position.y, vx: s.velocity.x, vy: s.velocity.y,
    a: s.angle, av: s.angularVelocity, hp: s.hull, fu: s.fuel, ht: s.heat, th: s.thrustLevel, ac: s.acceleration,
    rcs: s.rcsActive ? 1 : 0, dead: p.dead ? 1 : 0, k: p.kills, d: p.deaths, ack: p.lastSeq,
  };
}

const metaOf = (p: Player): PlayerMeta => ({ id: p.id, name: p.name, team: p.team, loadout: p.loadout });
const lobbyOf = (p: Player, isHost: boolean): LobbyPlayer => ({ ...metaOf(p), ready: ready.has(p.id), isHost });

function lobbyPayload(): string {
  return JSON.stringify({ t: 'lobby', players: [...world.players.values()].map(p => lobbyOf(p, p.id === hostId)), mapId } satisfies S2C, round);
}

function beginPayload(): string {
  return JSON.stringify({
    t: 'begin', mapSeed: world.map.seed, mapId: world.map.id,
    players: [...world.players.values()].map(metaOf), startTick: world.tick,
  } satisfies S2C, round);
}

function snapshotPayload(): string {
  const p: WirePlayer[] = [];
  for (const player of world.players.values()) p.push(wirePlayer(player));
  const b: WireBullet[] = world.bullets.map(bullet => ({ id: bullet.id, x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy, tm: bullet.ttl }));
  return JSON.stringify({ t: 'snap', k: world.tick, p, b } satisfies S2C, round);
}

function broadcast(force = false) {
  if (world.phase !== 'playing') return;
  server.publish('game', snapshotPayload());
  if (force || world.events.length) {
    const events = world.events.splice(0, world.events.length);
    if (events.length) server.publish('events', JSON.stringify({ t: 'ev', k: world.tick, e: events } satisfies S2C, round));
  }
}

function startMatch() {
  world.map = mapById(mapId);
  world.rocks = createRocks(world.map);
  world.bullets = [];
  world.events = [];
  world.tick = 0; world.time = 0;
  world.nextEntityId = world.map.rockCount + 1000;
  let salt = 0;
  for (const p of world.players.values()) { p.kills = 0; p.deaths = 0; spawnPlayer(world, p, salt++); }
  world.phase = 'playing';
  server.publish('match', beginPayload());
  broadcast(true);
}

function endMatch() {
  server.publish('match', JSON.stringify({ t: 'debrief', players: scoreboard() } satisfies S2C, round));
  world.phase = 'lobby';
  world.bullets = [];
  world.rocks = new Map<number, Rock>();
  for (const p of world.players.values()) { p.dead = false; p.kills = 0; p.deaths = 0; p.ship = createShip(p.loadout.chassis, p.loadout); }
  ready.clear();
  server.publish('lobby', lobbyPayload());
}

const scoreboard = (): ScoreRow[] => [...world.players.values()]
  .map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths }))
  .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

function addPlayer(id: string, name: string) {
  const loadout = defaultLoadout('kestrel');
  const player: Player = {
    id, name, team: 'blue', loadout,
    ship: createShip(loadout.chassis, loadout),
    dead: false, respawnAt: 0, kills: 0, deaths: 0, cooldown: 0,
    input: { thrust: 0, turn: 0, strafe: 0, brake: false, boost: false, fire: false },
    lastSeq: 0,
  };
  world.players.set(id, player);
  return player;
}

/** Keep teams as even as the roster allows; a live joiner does not get to pick a side mid-match. */
function pickTeam(id: string): TeamId {
  let best: TeamId = 'blue', bestCount = Number.POSITIVE_INFINITY;
  for (const team of TEAMS) {
    let count = 0;
    for (const p of world.players.values()) if (p.team === team && p.id !== id) count++;
    if (count < bestCount) { best = team; bestCount = count; }
  }
  return best;
}

function onHello(ws: Socket, msg: Extract<C2S, { t: 'hello' }>) {
  ws.data.name = cleanName(msg.name);
  if (!world.players.has(ws.data.id)) addPlayer(ws.data.id, ws.data.name);
  if (!hostId || !world.players.has(hostId)) hostId = ws.data.id;
  ws.data.isHost = ws.data.id === hostId;
  ws.subscribe('lobby'); ws.subscribe('match'); ws.subscribe('game'); ws.subscribe('events');
  ws.send(JSON.stringify({ t: 'welcome', you: ws.data.id, you_is_host: ws.data.isHost, mapId, host: lanUrl } satisfies S2C, round));

  const p = world.players.get(ws.data.id)!;
  if (world.phase === 'playing') {
    // Late join: rebuild the map from the seed, then replace it with the live rock field.
    p.team = pickTeam(p.id);
    spawnPlayer(world, p, world.players.size);
    ws.send(beginPayload());
    ws.send(JSON.stringify({ t: 'rocksFull', rocks: [...world.rocks.values()] } satisfies S2C, round));
    world.events.push({ e: 'join', player: metaOf(p) });
    broadcast(true);
  }
  server.publish('lobby', lobbyPayload());
}

function onLobby(ws: Socket, msg: Extract<C2S, { t: 'lobby' }>) {
  if (world.phase !== 'lobby') return;
  const p = world.players.get(ws.data.id);
  if (!p) return;
  if (msg.name !== undefined) { p.name = cleanName(msg.name); ws.data.name = p.name; }
  if (TEAMS.includes(msg.team)) p.team = msg.team;
  p.loadout = sanitizeLoadout(msg.loadout);
  p.ship = createShip(p.loadout.chassis, p.loadout);
  if (msg.ready) ready.add(p.id); else ready.delete(p.id);
  if (ws.data.id === hostId && typeof msg.mapId === 'string' && MAPS.some(m => m.id === msg.mapId)) mapId = msg.mapId;
  server.publish('lobby', lobbyPayload());
}

function onInput(ws: Socket, msg: Extract<C2S, { t: 'input' }>) {
  if (world.phase !== 'playing') return;
  const p = world.players.get(ws.data.id);
  if (!p || typeof msg.seq !== 'number' || msg.seq <= p.lastSeq) return;   // out-of-order arrival
  p.input = unpackInput(msg.i);
  p.lastSeq = msg.seq;
}

function onDisconnect(id: string) {
  ready.delete(id);
  if (!world.players.delete(id)) return;
  if (world.phase === 'playing') {
    world.events.push({ e: 'leave', id });
    // An empty server returns to the lobby, so the next pilot is not dropped into a dead match.
    if (world.players.size === 0) return endMatch();
  }
  if (hostId === id) hostId = world.players.keys().next().value ?? null;
  server.publish('lobby', lobbyPayload());
}

function onMessage(ws: Socket, msg: C2S) {
  switch (msg.t) {
    case 'hello': onHello(ws, msg); break;
    case 'lobby': onLobby(ws, msg); break;
    case 'input': onInput(ws, msg); break;
    case 'ping': ws.send(JSON.stringify({ t: 'pong', c: msg.c } satisfies S2C)); break;
    case 'respawn': break;                                    // accepted and ignored: the timer owns respawn
    case 'start':
      if (ws.data.id === hostId && world.phase === 'lobby' && world.players.size > 0) startMatch();
      break;
    case 'end':
      if (ws.data.id === hostId && world.phase === 'playing') endMatch();
      break;
  }
}

// MUST be 0.0.0.0, not 127.0.0.1, or no other PC on the LAN can reach the host.
const server = Bun.serve<Sock>({
  hostname: '0.0.0.0',
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const upgraded = srv.upgrade(req, { data: { id: crypto.randomUUID().slice(0, 8), name: '', isHost: false } });
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname.includes('..')) return new Response('bad path', { status: 400 });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(DIST + path);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(DIST + '/index.html'));
  },
  websocket: {
    open() { /* wait for hello */ },
    message(ws, raw) {
      try { onMessage(ws, JSON.parse(String(raw)) as C2S); } catch { /* ignore malformed frames */ }
    },
    close(ws) { onDisconnect(ws.data.id); },
  },
});

const acc = { value: 0, last: performance.now() };
setInterval(() => {
  const now = performance.now();
  acc.value += Math.min((now - acc.last) / 1000, 0.25);     // same 0.25 s clamp as the client loop
  acc.last = now;
  while (acc.value >= TICK) {
    if (world.phase === 'playing') stepWorld(world, TICK);
    acc.value -= TICK;
    if (world.tick % BROADCAST_EVERY === 0) broadcast();
  }
}, 4);

console.log(`\n  DRIFT host ready\n  local:   http://localhost:${PORT}\n  LAN:     ${lanUrl}\n  other players open the LAN address\n`);
