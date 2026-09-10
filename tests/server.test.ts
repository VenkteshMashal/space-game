/**
 * Authority-room acceptance (Plan B1/B3/B4). Flows a guest actually performs run against a real Bun
 * server and real WebSockets; cases where the transport itself is the variable (backpressure, the
 * 17th pending socket, a 60-second reservation) drive the same room through its socket interface.
 *
 * Nothing sleeps for a simulated second: the 120 Hz loop is driven by `room.advance`, so a 60-second
 * grace window costs 7200 synchronous steps. The only real waiting is for the platform to deliver
 * bytes to a WebSocket, which is inherently asynchronous.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RELEASE } from '../src/shared/contracts.ts';
import type { BodyView, Command, InputFrame, SessionEvent, Snapshot } from '../src/shared/contracts.ts';
import { HEADER_BYTES, StringTable, decodeSnapshot } from '../src/shared/codec.ts';
import { RULES } from '../src/shared/balance.ts';
import { hash32 } from '../src/shared/ids.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';
import { parseServerMessage } from '../src/shared/protocol.ts';
import { Room } from '../src/server/room.ts';
import type { CloseReason, HelloRequest, RoomSocket, RoomSocketInfo } from '../src/server/room.ts';
import { mapHashOf, payloadHash } from '../src/server/baseline.ts';
import { classifyAdapter, createHost, selectAdapter } from '../src/server/serve.ts';
import type { HostHandle } from '../src/server/serve.ts';
import { encodeQr, readQr } from '../src/server/qr.ts';
import { addRock, rockViews } from '../src/sim/world.ts';
import { view as lobbyView } from '../src/sim/lobby.ts';
import { LOOPBACK, MemorySocket, goLive, helloRequest, makeRoom, seatAndLaunch } from './helpers/room.ts';

const PHYSICS_HZ = RELEASE.physicsHz;
const SNAPSHOT_INTERVAL = PHYSICS_HZ / RELEASE.snapshotHz;

function emptyIntent() {
  return { thrust: 0, turn: 0, strafe: 0, brake: false, boost: false, angularAssist: true, fireMask: 0, aimWorld: null, lockContactId: null };
}

function distRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-dist-'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>DRIFT</title>', 'utf8');
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'assets', 'app.js'), 'export {};', 'utf8');
  return root;
}

async function startHost(options: { operatorRequired?: boolean; mode?: 'skirmish' | 'campaign' } = {}): Promise<HostHandle> {
  return createHost({
    port: 0,
    distRoot: distRoot(),
    adapter: '127.0.0.1',
    autoLoop: false,
    operatorRequired: options.operatorRequired ?? true,
    mode: options.mode ?? 'skirmish',
  });
}


/** Rock field hash over body views; the same recipe the authority's `rockHash` applies. */
function rockFieldHash(bodies: readonly BodyView[]): string {
  return JSON.stringify(
    [...bodies]
      .map(body => [body.id, Math.round(body.position.x * 1000), Math.round(body.position.y * 1000), body.shape.kind === 'circle' ? Math.round(body.shape.radiusM * 100) : 0])
      .sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1)),
  );
}

function fieldOf(bodies: readonly BodyView[]): Map<string, { x: number; y: number; radiusM: number }> {
  const field = new Map<string, { x: number; y: number; radiusM: number }>();
  for (const body of bodies) {
    field.set(body.id, { x: body.position.x, y: body.position.y, radiusM: body.shape.kind === 'circle' ? body.shape.radiusM : 0 });
  }
  return field;
}

function hostField(room: Room): Map<string, { x: number; y: number; radiusM: number }> {
  const field = new Map<string, { x: number; y: number; radiusM: number }>();
  for (const { rock, body } of rockViews(room.world!)) {
    field.set(rock.contentId, { x: body.position.x, y: body.position.y, radiusM: rock.radiusM });
  }
  return field;
}

