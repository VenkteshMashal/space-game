/**
 * LAN adapter behaviour (Plan B1/B3/B4) against a fake socket and the real codec, so the wire format
 * is exercised rather than mocked: the test encodes real snapshot frames and asserts what the client
 * observed. Time is driven with fake timers, so the input cadence, heartbeat, reconnect backoff and
 * command deadline are all deterministic rather than slept through.
 */

import { describe, expect, test, vi } from 'bun:test';
import { StringTable, encodeSnapshot } from '../src/shared/codec.ts';
import type { ClientView, Snapshot } from '../src/shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../src/shared/contracts.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import { LanSession, socketUrl, type SocketLike } from '../src/client/session/lan.ts';
import { derivedFitFor, fitFor } from './helpers/fits.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = 'blob';
  readonly text: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners: Record<string, ((event: never) => void)[]> = { open: [], message: [], close: [], error: [] };

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (typeof data === 'string') this.text.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void {
    this.listeners[type]!.push(listener);
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.open!) listener(undefined as never);
  }

  deliver(data: string | Uint8Array | Blob): void {
    for (const listener of this.listeners.message!) listener({ data } as never);
  }

  drop(): void {
    this.readyState = 3;
    for (const listener of this.listeners.close!) listener(undefined as never);
  }

  received<K extends ClientMessage['t']>(type: K): Extract<ClientMessage, { t: K }>[] {
    return this.text
      .filter(raw => (JSON.parse(raw) as { t: string }).t === type)
      .map(raw => JSON.parse(raw) as Extract<ClientMessage, { t: K }>);
  }

  controlTypes(): string[] {
    return this.text.map(raw => (JSON.parse(raw) as { t: string }).t);
  }
}

