/**
 * Session scope (Plan A1). One object owns everything a session generation creates — view/event
 * subscriptions, animation frames, the loader worker, audio voices, captured input and GPU
 * resource leases — so a disconnect, a second match or a page teardown cannot leave a listener,
 * a frame loop or a lease behind.
 *
 * Two rules the rest of the shell relies on:
 *   - Disposal is idempotent and happens exactly once even when `error` and `close` arrive
 *     together, so the UI never tears a live match down twice.
 *   - A connect occupies a generation. Starting a newer connect aborts the older one, so a stale
 *     attempt can never install itself over the current session.
 */

import type { ClientView, ConnectOptions, Id, SessionEvent, SessionPort } from '../shared/contracts.ts';
import { browserClock, type FrameClock } from './ports.ts';

export type ReleaseReason = Parameters<SessionPort['releaseControls']>[0];

export interface ScopeStats {
  readonly generation: number;
  readonly disposed: boolean;
  readonly teardowns: number;
  readonly viewSubscriptions: number;
  readonly eventSubscriptions: number;
  readonly frames: number;
  readonly voices: number;
  readonly leases: number;
  readonly workers: number;
  readonly captures: number;
}

export interface ConnectAttempt {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface ScopeListeners {
  readonly view: (view: ClientView) => void;
  readonly event: (event: SessionEvent) => void;
}

/** A replayable cleanup: whoever holds the resource supplies how to free it. */
export interface Lease {
  readonly id: string;
  readonly release: () => void;
}

export class SessionScope {
  private readonly clock: FrameClock;
  private session: SessionPort;
  private viewUnsubscribe: (() => void) | null = null;
  private eventUnsubscribe: (() => void) | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private readonly frameHandles = new Set<number>();
  private readonly voices = new Set<Id>();
  private readonly leases = new Map<Id, () => void>();
  private readonly workers = new Map<Id, () => void>();
  private readonly captures = new Map<Id, () => void>();
  private teardowns = 0;
  private disposed = false;
  private disposing: Promise<void> | null = null;

  constructor(session: SessionPort, clock: FrameClock = browserClock) {
    this.session = session;
    this.clock = clock;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Subscribe for the current generation. Re-attaching drops the previous generation's subs. */
  attach(session: SessionPort, listeners: ScopeListeners): void {
    if (this.disposed) return;
    this.detachSubscriptions();
    this.session = session;
    this.viewUnsubscribe = session.subscribe(listeners.view);
    this.eventUnsubscribe = session.events(listeners.event);
  }

  /**
   * Claim the next generation and abort whatever the previous one was doing. The caller must drop
   * the result if `isCurrent` turns false before its await resolves.
   */
  beginConnect(): ConnectAttempt {
    this.abortConnect();
    this.generation += 1;
    this.controller = new AbortController();
    return { generation: this.generation, signal: this.controller.signal };
  }

  isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  /** Abort an in-flight connect without ending the scope (used when the pilot cancels). */
  abortConnect(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Connect through the scope. Resolves false for a superseded generation instead of throwing, so
   * a cancelled attempt is not reported to the pilot as a failure.
   */
  async connect(options: ConnectOptions): Promise<{ connected: boolean; generation: number; error: unknown }> {
    const attempt = this.beginConnect();
    try {
      await this.session.connect(options, attempt.signal);
      return { connected: this.isCurrent(attempt.generation), generation: attempt.generation, error: null };
    } catch (error) {
      return { connected: false, generation: attempt.generation, error };
    }
  }

  requestFrame(callback: (timeMs: number) => void): number {
    if (this.disposed) return 0;
    const handle = this.clock.requestFrame(timeMs => {
      this.frameHandles.delete(handle);
      if (this.disposed) return;
      callback(timeMs);
    });
    this.frameHandles.add(handle);
    return handle;
  }

  cancelFrames(): void {
    for (const handle of this.frameHandles) this.clock.cancelFrame(handle);
    this.frameHandles.clear();
  }

  /** Audio voices, GPU leases and workers are all "hold until released" resources. */
  captureVoice(id: Id): void {
    this.voices.add(id);
  }

  releaseVoice(id: Id): void {
    this.voices.delete(id);
  }

  holdLease(lease: Lease): void {
    this.releaseLease(lease.id);
    this.leases.set(lease.id, lease.release);
  }

  releaseLease(id: Id): void {
    const release = this.leases.get(id);
    if (!release) return;
    this.leases.delete(id);
    release();
  }

  holdWorker(id: Id, terminate: () => void): void {
    this.workers.get(id)?.();
    this.workers.set(id, terminate);
  }

  releaseWorker(id: Id): void {
    const terminate = this.workers.get(id);
    if (!terminate) return;
    this.workers.delete(id);
    terminate();
  }

  /** Input capture is registered by the input router; the scope only guarantees the release. */
  holdCapture(id: Id, release: () => void): void {
    this.captures.set(id, release);
  }

  releaseCapture(id: Id): void {
    const release = this.captures.get(id);
    if (!release) return;
    this.captures.delete(id);
    release();
  }

  /**
   * The single approved path for letting go of the controls: local captures first, then the
   * adapter, so a held key cannot reactivate after the authority has been told to forget it.
   */
  releaseControls(reason: ReleaseReason): void {
    for (const release of [...this.captures.values()]) release();
    this.captures.clear();
    this.session.releaseControls(reason);
  }

  /**
   * `error` and `close` can both arrive for one dead socket. Whichever lands first tears the scope
   * down; the second is a no-op rather than a second teardown.
   */
  markClosed(): boolean {
    if (this.disposed || this.disposing) return false;
    void this.dispose();
    return true;
  }

  stats(): ScopeStats {
    return {
      generation: this.generation,
      disposed: this.disposed,
      teardowns: this.teardowns,
      viewSubscriptions: this.viewUnsubscribe ? 1 : 0,
      eventSubscriptions: this.eventUnsubscribe ? 1 : 0,
      frames: this.frameHandles.size,
      voices: this.voices.size,
      leases: this.leases.size,
      workers: this.workers.size,
      captures: this.captures.size,
    };
  }

  dispose(): Promise<void> {
    this.disposing ??= this.teardown();
    return this.disposing;
  }

  private async teardown(): Promise<void> {
    this.disposed = true;
    this.teardowns += 1;
    this.detachSubscriptions();
    this.abortConnect();
    this.cancelFrames();
    this.releaseAll();
    await this.session.dispose();
  }

  private detachSubscriptions(): void {
    this.viewUnsubscribe?.();
    this.eventUnsubscribe?.();
    this.viewUnsubscribe = null;
    this.eventUnsubscribe = null;
  }

  private releaseAll(): void {
    for (const release of [...this.captures.values()]) release();
    this.captures.clear();
    for (const id of [...this.leases.keys()]) this.releaseLease(id);
    for (const id of [...this.workers.keys()]) this.releaseWorker(id);
    for (const id of [...this.voices]) this.releaseVoice(id);
  }
}
