/**
 * The one Windows port (Plan B2). Assets, `/health`, `/api/info`, the bootstrap shell and `/ws` are
 * served by the same listener so a guest only needs a browser and a URL. Binding is `0.0.0.0`; the
 * advertised address is the operator-selected adapter, because "listen on all" and "tell guests
 * where to go" are different decisions and only the operator can make the second one.
 *
 * Absolute dist root plus normalized containment, unknown assets 404, known UI routes return the
 * shell, and a busy port offers a choice rather than killing whoever owns it.
 */

import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { RELEASE } from '../shared/contracts.ts';
import type { Mode } from '../shared/contracts.ts';
import { hash32 } from '../shared/ids.ts';
import { CAMPAIGN_MISSIONS } from '../sim/campaign/missions.ts';
import {
  advance as advanceCampaign, applyObjectiveEvent, commitDecision, createCampaignRuntime, resetToCheckpoint,
  viewObjectives, type CampaignRuntime,
} from '../sim/campaign/runtime.ts';
import { missionDefinition, nextMission } from '../sim/campaign/missions.ts';
import type { Id } from '../shared/contracts.ts';
import type { InteractionFacts } from './room.ts';
import { NetLayer } from './net.ts';
import type { SocketData } from './net.ts';
import { OperatorAuthority, isLoopback } from './operator.ts';
import { Room } from './room.ts';
import type { RoomOptions } from './room.ts';
import { encodeQr, qrToText } from './qr.ts';
import type { HostStorePort } from './store-port.ts';

export interface AdapterInfo {
  name: string;
  address: string;
  kind: 'wifi' | 'ethernet' | 'vpn' | 'virtual' | 'other';
  preferred: boolean;
}

/** Paths a browser may load directly; anything else is a 404, never the shell. */
const UI_ROUTES = new Set(['/', '/index.html', '/host', '/join', '/lobby', '/campaign', '/hangar', '/flight', '/debrief']);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export function classifyAdapter(name: string): AdapterInfo['kind'] {
  const lower = name.toLowerCase();
  if (/vpn|wireguard|openvpn|nordlynx|proton|tailscale|zerotier|wintun|\btap\b|\btun\d*|hamachi|radmin/.test(lower)) return 'vpn';
  // Before `ethernet`: a Hyper-V switch is literally named `vEthernet (...)`, and advertising it
  // would send guests to an address that only exists inside this machine.
  if (/virtual|vmware|virtualbox|hyper-?v|vethernet|docker|loopback|bluetooth|npcap|bridge|pseudo/.test(lower)) return 'virtual';
  if (/wi-?fi|wlan|wireless|wlp|ath\d|802\.11/.test(lower)) return 'wifi';
  if (/ethernet|eth\d|en\d|eno\d|enp|本地连接|以太网/.test(lower)) return 'ethernet';
  return 'other';
}

/** IPv4 adapters with the physical Wi-Fi/Ethernet ones preferred; never assume the first is usable. */
export function listAdapters(): AdapterInfo[] {
  const adapters: AdapterInfo[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      const kind = classifyAdapter(name);
      adapters.push({ name, address: entry.address, kind, preferred: kind === 'wifi' || kind === 'ethernet' });
    }
  }
  return adapters;
}

export function selectAdapter(adapters: readonly AdapterInfo[], requested: string | null): AdapterInfo | null {
  if (requested !== null) return adapters.find(adapter => adapter.address === requested) ?? null;
  return adapters.find(adapter => adapter.preferred) ?? adapters.find(adapter => adapter.kind !== 'virtual' && adapter.kind !== 'vpn') ?? adapters[0] ?? null;
}

