/**
 * Room-level test doubles shared by the authority suites (Plan B1/B3). `tests/server.test.ts` and
 * `tests/campaign-live.test.ts` both drive the real `Room` through these: one loopback socket double
 * and the seat-and-launch sequence a pilot performs, so neither suite invents its own harness.
 */

import { expect } from 'bun:test';
import { RULES } from '../../src/shared/balance.ts';
import { RELEASE } from '../../src/shared/contracts.ts';
import type { BodyView, Snapshot } from '../../src/shared/contracts.ts';
import type { ServerMessage } from '../../src/shared/protocol.ts';
import { HEADER_BYTES, StringTable, decodeSnapshot } from '../../src/shared/codec.ts';
import { Room } from '../../src/server/room.ts';
import type { CloseReason, HelloRequest, RoomSocket, RoomSocketInfo } from '../../src/server/room.ts';

export const PHYSICS_HZ = RELEASE.physicsHz;

/** Loopback socket double. `backpressure` makes every send report -1, exactly like Bun's contract. */
export class MemorySocket implements RoomSocket {
  readonly control: ServerMessage[] = [];
  readonly binaries: Uint8Array[] = [];
  readonly log: ({ kind: 'control'; value: ServerMessage } | { kind: 'binary'; value: Uint8Array })[] = [];
  readonly closes: { code: number; reason: CloseReason }[] = [];
  readonly snapshots: Snapshot[] = [];
  readonly baselineInstalled: Snapshot[] = [];
  private baselineOpen = false;
  backpressure = false;
  open = true;

  constructor(readonly connectionId: number, readonly table: StringTable = new StringTable()) {}

  sendControl(message: ServerMessage): void {
    if (!this.open) return;
    if (message.t === 'baseline-header') {
      this.baselineOpen = true;
      this.baselineInstalled.length = 0;
    }
    if (message.t === 'baseline-end') this.baselineOpen = false;
    this.control.push(message);
    this.log.push({ kind: 'control', value: message });
  }

  sendBinary(bytes: Uint8Array): number {
    if (!this.open) return 0;
    this.binaries.push(bytes);
    this.log.push({ kind: 'binary', value: bytes });
    // Frames arrive in encoder order, so the receiver's table tracks the sender's.
    if (bytes.length >= HEADER_BYTES && bytes[6] === 1) {
      const decoded = decodeSnapshot(bytes, this.table);
      if (decoded.ok) {
        this.snapshots.push(decoded.value);
        if (this.baselineOpen) this.baselineInstalled.push(decoded.value);
      }
    }
    return this.backpressure ? -1 : bytes.length;
  }

  close(code: number, reason: CloseReason): void {
    this.closes.push({ code, reason });
    this.open = false;
  }

  get lastSnapshot(): Snapshot {
    const snapshot = this.snapshots[this.snapshots.length - 1];
    if (!snapshot) throw new Error('no snapshot was sent');
    return snapshot;
  }

  /** The frames of the most recent transfer, taken from the ordered log. */
  baselineFrames(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let open = false;
    for (const entry of this.log) {
      if (entry.kind === 'control' && entry.value.t === 'baseline-header') {
        frames.length = 0;
        open = true;
        continue;
      }
      if (entry.kind === 'control' && entry.value.t === 'baseline-end') {
        open = false;
        continue;
      }
      if (open && entry.kind === 'binary') frames.push(entry.value);
    }
    return frames;
  }

  baselineHeader(): Extract<ServerMessage, { t: 'baseline-header' }> | null {
    for (let index = this.control.length - 1; index >= 0; index--) {
      const message = this.control[index]!;
      if (message.t === 'baseline-header') return message;
    }
    return null;
  }
}

export const LOOPBACK: RoomSocketInfo = { remoteAddress: '127.0.0.1', origin: 'http://127.0.0.1:8080' };

export function helloRequest(name: string, extra: Partial<HelloRequest> = {}): HelloRequest {
  return {
    name,
    roomCode: null,
    resumeToken: null,
    campaignId: null,
    protocol: RELEASE.protocol,
    contentVersion: RELEASE.contentVersion,
    ...extra,
  };
}

export function makeRoom(options: ConstructorParameters<typeof Room>[0] = {}): Room {
  const room = new Room({ roomId: 'test', mapId: 'belt', operatorRequired: false, now: () => Date.now(), ...options });
  // Every room-level test starts from a consumed operator claim, which is what makes the first
  // connection the captain the same way the launcher's loopback URL does.
  room.installOperatorClaim({ token: 'test-claim', expiresAt: new Date(4_102_444_800_000).toISOString() });
  return room;
}

export function seatAndLaunch(room: Room): { a: MemorySocket; b: MemorySocket } {
  const a = new MemorySocket(1);
  const b = new MemorySocket(2);
  room.hello(a, LOOPBACK, helloRequest('Alpha'));
  room.hello(b, LOOPBACK, helloRequest('Bravo'));
  expect(room.claimOperator(a, 'test-claim')).toBe(true);
  room.command(a, 'ready-a', { kind: 'ready', expectedRevision: room.lobby.revision, ready: true });
  room.command(b, 'ready-b', { kind: 'ready', expectedRevision: room.lobby.revision, ready: true });
  expect(room.command(a, 'start-a', { kind: 'start', expectedRevision: room.lobby.revision }).code).toBe('ok');
  room.advance(2);
  return { a, b };
}

export function goLive(room: Room): void {
  room.advance(RULES.countdownSeconds * PHYSICS_HZ + 8);
  expect(room.phase).toBe('live');
}
