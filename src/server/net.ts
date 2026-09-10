/**
 * WebSocket session layer (Plan B3). `net.ts` owns everything the room cannot see: the bind-side
 * Origin allowlist, the hello deadline, the bounded pending-socket set, per-address and
 * per-connection rate limits, and the client frame size cap. It never decides identity, a seat or a
 * command outcome — it parses a bounded envelope and hands the room the typed fields.
 *
 * Nothing here interpolates client text into markup, and nothing here logs: tokens, room codes and
 * remote addresses are not secrets we need in a log line, and the room already answers rejections
 * with a typed code.
 */

import { RULES } from '../shared/balance.ts';
import { isPlainObject } from '../shared/validate.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { parseClientMessage } from '../shared/protocol.ts';
import type { Room, RoomSocket, RoomSocketInfo, CloseReason } from './room.ts';
import { CLOSE } from './room.ts';

export interface NetOptions {
  room: Room;
  /** Explicitly enabled development origins; production adds none. */
  devOrigins?: readonly string[];
  /** Production rejects an absent Origin; only a local dev proxy may relax this. */
  rejectMissingOrigin?: boolean;
  maxPendingSockets?: number;
  helloDeadlineMs?: number;
  maxClientFrameBytes?: number;
  now?: () => number;
}

export interface SocketData {
  connectionId: number;
  /** Captured at upgrade time: the room decides trust, but only the transport sees the header. */
  origin: string | null;
}

interface Connection {
  connectionId: number;
  socket: RoomSocket;
  info: RoomSocketInfo;
  helloed: boolean;
  helloDeadline: ReturnType<typeof setTimeout> | null;
  inputs: TokenBucket;
  commands: TokenBucket;
  baselineRequests: TokenBucket;
  closed: boolean;
}

/** Classic token bucket: `rate` per second, `burst` capacity, refilled on demand. */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(private readonly rate: number, private readonly burst: number, private readonly now: () => number) {
    this.tokens = burst;
    this.lastMs = now();
  }

  take(cost = 1): boolean {
    const nowMs = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.lastMs) / 1000) * this.rate);
    this.lastMs = nowMs;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}

/** One Bun socket shaped into the room's transport contract. */
class BunSocket implements RoomSocket {
  closed = false;

  constructor(readonly connectionId: number, private readonly ws: Bun.ServerWebSocket<SocketData>) {}

  get open(): boolean {
    return !this.closed && this.ws.readyState === 1;
  }

  sendControl(message: ServerMessage): void {
    if (!this.open) return;
    this.ws.sendText(JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): number {
    if (!this.open) return 0;
    return this.ws.sendBinary(bytes);
  }

  close(code: number, reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }
}

export class NetLayer {
  private readonly room: Room;
  private readonly devOrigins: readonly string[];
  private readonly rejectMissingOrigin: boolean;
  private readonly maxPending: number;
  private readonly helloDeadlineMs: number;
  private readonly maxClientFrameBytes: number;
  private readonly now: () => number;
  private readonly connections = new Map<number, Connection>();
  private readonly addressBuckets = new Map<string, TokenBucket>();
  private nextConnectionId = 1;
  private pending = 0;

  constructor(options: NetOptions) {
    this.room = options.room;
    this.devOrigins = options.devOrigins ?? [];
    this.rejectMissingOrigin = options.rejectMissingOrigin ?? true;
    this.maxPending = options.maxPendingSockets ?? RULES.maxPendingSockets;
    this.helloDeadlineMs = options.helloDeadlineMs ?? RULES.helloDeadlineS * 1000;
    this.maxClientFrameBytes = options.maxClientFrameBytes ?? RULES.maxClientFrameBytes;
    this.now = options.now ?? (() => Date.now());
  }