export interface HostOptions {
  port?: number;
  distRoot: string;
  hostName?: string;
  mode?: Mode;
  mapId?: string;
  joinPolicy?: 'open' | 'code' | 'closed';
  roomCode?: string | null;
  adapter?: string | null;
  devOrigins?: readonly string[];
  store?: HostStorePort | null;
  campaignId?: string | null;
  missionId?: string | null;
  seed?: number;
  /** Tests drive the room by hand; production lets the room own its 120 Hz loop. */
  autoLoop?: boolean;
  operatorRequired?: boolean;
  /** Private QR carries the room code only when the operator explicitly asks. */
  qrIncludesRoomCode?: boolean;
}

export interface HostHandle {
  server: Bun.Server<SocketData>;
  room: Room;
  net: NetLayer;
  operator: OperatorAuthority;
  port: number;
  guestOrigin: string;
  operatorOrigin: string;
  /** Null when no IPv4 adapter was found; the guest URL is then loopback only. */
  adapter: AdapterInfo | null;
  stop(): Promise<{ ok: boolean; saved: boolean }>;
}

export interface RuntimeFile {
  pid: number;
  port: number;
  guestOrigin: string;
  operatorUrl: string;
  adminToken: string;
  startedAt: string;
  protocol: number;
  contentVersion: string;
}

export async function createHost(options: HostOptions): Promise<HostHandle> {
  const adapters = listAdapters();
  const adapter = selectAdapter(adapters, options.adapter ?? null);
  const guestHost = adapter?.address ?? '127.0.0.1';
  const seed = (options.seed ?? hash32(options.mapId ?? 'belt')) >>> 0;
  const mode = options.mode ?? 'skirmish';
  const roomOptions: RoomOptions = {
    roomId: 'room-1',
    hostName: options.hostName ?? 'Wayfarer',
    mode,
    mapId: options.mapId ?? 'belt',
    seed,
    joinPolicy: options.joinPolicy ?? 'open',
    roomCode: options.roomCode ?? null,
    operatorRequired: options.operatorRequired ?? true,
    devOrigins: options.devOrigins ?? [],
    store: options.store ?? null,
    campaignId: options.campaignId ?? null,
  };
  const room = new Room(roomOptions);
  if (mode === 'campaign') {
    // The campaign runtime is the only mission-rules implementation; the room drives it by tick and
    // reads objectives out of it rather than re-deriving mission state.
    const mission = missionDefinition(options.missionId ?? CAMPAIGN_MISSIONS[0]!.id);
    const runtime = createCampaignRuntime(options.missionId ?? CAMPAIGN_MISSIONS[0]!.id, seed, 0);
    const objectiveForEntity = new Map<string, { objectiveId: string; itemId: string | null }>();
    for (const objective of mission?.objectives ?? []) {
      // A client may name the objective, one of its items, or the berth; all three resolve.
      objectiveForEntity.set(objective.id, { objectiveId: objective.id, itemId: null });
      for (const itemId of objective.items) objectiveForEntity.set(itemId, { objectiveId: objective.id, itemId });
      if (objective.requiresBerth) objectiveForEntity.set(`berth:${objective.id}`, { objectiveId: objective.id, itemId: null });
    }
    room.attachCampaign({
      viewObjectives: () => viewObjectives(runtime),
      advance: tick => advanceCampaign(runtime, tick),
      commitDecision: (decisionId, optionId) => commitDecision(runtime, decisionId, optionId),
      resetToCheckpoint: () => resetToCheckpoint(runtime),
      resolve: entityId => objectiveForEntity.get(entityId) ?? null,
      settlement: () => mission === null
        ? null
        : {
          rewardCredits: mission.rewardCredits,
          receiptId: mission.receiptId,
          nextMissionId: nextMission(mission.id)?.id ?? null,
        },
      interact: input => evaluateInteraction(runtime, input),
      observe: input => evaluateInteraction(runtime, input),
    });
  }
  const operator = new OperatorAuthority();
  // The claim is installed before the first socket can arrive, so the launcher URL is the only
  // place it ever exists.
  room.installOperatorClaim(operator.claim);
  const net = new NetLayer({
    room,
    devOrigins: options.devOrigins ?? [],
    rejectMissingOrigin: true,
  });
  const distRoot = path.resolve(options.distRoot);
  const requestedPort = options.port ?? 8080;
  const server = listen(requestedPort, distRoot, room, net, operator);

  const port = server.port ?? requestedPort;
  const guestOrigin = `http://${guestHost}:${port}`;
  const operatorOrigin = `http://127.0.0.1:${port}`;
  room.setOrigins(guestOrigin, operatorOrigin);
  if (options.autoLoop ?? true) room.startLoop();

  return {
    server,
    room,
    net,
    operator,
    port,
    guestOrigin,
    operatorOrigin,
    adapter,
    stop: async () => {
      const result = await room.shutdown();
      server.stop(true);
      return result;
    },
  };
}