/** The factory records every socket it creates, so tests never reach inside the session. */
function makeSession(overrides: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const session = new LanSession({
    url: 'ws://127.0.0.1:8080/ws',
    inputHz: 100,
    connectTimeoutMs: 250,
    commandTimeoutMs: 60,
    // Quiet by default: only the reconnect test wants a short stale window, and a reconnect tears
    // down the input loop, which would silently shorten every other timing assertion here.
    heartbeatMs: 1000,
    staleMs: 60_000,
    reconnectGraceMs: 5000,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  const latest = (): FakeSocket => sockets[sockets.length - 1]!;
  return { session, sockets, latest };
}

const WELCOME: ServerMessage = {
  t: 'welcome',
  protocol: RELEASE.protocol,
  contentVersion: RELEASE.contentVersion,
  epoch: 'epoch-1',
  tick: 480,
  pilotId: 'pilot-1',
  sessionId: 'session-1',
  resumeToken: 'token-abc',
  generation: 1,
  phase: 'live',
  seat: 0,
  host: {
    protocol: RELEASE.protocol, contentVersion: RELEASE.contentVersion, appVersion: '1.0.0', phase: 'live',
    guestOrigin: 'http://192.168.1.9:8080', operatorOrigin: 'http://localhost:8080', capacity: 8, occupied: 1,
    uptimeSeconds: 12, joinPolicy: 'open',
  },
};

function snapshotFor(epoch = 'epoch-1'): Snapshot {
  const fit = fitFor('kestrel');
  const derived = derivedFitFor('kestrel');
  const ship = (pilotId: string, teamId: string, x: number, y: number, angle: number) => ({
    id: `ship:${pilotId}`, pilotId, lifeId: `life:${pilotId}:1`, teamId,
    position: { x, y }, velocity: { x: 30, y: 0 }, angle, angularVelocity: 0,
    fit, hull: 135, hullMax: 135, fuelKg: 16000, fuelMaxKg: 16000, heatMJ: 4, heatMaxMJ: 100, capacitorMJ: 8,
    life: 'alive' as const,
  });
  return {
    header: { codec: 1, epoch, baselineId: 'baseline-1', stateSeq: 12, tick: 480, eventWatermark: 3, flags: 0 },
    self: {
      tick: 480,
      ship: ship('pilot-1', 'blue', 100, 40, 0.25),
      derived,
      activeInput: null,
      scheduledInputs: [],
      receivedSeq: 12,
      appliedSeq: 12,
      predictionState: {
        tick: 480, position: { x: 100, y: 40 }, velocity: { x: 30, y: 0 }, angle: 0.25, angularVelocity: 0,
        fuelKg: 16000, heatMJ: 4, capacitorMJ: 8, angularAssist: true,
      },
      weapons: [{ slotId: 'w1', partId: 'gun-autocannon', group: 0, autoDefense: false, magazine: 55, reserve: 300, reloadEndsAtTick: null, chargeFraction: 0, readyAtTick: 0, blockedReason: null }],
    },
    ships: [ship('pilot-1', 'blue', 100, 40, 0.25), ship('pilot-2', 'red', -200, 10, -1)],
    bodies: [{ id: 'rock-1', generation: 1, visualId: 'rock-1', renderSeed: 7, position: { x: 500, y: 0 }, velocity: { x: 0, y: 0 }, angle: 0, angularVelocity: 0, shape: { kind: 'circle', radiusM: 20 }, collidable: true, hull: 90, hullMax: 90 }],
    projectiles: [],
    contacts: [{ id: 'pilot-2', kind: 'hostile', position: { x: -200, y: 10 }, uncertaintyM: 0, ageTicks: 0, targetable: true }],
    objectives: [],
    teamScores: { blue: 0, red: 0 },
    inventoryRevision: 1,
  };
}

/** Flush microtasks queued by timer callbacks without waiting on the wall clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connected(overrides: Record<string, unknown> = {}) {
  const harness = makeSession(overrides);
  const views: ClientView[] = [];
  harness.session.subscribe(view => views.push(view));
  const connecting = harness.session.connect({ transport: 'lan', pilotName: 'Pilot', address: '127.0.0.1:8080' }, new AbortController().signal);
  harness.latest().open();
  harness.latest().deliver(JSON.stringify(WELCOME));
  await connecting;
  return { ...harness, views };
}

describe('handshake', () => {
  test('connect resolves on welcome, reports online and asks for a baseline when live', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    const hello = latest().received('hello')[0];
    expect(hello?.name).toBe('Pilot');
    expect(hello?.protocol).toBe(RELEASE.protocol);
    expect(session.view().link).toBe('online');
    expect(session.view().pilotId).toBe('pilot-1');
    expect(session.view().epoch).toBe('epoch-1');
    expect(latest().controlTypes()).toContain('baseline-request');
    await session.dispose();
    vi.useRealTimers();
  });

  test('a rejected handshake fails the connect instead of falling back to solo', async () => {
    vi.useFakeTimers();
    const { session, latest } = makeSession();
    const connecting = session.connect({ transport: 'lan', pilotName: 'Pilot' }, new AbortController().signal);
    latest().open();
    latest().deliver(JSON.stringify({ t: 'reject', code: 'incompatible', message: 'build mismatch' }));
    await expect(connecting).rejects.toThrow('incompatible');
    expect(session.view().link).toBe('failed');
    await session.dispose();
    vi.useRealTimers();
  });

  test('a silent host hits the bounded handshake deadline', async () => {
    vi.useFakeTimers();
    const { session, latest } = makeSession();
    const connecting = session.connect({ transport: 'lan', pilotName: 'Pilot' }, new AbortController().signal);
    latest().open();
    connecting.catch(() => undefined);
    vi.advanceTimersByTime(300);
    await settle();
    await expect(connecting).rejects.toThrow('handshake timeout');
    expect(session.view().link).toBe('failed');
    await session.dispose();
    vi.useRealTimers();
  });

  test('socket urls follow the address and origin, and reject nothing silently', () => {
    expect(socketUrl('127.0.0.1:8080', null)).toBe('ws://127.0.0.1:8080/ws');
    expect(socketUrl('192.168.1.9:8080', null)).toBe('ws://192.168.1.9:8080/ws');
    expect(socketUrl('http://192.168.1.9:8080', null)).toBe('ws://192.168.1.9:8080/ws');
    expect(socketUrl('https://drift.example', null)).toBe('wss://drift.example/ws');
    expect(socketUrl(undefined, { protocol: 'https:', host: 'drift.example' })).toBe('wss://drift.example/ws');
  });
});

describe('snapshots and prediction', () => {
  test('a decoded snapshot fills the view, and the local ship is predicted ahead of it', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    latest().deliver(encodeSnapshot(snapshotFor(), new StringTable()));
    const view = session.view();
    expect(view.ships).toHaveLength(2);
    expect(view.bodies).toHaveLength(1);
    expect(view.self?.ship.id).toBe('ship:pilot-1');
    expect(view.contacts[0]?.targetable).toBe(true);
    expect(view.tick).toBe(480);

    session.setIntent({ ...EMPTY_FLIGHT_INTENT, thrust: 1, turn: 0.5 });
    const poses = session.poses(1 / 60);
    const local = poses.get('ship:pilot-1')!;
    const remote = poses.get('ship:pilot-2')!;
    expect(local.position.x).toBeGreaterThanOrEqual(100);
    expect(remote.position.x).toBeCloseTo(-200, 1);
    await session.dispose();
    vi.useRealTimers();
  });

  test('a snapshot delivered as a Blob is decoded like an array buffer', async () => {
    // Browsers hand binary WebSocket frames over as Blobs unless asked otherwise; a fake socket that
    // only ever delivers Uint8Array would hide that entirely.
    const { session, latest } = await connected();
    const bytes = encodeSnapshot(snapshotFor(), new StringTable());
    const copy = bytes.slice();
    latest().deliver(new Blob([copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)]));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(session.view().ships).toHaveLength(2);
    expect(latest().binaryType).toBe('arraybuffer');
    await session.dispose();
  });

  test('a snapshot carrying a new epoch replaces the previous match rather than being dropped', async () => {
    // Starting a match changes the epoch; refusing the change left the flight screen with no world.
    // One connection uses one string table, exactly as the server does.
    const { session, latest } = await connected();
    const table = new StringTable();
    latest().deliver(encodeSnapshot(snapshotFor('epoch-1'), table));
    expect(session.view().ships).toHaveLength(2);
    const next = snapshotFor('epoch-2');
    latest().deliver(encodeSnapshot({ ...next, ships: next.ships.slice(0, 1) }, table));
    expect(session.view().epoch).toBe('epoch-2');
    expect(session.view().ships).toHaveLength(1);
    await session.dispose();
  });

  test('a malformed control frame is dropped without disturbing the view', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    latest().deliver('{"t":"not-a-message"}');
    latest().deliver('not json at all');
    latest().deliver(JSON.stringify({ t: 'meta', meta: { ...emptyMeta(), tick: 20 } }));
    expect(session.view().tick).toBe(20);
    expect(session.view().link).toBe('online');
    await session.dispose();
    vi.useRealTimers();
  });
});

describe('commands and intent', () => {
  test('a command resolves with the matching request id and result code', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    const pending = session.command({ kind: 'ready', expectedRevision: 3, ready: true }, 'req-1');
    expect(latest().received('command')[0]?.requestId).toBe('req-1');
    latest().deliver(JSON.stringify({ t: 'command-result', result: { requestId: 'req-1', ok: false, code: 'stale-revision', revision: 4 } }));
    const result = await pending;
    expect(result.code).toBe('stale-revision');
    expect(result.revision).toBe(4);
    await session.dispose();
    vi.useRealTimers();
  });

  test('a command the host never answers fails with a typed code, not a hang', async () => {
    vi.useFakeTimers();
    const { session } = await connected();
    const pending = session.command({ kind: 'start', expectedRevision: 1 }, 'req-2');
    vi.advanceTimersByTime(80);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('denied');
    await session.dispose();
    vi.useRealTimers();
  });

  test('inputs are sampled at their own rate with increasing sequence and full intent', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    latest().deliver(encodeSnapshot(snapshotFor(), new StringTable()));
    session.setIntent({ ...EMPTY_FLIGHT_INTENT, thrust: 1, fireMask: 1 });
    vi.advanceTimersByTime(100);
    const inputs = latest().received('input');
    expect(inputs).toHaveLength(10);
    const sequences = inputs.map(input => input.frame.seq);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(inputs[0]?.frame.intent.thrust).toBe(1);
    expect(inputs[0]?.frame.lifeId).toBe('life:pilot-1:1');
    expect(inputs[0]?.frame.targetTick).toBeGreaterThan(480);
    await session.dispose();
    vi.useRealTimers();
  });

  test('releasing controls clears fire immediately and tells the authority', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    latest().deliver(encodeSnapshot(snapshotFor(), new StringTable()));
    session.setIntent({ ...EMPTY_FLIGHT_INTENT, thrust: 1, fireMask: 3 });
    session.releaseControls('pointer-cancel');
    expect(latest().controlTypes()).toContain('release');
    vi.advanceTimersByTime(50);
    for (const input of latest().received('input')) expect(input.frame.intent.fireMask).toBe(0);
    await session.dispose();
    vi.useRealTimers();
  });

  test('a released control set sends one final frame and then goes quiet', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    latest().deliver(encodeSnapshot(snapshotFor(), new StringTable()));
    session.setIntent({ ...EMPTY_FLIGHT_INTENT, thrust: 1 });
    vi.advanceTimersByTime(50);
    const held = latest().received('input').length;
    expect(held).toBeGreaterThanOrEqual(5);
    session.setIntent({ ...EMPTY_FLIGHT_INTENT });
    vi.advanceTimersByTime(50);
    const afterRelease = latest().received('input').length;
    expect(afterRelease).toBe(held + 1);
    expect(latest().received('input').at(-1)?.frame.intent.thrust).toBe(0);
    vi.advanceTimersByTime(100);
    expect(latest().received('input').length).toBe(afterRelease);
    await session.dispose();
    vi.useRealTimers();
  });
});

describe('lifecycle', () => {
  test('silence puts the link into reconnecting and a resumed welcome restores it', async () => {
    vi.useFakeTimers();
    const { session, sockets } = await connected({ heartbeatMs: 10, staleMs: 20 });
    vi.advanceTimersByTime(40);
    await settle();
    expect(session.view().link).toBe('reconnecting');
    vi.advanceTimersByTime(600);
    await settle();
    expect(sockets.length).toBeGreaterThan(1);
    const resumed = sockets[sockets.length - 1]!;
    resumed.open();
    resumed.deliver(JSON.stringify({ ...WELCOME, epoch: 'epoch-2', generation: 2 }));
    expect(session.view().link).toBe('online');
    expect(session.view().epoch).toBe('epoch-2');
    await session.dispose();
    vi.useRealTimers();
  });

  test('dispose is idempotent, closes the socket and stops all traffic', async () => {
    vi.useFakeTimers();
    const { session, latest } = await connected();
    latest().deliver(encodeSnapshot(snapshotFor(), new StringTable()));
    session.setIntent({ ...EMPTY_FLIGHT_INTENT, thrust: 1 });
    await session.dispose();
    await session.dispose();
    const sent = latest().text.length;
    vi.advanceTimersByTime(200);
    expect(latest().text.length).toBe(sent);
    expect(latest().closed).not.toBeNull();
    expect(await session.command({ kind: 'leave' }, 'req-3')).toMatchObject({ ok: false, code: 'denied' });
    vi.useRealTimers();
  });
});

function emptyMeta() {
  return {
    phase: 'live' as const, link: 'online' as const, pilotId: 'pilot-1', epoch: 'epoch-1', tick: 0, lobby: null,
    campaign: null, host: null, debrief: null, save: 'clean' as const, teamScores: {}, objectives: [],
    respawnAtTick: null, phaseEndsAtTick: null, map: null, economy: null,
  };
}