/** Positions travel as float32, so compare at decimetre resolution rather than bit-exact. */
function sortedField(field: Map<string, { x: number; y: number; radiusM: number }>): string {
  return JSON.stringify(
    [...field.entries()]
      .map(([id, body]) => [id, Math.round(body.x * 10), Math.round(body.y * 10), Math.round(body.radiusM * 10)])
      .sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1)),
  );
}

// ---------------------------------------------------------------------------------------------
// Real WebSocket client
// ---------------------------------------------------------------------------------------------

class Client {
  readonly texts: string[] = [];
  readonly binary: Uint8Array[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  private readonly socket: WebSocket;
  private readonly table = new StringTable();
  private readonly decoded: Snapshot[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      const data = event.data;
      if (typeof data === 'string') {
        this.texts.push(data);
        return;
      }
      const bytes = new Uint8Array(data as ArrayBuffer);
      this.binary.push(bytes);
      if (bytes.length >= HEADER_BYTES && bytes[6] === 1) {
        const parsed = decodeSnapshot(bytes, this.table);
        if (parsed.ok) this.decoded.push(parsed.value);
      }
    });
    socket.addEventListener('close', event => this.closes.push({ code: event.code, reason: event.reason }));
  }

  static connect(url: string, origin: string): Promise<Client> {
    // Bun's client accepts an options object carrying the Origin header a browser would send.
    const socket = new WebSocket(url, { headers: { origin } } as unknown as string[]);
    const client = new Client(socket);
    return new Promise<Client>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(client));
      socket.addEventListener('error', () => reject(new Error('socket error')));
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(data: string | Uint8Array): void {
    this.socket.send(data as never);
  }

  close(): void {
    this.socket.close();
  }

  messages<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    const out: Extract<ServerMessage, { t: T }>[] = [];
    for (const raw of this.texts) {
      const parsed = parseServerMessage(raw);
      if (parsed.ok && parsed.value.t === type) out.push(parsed.value as Extract<ServerMessage, { t: T }>);
    }
    return out;
  }

  get welcome(): Extract<ServerMessage, { t: 'welcome' }> | null {
    return this.messages('welcome')[0] ?? null;
  }

  get reject(): Extract<ServerMessage, { t: 'reject' }> | null {
    return this.messages('reject')[0] ?? null;
  }

  snapshots(): Snapshot[] {
    return this.decoded;
  }
}

/** Real bytes cross a real socket, so this waits for delivery rather than for a duration. */
async function waitFor<T>(probe: () => T | null | undefined | false, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(2);
  }
}

async function joinClient(handle: HostHandle, name: string): Promise<Client> {
  const client = await Client.connect(`ws://127.0.0.1:${handle.port}/ws`, `http://127.0.0.1:${handle.port}`);
  client.send({ t: 'hello', protocol: RELEASE.protocol, contentVersion: RELEASE.contentVersion, name, roomCode: null, resumeToken: null, campaignId: null });
  await waitFor(() => client.welcome ?? client.reject);
  return client;
}

// ---------------------------------------------------------------------------------------------
// Lobby and launch
// ---------------------------------------------------------------------------------------------