/**
 * Turn one measured interaction into a campaign observation. The runtime owns every tolerance, so a
 * rejection carries its own reason (`out-of-range`, `too-fast`, `berth-blocked`, …) and the room only
 * relays it.
 */
function evaluateInteraction(
  runtime: CampaignRuntime,
  input: { pilotId: Id; isBot: boolean; objectiveId: Id; itemId: Id | null; tick: number; facts: InteractionFacts },
): { accepted: boolean; code: string } {
  const outcome = applyObjectiveEvent(runtime, {
    objectiveId: input.objectiveId,
    kind: 'observe',
    itemId: input.itemId,
    pilotId: input.pilotId,
    isBot: input.isBot,
    tick: input.tick,
    distanceM: input.facts.distanceM,
    relativeSpeedMS: input.facts.relativeSpeedMS,
    lineOfSight: input.facts.lineOfSight,
    targetAlive: input.facts.targetAlive,
    pilotAlive: input.facts.pilotAlive,
    headingErrorDeg: input.facts.headingErrorDeg,
    berthClear: input.facts.berthClear,
    queueVisible: input.facts.queueVisible,
  });
  return { accepted: outcome.accepted, code: outcome.code };
}

function listen(port: number, distRoot: string, room: Room, net: NetLayer, operator: OperatorAuthority): Bun.Server<SocketData> {
  return Bun.serve<SocketData>({
    hostname: '0.0.0.0',
    port,
    development: false,
    fetch: (request, server) => handleRequest(request, server, distRoot, room, net, operator),
    websocket: net.handlers,
  });
}

function handleRequest(
  request: Request,
  server: Bun.Server<SocketData>,
  distRoot: string,
  room: Room,
  net: NetLayer,
  operator: OperatorAuthority,
): Response | Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname;
  if (route === '/health') return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (route === '/api/info') return json(room.info());
  if (route === '/api/shutdown') return shutdown(request, server, room, operator);
  if (route === '/api/host/configure') return hostConfigure(request, server, room);
  if (route === '/api/host/stop') return hostStop(request, server, room, operator);
  if (route === '/api/host/start' || route === '/api/host/claim') return hostUnavailable(route.slice('/api/host/'.length));
  if (route === '/api/operator/reclaim') return reclaim(request, server, room, operator);
  if (route === '/ws') {
    if (!net.originAllowed(request.headers.get('origin'))) return new Response('origin refused', { status: 403 });
    const upgraded = net.upgrade(request, server);
    return upgraded ? new Response(null, { status: 101 }) : new Response('room full', { status: 503 });
  }
  return asset(route, distRoot);
}

/** Authenticated loopback shutdown; it answers only after the room acknowledged its checkpoint. */
async function shutdown(request: Request, server: Bun.Server<SocketData>, room: Room, operator: OperatorAuthority): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const token = bearer(request);
  const peer = adminPeer(request, server);
  if (token === null || !isLoopback(peer.remoteAddress) || !operator.verifyAdmin(token)) {
    return new Response('refused', { status: 403 });
  }
  const result = await room.shutdown();
  return json({ ok: result.ok, saved: result.saved }, result.ok ? 200 : 503);
}

/**
 * Host-screen settings, applied to the room before anyone is seated (B2). This is the operator's own
 * machine, so the bar is the same one the operator claim is consumed under — loopback peer *and* an
 * allowed Origin, never `Host: localhost` alone. Process-level actions still need the admin token.
 */