  /** Pending sockets are connections that have not completed a handshake yet. */
  get pendingSockets(): number {
    return this.pending;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Bun's websocket handler set, passed straight to `Bun.serve`. */
  get handlers(): Bun.WebSocketHandler<SocketData> {
    return {
      open: (ws: Bun.ServerWebSocket<SocketData>) => this.onOpen(ws),
      message: (ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) => this.onMessage(ws, message),
      drain: (ws: Bun.ServerWebSocket<SocketData>) => this.onDrain(ws),
      close: (ws: Bun.ServerWebSocket<SocketData>) => this.onClose(ws),
    };
  }

  /**
   * Validates Origin and the pending-socket cap, then upgrades. Returns false when the caller must
   * answer with a plain HTTP response.
   */
  upgrade(request: Request, server: Bun.Server<SocketData>): boolean {
    const origin = request.headers.get('origin');
    if (!this.originAllowed(origin)) return false;
    if (this.pending >= this.maxPending) return false;
    const connectionId = this.nextConnectionId++;
    const upgraded = server.upgrade(request, { data: { connectionId, origin: origin && origin.length > 0 ? origin : null } });
    if (upgraded) this.pending += 1;
    return upgraded;
  }

  originAllowed(origin: string | null): boolean {
    if (origin === null || origin.length === 0) return !this.rejectMissingOrigin;
    if (this.room.originAllowed(origin)) return true;
    return this.devOrigins.includes(origin);
  }

  private onOpen(ws: Bun.ServerWebSocket<SocketData>): void {
    const socket = new BunSocket(ws.data.connectionId, ws);
    const connection: Connection = {
      connectionId: ws.data.connectionId,
      socket,
      info: { remoteAddress: ws.remoteAddress, origin: ws.data.origin },
      helloed: false,
      helloDeadline: setTimeout(() => {
        // A socket that never completes a handshake costs a slot for five seconds and no more.
        this.closeConnection(connection.connectionId, CLOSE.rejected, 'rejected');
      }, this.helloDeadlineMs),
      inputs: new TokenBucket(RULES.inputRatePerSecond, RULES.inputBurst, this.now),
      commands: new TokenBucket(RULES.commandRatePerSecond, RULES.commandBurst, this.now),
      baselineRequests: new TokenBucket(RULES.baselineRequestsPerSecond, 2, this.now),
      closed: false,
    };
    this.connections.set(connection.connectionId, connection);
  }

  private onClose(ws: Bun.ServerWebSocket<SocketData>): void {
    this.forget(ws.data.connectionId);
    this.room.detach(ws.data.connectionId);
  }

  private onDrain(ws: Bun.ServerWebSocket<SocketData>): void {
    const connection = this.connections.get(ws.data.connectionId);
    if (connection) this.room.drain(connection.socket);
  }

  private onMessage(ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    const connection = this.connections.get(ws.data.connectionId);
    if (!connection || connection.closed) return;
    if (typeof message !== 'string') {
      // Binary client frames are never part of the control protocol.
      this.closeConnection(connection.connectionId, CLOSE.rejected, 'rejected');
      return;
    }
    if (message.length > this.maxClientFrameBytes) {
      this.closeConnection(connection.connectionId, CLOSE.slowClient, 'slow-client-buffer');
      return;
    }
    // The operator claim is a launcher-local message (B2) and deliberately not part of the shared
    // control plane, so it is recognised before the shared parser rejects the envelope.
    const claimToken = parseClaim(message);
    if (claimToken !== null) {
      this.room.claimOperator(connection.socket, claimToken);
      return;
    }
    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      this.closeConnection(connection.connectionId, CLOSE.rejected, 'rejected');
      return;
    }
    this.dispatch(connection, parsed.value);
  }

  private dispatch(connection: Connection, message: ClientMessage): void {
    const room = this.room;
    switch (message.t) {
      case 'hello': {
        if (!this.addressBucket(connection.info.remoteAddress).take()) {
          this.closeConnection(connection.connectionId, CLOSE.rejected, 'rejected');
          break;
        }
        connection.helloed = true;
        this.pending = Math.max(0, this.pending - 1);
        if (connection.helloDeadline !== null) {
          clearTimeout(connection.helloDeadline);
          connection.helloDeadline = null;
        }
        room.hello(connection.socket, connection.info, {
          name: message.name,
          roomCode: message.roomCode,
          resumeToken: message.resumeToken,
          campaignId: message.campaignId,
          protocol: message.protocol,
          contentVersion: message.contentVersion,
        });
        break;
      }
      case 'command': {
        if (!connection.commands.take()) {
          connection.socket.sendControl({ t: 'command-result', result: { requestId: message.requestId, ok: false, code: 'rate-limited' } });
          break;
        }
        room.command(connection.socket, message.requestId, message.command);
        break;
      }
      case 'input': {
        // Input has its own cadence budget; a burst beyond it is dropped, never queued.
        if (connection.inputs.take()) room.input(connection.socket, message.frame);
        break;
      }
      case 'release':
        room.release(connection.socket);
        break;
      case 'ping':
        room.ping(connection.socket, message.nonce, message.clientTimeMs);
        break;
      case 'baseline-ready': {
        if (connection.baselineRequests.take()) room.baselineReady(connection.socket, message.transferId, message.verified);
        break;
      }
      case 'baseline-request': {
        if (connection.baselineRequests.take()) room.requestBaseline(connection.socket);
        break;
      }
      case 'leave':
        room.leave(connection.socket);
        break;
    }
  }

  private addressBucket(address: string): TokenBucket {
    // One address may hold a bounded hello/code budget. The 60-second bucket is sized so eight
    // guests behind one NAT address still fit, which a flat per-second limit would refuse.
    let bucket = this.addressBuckets.get(address);
    if (!bucket) {
      bucket = new TokenBucket(RULES.codeAttemptsPerSecond, RULES.codeAttemptsPerSecond * RULES.codeBucketSeconds, this.now);
      this.addressBuckets.set(address, bucket);
    }
    return bucket;
  }

  closeConnection(connectionId: number, code: number, reason: CloseReason): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.closed = true;
    connection.socket.close(code, reason);
  }

  private forget(connectionId: number): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (!connection.helloed) this.pending = Math.max(0, this.pending - 1);
    if (connection.helloDeadline !== null) clearTimeout(connection.helloDeadline);
    this.connections.delete(connectionId);
  }

  /** Test seam: the origin captured at upgrade time for a connection id. */
  originFor(connectionId: number): string | null {
    return this.connections.get(connectionId)?.info.origin ?? null;
  }

  remoteAddressFor(connectionId: number): string | null {
    return this.connections.get(connectionId)?.info.remoteAddress ?? null;
  }
}

/** Recognises the launcher-local operator claim without weakening the shared control parser. */
function parseClaim(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed) && parsed.t === 'claim' && typeof parsed.token === 'string' && parsed.token.length <= 128) {
      return parsed.token;
    }
  } catch {
    // Not JSON: the shared parser will reject it on the same path as any other bad frame.
  }
  return null;
}