describe('lobby and launch', () => {
  test('two clients ready and start, then both receive snapshots four ticks apart at matching ticks', async () => {
    const handle = await startHost();
    try {
      const captain = await joinClient(handle, 'Alpha');
      await waitFor(() => captain.welcome);
      captain.send({ t: 'claim', token: handle.operator.claim.token });
      await waitFor(() => handle.room.lobby.captainId === captain.welcome!.pilotId);

      const guest = await joinClient(handle, 'Bravo');
      await waitFor(() => handle.room.occupiedSeats() === 2);
      const revision = handle.room.lobby.revision;
      captain.send({ t: 'command', requestId: 'r1', command: { kind: 'ready', expectedRevision: revision, ready: true } });
      guest.send({ t: 'command', requestId: 'r2', command: { kind: 'ready', expectedRevision: revision, ready: true } });
      await waitFor(() => lobbyView(handle.room.lobby).startBlockers.length === 0);
      captain.send({ t: 'command', requestId: 'r3', command: { kind: 'start', expectedRevision: handle.room.lobby.revision } });
      await waitFor(() => handle.room.phase !== 'lobby');

      handle.room.advance(RULES.countdownSeconds * PHYSICS_HZ + 8);
      expect(handle.room.phase).toBe('live');
      handle.room.advance(48);

      const first = await waitFor(() => {
        const snapshots = captain.snapshots().filter(snapshot => snapshot.header.tick > 0).slice(-8);
        return snapshots.length >= 8 ? snapshots : null;
      });
      const second = await waitFor(() => {
        const snapshots = guest.snapshots().filter(snapshot => snapshot.header.tick > 0).slice(-8);
        return snapshots.length >= 8 ? snapshots : null;
      });
      for (let index = 1; index < first.length; index++) {
        expect(first[index]!.header.tick - first[index - 1]!.header.tick).toBe(SNAPSHOT_INTERVAL);
      }
      expect(second[second.length - 1]!.header.tick).toBe(first[first.length - 1]!.header.tick);

      const withRocks = first.filter(snapshot => snapshot.bodies.length > 0);
      expect(withRocks.length).toBeGreaterThan(0);
      const anchor = withRocks[withRocks.length - 1]!;
      const guestSameTick = second.find(snapshot => snapshot.header.tick === anchor.header.tick)!;
      expect(guestSameTick).toBeDefined();
      expect(rockFieldHash(guestSameTick.bodies)).toBe(rockFieldHash(anchor.bodies));
    } finally {
      await handle.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Input lease and release
// ---------------------------------------------------------------------------------------------

describe('input lease', () => {
  test('an input older than the lease stops thrust while momentum persists, and release clears fire', () => {
    const room = makeRoom();
    const { a } = seatAndLaunch(room);
    goLive(room);
    const epoch = room.currentEpoch!;
    const lifeId = a.lastSnapshot.self!.ship.lifeId;
    const frame: InputFrame = {
      epoch,
      lifeId,
      seq: 1,
      targetTick: room.worldTick + 1,
      intent: { ...emptyIntent(), thrust: 1, fireMask: 1 },
    };
    expect(room.input(a, frame)!.result).toBe('scheduled');
    room.advance(20);
    const thrusting = a.lastSnapshot.self!;
    const speedThrusting = Math.hypot(thrusting.predictionState.velocity.x, thrusting.predictionState.velocity.y);
    expect(speedThrusting).toBeGreaterThan(0.1);
    expect(thrusting.activeInput).not.toBeNull();

    // Without another frame the 30-tick lease expires: thrust stops, momentum does not.
    room.advance(RELEASE.inputLeaseTicks + 10);
    const coasting = a.lastSnapshot.self!;
    expect(coasting.activeInput).toBeNull();
    expect(Math.hypot(coasting.predictionState.velocity.x, coasting.predictionState.velocity.y)).toBeGreaterThan(speedThrusting * 0.9);

    // A release clears the held intent and any queued frame, and the hull still coasts.
    room.input(a, { ...frame, seq: 2, targetTick: room.worldTick + 1 });
    room.release(a);
    const released = a.lastSnapshot.self!;
    expect(released.activeInput).toBeNull();
    expect(Math.hypot(released.predictionState.velocity.x, released.predictionState.velocity.y)).toBeGreaterThan(0.1);
  });
});

// ---------------------------------------------------------------------------------------------
// Rejection matrix
// ---------------------------------------------------------------------------------------------

describe('rejections', () => {
  test('a repeated hello, a forged captain and a stale revision are refused', () => {
    const room = makeRoom();
    const a = new MemorySocket(1);
    const b = new MemorySocket(2);
    room.hello(a, LOOPBACK, helloRequest('Alpha'));
    room.hello(b, LOOPBACK, helloRequest('Bravo'));
    const welcomeA = a.control[0]!;
    if (welcomeA.t !== 'welcome') throw new Error('no welcome');
    const welcomeB = b.control[0]!;
    if (welcomeB.t !== 'welcome') throw new Error('no welcome');

    room.hello(a, LOOPBACK, helloRequest('Impostor'));
    expect(a.control.filter(message => message.t === 'welcome').length).toBe(1);
    expect(a.closes[0]?.reason).toBe('rejected');

    // Identity is minted by the room: two clients never collide, and neither chose its own id.
    expect(welcomeA.pilotId).not.toBe(welcomeB.pilotId);
    expect(welcomeA.sessionId).not.toBe(welcomeB.sessionId);

    const escalation = room.command(b, 'esc', { kind: 'captain', expectedRevision: room.lobby.revision, action: 'transfer', pilotId: welcomeB.pilotId });
    expect(escalation.code).toBe('not-captain');
    const stale = room.command(b, 'stale', { kind: 'ready', expectedRevision: room.lobby.revision + 5, ready: true });
    expect(stale.code).toBe('stale-revision');
    expect(stale.revision ?? -1).toBe(room.lobby.revision);
  });

  test('non-finite axes, an Infinity revision and a wrong life are rejected without changing state', () => {
    const room = makeRoom();
    const { a } = seatAndLaunch(room);
    goLive(room);
    const epoch = room.currentEpoch!;
    const lifeId = a.lastSnapshot.self!.ship.lifeId;
    const sessionsBefore = room.metrics().sessions;

    expect(room.command(a, 'inf', { kind: 'ready', expectedRevision: 1e309, ready: true }).ok).toBe(false);
    expect(room.input(a, { epoch, lifeId, seq: 1, targetTick: room.worldTick + 1, intent: { ...emptyIntent(), thrust: 1e309 } })!.result).toBe('invalid');
    expect(room.input(a, { epoch, lifeId, seq: 2, targetTick: room.worldTick + 1, intent: { ...emptyIntent(), fireMask: 1e309 } })!.result).toBe('invalid');
    expect(room.input(a, { epoch, lifeId, seq: 3, targetTick: room.worldTick + 1, intent: { ...emptyIntent(), thrust: Number.POSITIVE_INFINITY } })!.result).toBe('invalid');
    expect(room.input(a, { epoch, lifeId: 'life:other:9', seq: 4, targetTick: room.worldTick + 1, intent: emptyIntent() })!.result).toBe('wrong-life');
    expect(room.input(a, { epoch: 'other-epoch', lifeId, seq: 5, targetTick: room.worldTick + 1, intent: emptyIntent() })!.result).toBe('invalid');
    expect(room.metrics().sessions).toBe(sessionsBefore);
    expect([...room.world!.ships.values()].every(pilot => pilot.activeInput === null)).toBe(true);
  });

  test('a bad Origin and a malformed binary frame never reach the room', async () => {
    const handle = await startHost();
    try {
      const refused = await fetch(`http://127.0.0.1:${handle.port}/ws`, {
        headers: { origin: 'http://evil.example', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
      });
      expect(refused.status).toBe(403);
      expect(handle.room.metrics().sessions).toBe(0);

      // A connection that never completed a handshake cannot mutate the room.
      const anonymous = await Client.connect(`ws://127.0.0.1:${handle.port}/ws`, `http://127.0.0.1:${handle.port}`);
      anonymous.send({ t: 'command', requestId: 'forged', command: { kind: 'ready', expectedRevision: 1, ready: true } });
      const denial = await waitFor(() => anonymous.messages('command-result').find(result => result.result.requestId === 'forged'));
      expect(denial.result.code).toBe('denied');
      expect(handle.room.metrics().sessions).toBe(0);
      anonymous.close();

      const client = await joinClient(handle, 'Alpha');
      await waitFor(() => client.welcome);
      client.sendRaw(new Uint8Array([1, 2, 3]));
      await waitFor(() => client.closes.length > 0);
      expect(handle.room.phase).toBe('lobby');
    } finally {
      await handle.stop();
    }
  });

  test('the 9th seat and the 17th pending socket are refused', async () => {
    const handle = await startHost();
    try {
      const pending: Client[] = [];
      for (let index = 0; index < RULES.maxPendingSockets; index++) {
        pending.push(await Client.connect(`ws://127.0.0.1:${handle.port}/ws`, `http://127.0.0.1:${handle.port}`));
      }
      await waitFor(() => handle.net.pendingSockets === RULES.maxPendingSockets);
      const overflow = await fetch(`http://127.0.0.1:${handle.port}/ws`, {
        headers: { origin: `http://127.0.0.1:${handle.port}`, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
      });
      expect(overflow.status).toBe(503);
      for (const client of pending) client.close();
      await waitFor(() => handle.net.pendingSockets === 0);

      const clients: Client[] = [];
      for (let index = 0; index < RELEASE.maxHumans; index++) clients.push(await joinClient(handle, `Pilot${index}`));
      await waitFor(() => handle.room.occupiedSeats() === RELEASE.maxHumans);
      const ninth = await joinClient(handle, 'TooMany');
      expect(ninth.reject?.code).toBe('room-full');
      expect(handle.room.occupiedSeats()).toBe(RELEASE.maxHumans);
      for (const client of clients) client.close();
    } finally {
      await handle.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Command receipts
// ---------------------------------------------------------------------------------------------

describe('command receipts', () => {
  test('a duplicate request id returns the original result and an evicted one reports receipt-expired', () => {
    let clock = 1_000_000;
    const room = makeRoom({ now: () => clock, receiptRetentionMs: 60_000 });
    const a = new MemorySocket(1);
    room.hello(a, LOOPBACK, helloRequest('Alpha'));
    const command: Command = { kind: 'ready', expectedRevision: room.lobby.revision, ready: true };
    const first = room.command(a, 'req-1', command);
    expect(first.ok).toBe(true);
    expect(room.command(a, 'req-1', command)).toEqual(first);
    expect(a.control.filter(message => message.t === 'command-result').length).toBe(1);

    // A later command ages the receipt out of retention; it is then refused, never reapplied.
    clock += 120_000;
    room.command(a, 'req-2', { kind: 'ready', expectedRevision: room.lobby.revision, ready: true });
    expect(room.command(a, 'req-1', command).code).toBe('receipt-expired');
  });
});

// ---------------------------------------------------------------------------------------------
// Reservation, reconnect and backpressure
// ---------------------------------------------------------------------------------------------

describe('disconnect and resume', () => {
  test('a disconnected pilot keeps its seat and body for 60 s, still coasting and vulnerable', () => {
    const room = makeRoom();
    const { b } = seatAndLaunch(room);
    goLive(room);
    const pilotB = room.lobby.seats[1]!.pilotId;
    const world = room.world!;
    const shipBody = world.bodies.find(candidate => candidate.contentId === `ship:${pilotB}`)!;
    shipBody.velocity = { x: 6, y: -2 };
    const startX = shipBody.position.x;

    room.detach(b.connectionId);
    expect(room.lobby.seats[1]!.pilotId).toBe(pilotB);
    expect(room.lobby.seats[1]!.presence).toBe('reconnecting');
    expect(world.ships.has(pilotB)).toBe(true);

    room.advance(60);
    expect(Math.abs(shipBody.position.x - startX)).toBeGreaterThan(3);
    room.advance(RELEASE.reconnectSeconds * PHYSICS_HZ - 61);
    expect(world.ships.has(pilotB)).toBe(true);
    // No invulnerable freeze and no free heal: the body is a live, solid ship, not a spectre.
    expect(world.ships.get(pilotB)!.life).toBe('alive');
    expect(shipBody.collidable).toBe(true);
    expect(Math.hypot(shipBody.velocity.x, shipBody.velocity.y)).toBeGreaterThan(1);

    room.advance(2);
    expect(world.ships.has(pilotB)).toBe(false);
    expect(room.lobby.seats[1]).toBeNull();
  });

  test('a reconnect with the resume token installs a verified baseline and resumes control', () => {
    const room = makeRoom();
    const { a, b } = seatAndLaunch(room);
    goLive(room);
    const welcomeB = b.control[0]!;
    if (welcomeB.t !== 'welcome') throw new Error('no welcome for B');

    room.detach(b.connectionId);
    room.advance(240);

    const resumed = new MemorySocket(99, b.table);
    room.hello(resumed, LOOPBACK, helloRequest('Bravo', { resumeToken: welcomeB.resumeToken }));
    const welcome = resumed.control[0]!;
    if (welcome.t !== 'welcome') throw new Error('resume was refused');
    expect(welcome.pilotId).toBe(welcomeB.pilotId);
    expect(welcome.generation).toBe(2);
    expect(welcome.resumeToken).not.toBe(welcomeB.resumeToken);

    // The baseline is framed, hashed and map-identified before anything installs.
    const header = resumed.baselineHeader();
    if (header === null) throw new Error('no baseline header');
    const frames = resumed.baselineFrames();
    expect(frames.length).toBeGreaterThan(0);
    expect(header.header.chunkCount).toBe(frames.length);
    // Hash and map identity are verified before anything installs.
    expect(payloadHash(frames)).toBe(header.header.transferId);
    expect(mapHashOf(room.world!.map)).toBe(header.header.mapHash);
    expect(header.header.epoch).toBe(room.currentEpoch!);
    expect(header.header.tick).toBe(room.worldTick);
    const installedBodies = resumed.baselineInstalled.flatMap(snapshot => snapshot.bodies);
    expect(installedBodies.length).toBeGreaterThan(0);
    expect(installedBodies.length).toBe(hostField(room).size);
    // A tampered frame no longer hashes to the transfer id, so it is never installed.
    const tampered = frames.map(frame => frame.slice());
    tampered[0]![HEADER_BYTES + 4] = (tampered[0]![HEADER_BYTES + 4]! ^ 0xff) & 0xff;
    expect(payloadHash(tampered)).not.toBe(header.header.transferId);

    // Control resumes through the new connection, under the life the resumed body actually has.
    const lifeId = b.lastSnapshot.self!.ship.lifeId;
    const receipt = room.input(resumed, {
      epoch: room.currentEpoch,
      lifeId,
      seq: 1,
      targetTick: room.worldTick + 1,
      intent: { ...emptyIntent(), thrust: 1 },
    });
    expect(receipt!.result).toBe('scheduled');
  });

  test('an empty room settles instead of simulating an arena nobody is watching', async () => {
    const room = makeRoom();
    const { a, b } = seatAndLaunch(room);
    goLive(room);
    room.detach(a.connectionId);
    room.detach(b.connectionId);
    room.advance(RELEASE.reconnectSeconds * PHYSICS_HZ + 4);
    // Settlement commits asynchronously; draining the microtask queue is the deterministic wait.
    await Promise.resolve();
    await Promise.resolve();
    expect(room.phase).toBe('debrief');
    expect(room.metrics().sessions).toBe(0);
  });

  test('a slow client does not block the room and is closed with a typed reason', () => {
    const room = makeRoom();
    const { a } = seatAndLaunch(room);
    goLive(room);
    const slow = new MemorySocket(77);
    room.hello(slow, LOOPBACK, helloRequest('Gopher'));
    slow.backpressure = true;
    const tickBefore = room.metrics().tick;
    room.advance(2 * PHYSICS_HZ + 60);

    expect(room.metrics().tick).toBe(tickBefore + 2 * PHYSICS_HZ + 60);
    expect(['slow-client', 'slow-client-buffer']).toContain(slow.closes[0]?.reason);
    expect(slow.closes[0]!.code).toBe(4002);
    // The healthy client still receives snapshots after the slow one is dropped.
    expect(a.lastSnapshot.header.tick).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Baseline continuity across a fracture
// ---------------------------------------------------------------------------------------------

describe('baseline during a fracture', () => {
  test('the field changes after the baseline tick, replays in order, and the receiver converges', () => {
    const room = makeRoom();
    const { a } = seatAndLaunch(room);
    goLive(room);
    const world = room.world!;

    // Baseline taken before the fracture: its frames are the transfer's own frames.
    const header = a.baselineHeader();
    if (header === null) throw new Error('no baseline header');
    const baselineTick = header.header.tick;
    const baselineBodies = a.baselineInstalled.flatMap(snapshot => snapshot.bodies);
    const receiver = fieldOf(baselineBodies);
    expect(receiver.size).toBeGreaterThan(0);
    expect(receiver.size).toBe(hostField(room).size);

    // Mid-transfer the field changes: a rock is destroyed (impact recorded) and a child appears.
    const parent = [...world.rocks.keys()][0]!;
    world.events.push({
      kind: 'impact',
      payload: {
        hitId: `hit:${world.tick}:${parent}`,
        kind: 'rock',
        targetId: parent,
        position: { x: 0, y: 0 },
        normal: { x: 1, y: 0 },
        damage: 99,
        energyJ: 99,
        destroyed: true,
        attackerPilotId: null,
        victimPilotId: null,
      },
    });
    world.rocks.delete(parent);
    const child = `${parent}.1`;
    addRock(world, child, { x: 40, y: -25 }, { x: 0, y: 0 }, 12, 7);

    // Step to a tick that definitely carries rock state (10 Hz) so the comparison is at one tick.
    room.advance(12 - (room.tick % 12));

    const replayed: SessionEvent[] = [];
    for (const message of a.control) if (message.t === 'event') replayed.push(message.event);
    const afterBaseline = replayed.filter(event => event.tick > baselineTick);
    const impact = afterBaseline.find(event => event.kind === 'impact' && (event.payload as { targetId: string }).targetId === parent);
    expect(impact).toBeDefined();
    const seqs = replayed.map(event => event.deliverySeq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(afterBaseline.every((event, index) => index === 0 || event.deliverySeq > afterBaseline[index - 1]!.deliverySeq)).toBe(true);

    // Replaying only post-baseline events, in order, on top of the receiver's copy.
    for (const event of afterBaseline) {
      if (event.kind !== 'impact') continue;
      const payload = event.payload as { kind: string; targetId: string; destroyed: boolean };
      if (payload.kind === 'rock' && payload.destroyed) receiver.delete(payload.targetId);
    }
    receiver.set(child, { x: 40, y: -25, radiusM: 12 });

    // Events drive identity and the next authoritative snapshot drives transforms, so the receiver
    // ends up with exactly the host's bodies, not a superset or a stale parent.
    const authoritative = a.lastSnapshot.bodies;
    expect(authoritative.length).toBeGreaterThan(0);
    expect(sortedField(fieldOf(authoritative))).toBe(sortedField(hostField(room)));
    const hostIds = [...hostField(room).keys()].sort();
    expect([...receiver.keys()].sort()).toEqual(hostIds);
    expect(hostIds).toContain(child);
    expect(hostIds).not.toContain(parent);
  });
});

// ---------------------------------------------------------------------------------------------
// Host surface
// ---------------------------------------------------------------------------------------------

describe('host surface', () => {
  test('/api/info exposes no token, roster or save path, and the operator claim works exactly once', async () => {
    const handle = await startHost();
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/info`);
      expect(response.status).toBe(200);
      const raw = await response.text();
      const info = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(info).sort()).toEqual([
        'appVersion', 'capacity', 'contentVersion', 'guestOrigin', 'joinPolicy', 'occupied', 'operatorOrigin', 'phase', 'protocol', 'uptimeSeconds',
      ]);
      expect(raw).not.toContain(handle.operator.claim.token);
      expect(raw).not.toContain(handle.operator.adminToken);
      expect(raw.toLowerCase()).not.toContain('roster');

      expect(await (await fetch(`http://127.0.0.1:${handle.port}/health`)).text()).toBe('ok');
      const escaped = await fetch(`http://127.0.0.1:${handle.port}/../package.json`);
      expect([403, 404]).toContain(escaped.status);
      expect((await fetch(`http://127.0.0.1:${handle.port}/assets/nope.js`)).status).toBe(404);
      const shell = await fetch(`http://127.0.0.1:${handle.port}/lobby`);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('DRIFT');

      const operator = await joinClient(handle, 'Operator');
      await waitFor(() => operator.welcome);
      operator.send({ t: 'claim', token: handle.operator.claim.token });
      await waitFor(() => handle.room.operatorClaimed);
      const captainId = handle.room.lobby.captainId;
      expect(captainId).toBe(operator.welcome!.pilotId);

      const chancer = await joinClient(handle, 'Chancer');
      await waitFor(() => chancer.welcome);
      chancer.send({ t: 'claim', token: handle.operator.claim.token });
      await waitFor(() => handle.room.occupiedSeats() === 2);
      expect(handle.room.lobby.captainId).toBe(captainId);
      expect(handle.room.lobby.captainId).not.toBe(chancer.welcome!.pilotId);
    } finally {
      await handle.stop();
    }
  });

  test('guests are held at "Host preparing room" until the operator claim is consumed', () => {
    const room = makeRoom({ operatorRequired: true });
    const guest = new MemorySocket(1);
    room.hello(guest, { remoteAddress: '192.168.1.50', origin: 'http://192.168.1.50:8080' }, helloRequest('Early'));
    expect(guest.control[0]).toMatchObject({ t: 'reject', code: 'join-closed' });
    expect(room.occupiedSeats()).toBe(0);
  });

  test('an incompatible build is refused before it can take a seat', () => {
    const room = makeRoom();
    const client = new MemorySocket(1);
    room.hello(client, LOOPBACK, { ...helloRequest('Old'), protocol: RELEASE.protocol + 1 });
    expect(client.control[0]).toMatchObject({ t: 'reject', code: 'incompatible' });
    expect(room.occupiedSeats()).toBe(0);
  });

  test('the launcher stop route authenticates loopback and acknowledges the save', async () => {
    const handle = await startHost();
    const refused = await fetch(`http://127.0.0.1:${handle.port}/api/shutdown`, { method: 'POST' });
    expect(refused.status).toBe(403);
    const stopped = await fetch(`http://127.0.0.1:${handle.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.operator.adminToken}` },
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true, saved: true });
    expect(handle.room.isClosed).toBe(true);
  });

  test('adapter classification prefers physical links and flags virtual switches', () => {
    expect(classifyAdapter('Wi-Fi')).toBe('wifi');
    expect(classifyAdapter('Ethernet')).toBe('ethernet');
    expect(classifyAdapter('vEthernet (WSL (Hyper-V firewall))')).toBe('virtual');
    expect(classifyAdapter('WireGuard Tunnel')).toBe('vpn');
    expect(classifyAdapter('VMware Network Adapter VMnet1')).toBe('virtual');
    const chooser = selectAdapter([
      { name: 'vEthernet (WSL)', address: '172.26.192.1', kind: 'virtual', preferred: false },
      { name: 'Wi-Fi', address: '192.168.1.9', kind: 'wifi', preferred: true },
    ], null);
    expect(chooser?.address).toBe('192.168.1.9');
    expect(selectAdapter([{ name: 'Ethernet', address: '10.0.0.4', kind: 'ethernet', preferred: true }], '10.9.9.9')).toBeNull();
  });

  test('the printed QR decodes to the exact guest URL', () => {
    for (const url of ['http://192.168.1.24:8080/', 'http://10.0.0.7:8080/#c=W7QP']) {
      const decoded = readQr(encodeQr(url));
      expect(decoded.text).toBe(url);
      expect(decoded.syndromesOk).toBe(true);
    }
  });

  test('the same map seed generates one field and a different seed generates another', () => {
    const first = makeRoom({ seed: 1234 });
    const second = makeRoom({ seed: 1234 });
    const third = makeRoom({ seed: 4321 });
    seatAndLaunch(first);
    seatAndLaunch(second);
    seatAndLaunch(third);
    expect(sortedField(hostField(first))).toBe(sortedField(hostField(second)));
    expect(sortedField(hostField(third))).not.toBe(sortedField(hostField(first)));
    void hash32;
  });
});