async function hostConfigure(request: Request, server: Bun.Server<SocketData>, room: Room): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const peer = adminPeer(request, server);
  if (!isLoopback(peer.remoteAddress) || !room.originAllowed(request.headers.get('origin'))) {
    return json({ ok: false, code: 'denied', message: 'The host is configured from this PC' }, 403);
  }
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: 'denied', message: 'malformed configuration' }, 400);
  }
  if (typeof body !== 'object' || body === null) return json({ ok: false, code: 'denied', message: 'malformed configuration' }, 400);
  const patch = body as { mode?: unknown; joinPolicy?: unknown; roomCode?: unknown };
  const mode = patch.mode === 'campaign' || patch.mode === 'skirmish' || patch.mode === 'team-deathmatch' ? patch.mode : undefined;
  const joinPolicy = patch.joinPolicy === 'open' || patch.joinPolicy === 'code' || patch.joinPolicy === 'closed' ? patch.joinPolicy : undefined;
  const roomCode = typeof patch.roomCode === 'string' && patch.roomCode.length <= 16 ? patch.roomCode : undefined;
  if (mode === undefined && joinPolicy === undefined && roomCode === undefined) {
    return json({ ok: false, code: 'denied', message: 'nothing to configure' }, 400);
  }
  const result = room.configureHost({ mode, joinPolicy, roomCode });
  return json({ ok: result.ok, code: result.code, revision: result.revision });
}

/**
 * Host stop from the Host screen. The browser operator holds captaincy, not the launcher's admin
 * token, so an unauthorised call answers with a typed refusal instead of a 4xx the page would log as
 * a console error; the launcher's authenticated `/api/shutdown` still performs the real stop.
 */
async function hostStop(request: Request, server: Bun.Server<SocketData>, room: Room, operator: OperatorAuthority): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const token = bearer(request);
  const peer = adminPeer(request, server);
  if (token === null || !isLoopback(peer.remoteAddress) || !operator.verifyAdmin(token)) {
    return json({ ok: false, code: 'denied', message: 'Stop hosting from the launcher on this PC' });
  }
  const result = await room.shutdown();
  return json({ ok: result.ok, saved: result.saved });
}

/** Actions only the launcher can take, answered with a reason rather than a missing route. */
function hostUnavailable(action: string): Response {
  return json({
    ok: false,
    code: 'unsupported',
    message: action === 'start'
      ? 'The launcher starts the host process; this page cannot.'
      : 'The operator claim arrives in the launch link.',
  });
}

/** Mints a fresh one-use claim for the operator's next local admin session. */
function reclaim(request: Request, server: Bun.Server<SocketData>, room: Room, operator: OperatorAuthority): Response {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const token = bearer(request);
  const peer = adminPeer(request, server);
  if (token === null || !isLoopback(peer.remoteAddress) || !operator.verifyAdmin(token)) return new Response('refused', { status: 403 });
  operator.issueClaim();
  room.installOperatorClaim(operator.claim);
  return json({ ok: true, expiresAt: operator.claim.expiresAt });
}

/** Bun reports the peer itself; a proxy header is never trusted for an admin route. */
function adminPeer(request: Request, server: Bun.Server<SocketData>): { remoteAddress: string; origin: string | null } {
  return { remoteAddress: server.requestIP(request)?.address ?? '', origin: request.headers.get('origin') };
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Absolute root, normalized containment, no traversal escape and no query-string directory walk. */
export function resolveAsset(distRoot: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const normalized = path.posix.normalize(decoded.startsWith('/') ? decoded : `/${decoded}`);
  if (normalized.includes('..')) return null;
  const full = path.resolve(distRoot, `.${normalized}`);
  if (full !== distRoot && !full.startsWith(distRoot + path.sep)) return null;
  return full;
}

async function asset(route: string, distRoot: string): Promise<Response> {
  const target = route === '/' ? '/index.html' : route;
  const file = resolveAsset(distRoot, target);
  if (file !== null && existsSync(file)) {
    return new Response(Bun.file(file), { headers: { 'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  }
  if (UI_ROUTES.has(route)) {
    const shell = path.join(distRoot, 'index.html');
    if (existsSync(shell)) return new Response(Bun.file(shell), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('build missing', { status: 503 });
  }
  return new Response('not found', { status: 404 });
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

interface CliOptions {
  port: number;
  dist: string;
  data: string;
  name: string;
  adapter: string | null;
  devOrigins: string[];
  nonInteractive: boolean;
  readyFile: string | null;
  stop: boolean;
  printAdapters: boolean;
  qrRoomCode: boolean;
  roomCode: string | null;
  mode: Mode;
  help: boolean;
}

export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const options: CliOptions = {
    port: 8080,
    dist: path.resolve(cwd, 'dist'),
    data: path.join(process.env.LOCALAPPDATA ?? cwd, 'DRIFT', 'host'),
    name: 'Wayfarer',
    adapter: null,
    devOrigins: [],
    nonInteractive: false,
    readyFile: null,
    stop: false,
    printAdapters: false,
    qrRoomCode: false,
    roomCode: null,
    mode: 'skirmish',
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const value = (): string => argv[++index] ?? '';
    switch (flag) {
      case '--port': options.port = Number(value()); break;
      case '--dist': options.dist = path.resolve(cwd, value()); break;
      case '--data': options.data = path.resolve(cwd, value()); break;
      case '--name': options.name = value(); break;
      case '--adapter': options.adapter = value(); break;
      case '--dev-origin': options.devOrigins.push(value()); break;
      case '--non-interactive': options.nonInteractive = true; break;
      case '--ready-file': options.readyFile = path.resolve(cwd, value()); break;
      case '--stop': options.stop = true; break;
      case '--print-adapters': options.printAdapters = true; break;
      case '--qr-room-code': options.qrRoomCode = true; break;
      case '--room-code': options.roomCode = value(); break;
      case '--mode': options.mode = value() as Mode; break;
      case '--help': options.help = true; break;
      default: break;
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) options.port = 8080;
  return options;
}

function usage(): string {
  return [
    'DRIFT host',
    '  --port <1024-65535>   listen port (default 8080)',
    '  --dist <path>         built asset root (default <cwd>/dist)',
    '  --data <path>         host data directory (default %LOCALAPPDATA%\\DRIFT\\host)',
    '  --name <text>         host pilot name',
    '  --adapter <ipv4>      advertise this adapter address',
    '  --dev-origin <url>    additionally allowed browser origin (repeatable)',
    '  --room-code <code>    require a room code to join',
    '  --qr-room-code        include the room code in the printed QR',
    '  --ready-file <path>   write the runtime JSON here as well',
    '  --non-interactive     never prompt; exit 4 on a busy port',
    '  --print-adapters      print IPv4 adapters as JSON and exit',
    '  --stop                stop the running host through its admin token',
    '  --help                this text',
  ].join('\n');
}

export function runtimePath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

export function writeRuntimeFile(dataDir: string, runtime: RuntimeFile): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(runtimePath(dataDir), `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
}

export function readRuntimeFile(dataDir: string): RuntimeFile | null {
  const file = runtimePath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RuntimeFile;
    return typeof parsed.port === 'number' && typeof parsed.adminToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads the running host's runtime file and asks it to stop; never kills a process by name. */
export async function stopRunningHost(dataDir: string): Promise<number> {
  const runtime = readRuntimeFile(dataDir);
  if (runtime === null) {
    console.error('No running DRIFT host was found for this data directory.');
    return 2;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runtime.adminToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as { ok?: boolean; saved?: boolean };
    if (response.ok && body.ok && body.saved) {
      rmSync(runtimePath(dataDir), { force: true });
      console.log('DRIFT host stopped after saving its checkpoint.');
      return 0;
    }
    console.error(`DRIFT host refused to stop (${response.status}); the checkpoint was not acknowledged.`);
    return 3;
  } catch (error) {
    console.error(`DRIFT host did not acknowledge the shutdown: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}

export async function main(argv: readonly string[] = Bun.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const options = parseArgs(argv, cwd);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.printAdapters) {
    console.log(JSON.stringify(listAdapters(), null, 2));
    return 0;
  }
  if (options.stop) return stopRunningHost(options.data);

  const handle = await startWithPortChoice(options);
  if (handle === null) return 4;
  const runtime: RuntimeFile = {
    pid: process.pid,
    port: handle.port,
    guestOrigin: handle.guestOrigin,
    operatorUrl: handle.operator.operatorUrl(`${handle.operatorOrigin}/`),
    adminToken: handle.operator.adminToken,
    startedAt: new Date().toISOString(),
    protocol: RELEASE.protocol,
    contentVersion: RELEASE.contentVersion,
  };
  writeRuntimeFile(options.data, runtime);
  if (options.readyFile !== null) {
    mkdirSync(path.dirname(options.readyFile), { recursive: true });
    writeFileSync(options.readyFile, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  }
  printReady(handle, runtime, options.qrRoomCode, options.roomCode);
  return new Promise<number>(resolve => {
    const finish = (): void => {
      rmSync(runtimePath(options.data), { force: true });
      resolve(0);
    };
    process.on('SIGINT', () => {
      void handle.stop().then(finish);
    });
    process.on('SIGTERM', () => {
      void handle.stop().then(finish);
    });
  });
}

async function startWithPortChoice(options: CliOptions): Promise<HostHandle | null> {
  let port = options.port;
  for (;;) {
    try {
      const handle = await createHost({
        port,
        distRoot: options.dist,
        hostName: options.name,
        adapter: options.adapter,
        devOrigins: options.devOrigins,
        joinPolicy: options.roomCode !== null ? 'code' : 'open',
        roomCode: options.roomCode,
        mode: options.mode,
      });
      return handle;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/EADDRINUSE|address already in use/i.test(message)) throw error;
      console.error(`Port ${port} is already in use. Another program owns it; DRIFT will not stop it.`);
      if (options.nonInteractive) return null;
      const choice = await promptForPort(port + 1);
      if (choice === null) return null;
      port = choice;
    }
  }
}

function promptForPort(suggested: number): Promise<number | null> {
  if (!process.stdin.isTTY) return Promise.resolve(suggested);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<number | null>(resolve => {
    rl.question(`Press Enter for port ${suggested}, or type another port (1024-65535): `, answer => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '') return resolve(suggested);
      const parsed = Number(trimmed);
      resolve(Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : suggested);
    });
  });
}

function printReady(handle: HostHandle, runtime: RuntimeFile, qrRoomCode: boolean, roomCode: string | null): void {
  // The public QR never carries the operator claim or a resume token; a room code is added only
  // when the operator explicitly asks for it.
  const qrTarget = qrRoomCode && roomCode !== null ? `${runtime.guestOrigin}/#c=${roomCode}` : `${runtime.guestOrigin}/`;
  console.log('');
  console.log('  DRIFT host ready');
  console.log(`  Guests:   ${runtime.guestOrigin}/`);
  console.log(`  Operator: ${runtime.operatorUrl}`);
  console.log('');
  try {
    console.log(qrToText(encodeQr(qrTarget)));
  } catch {
    console.log(`  (QR unavailable — share this address) ${qrTarget}`);
  }
  console.log('');
  console.log(`  listening on 0.0.0.0:${handle.port}; guests must be on the same network.`);
  if (handle.adapter === null) {
    console.log('  No IPv4 adapter was found, so guests cannot reach this address yet.');
    console.log('  Connect Wi-Fi or Ethernet, then restart with -Adapter <address>.');
  } else {
    console.log(`  advertising ${handle.adapter.name} (${handle.adapter.address}).`);
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
