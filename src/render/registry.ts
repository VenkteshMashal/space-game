/**
 * Entity registry and deferred detail queue (Plan A4).
 *
 * Everything dynamic in the flight scene is addressed by (id, generation), where the generation is
 * the authority's own identity for a body or a life. The registry is why a render loop can never
 * inherit a stale hull: an upsert with a new generation disposes the previous value before the new
 * one exists, and lookup is a Map hit, so nothing scans a list to find an entity.
 *
 * Rocks are the one thing expensive enough to defer. A fracture can hand us twenty deformed
 * icosahedrons in a single frame, so every new collider gets a cheap proxy immediately and the
 * detailed mesh waits in a bounded queue ordered by camera distance and target priority.
 * Superseded jobs (new generation, new epoch, or the body left the view) are dropped, never built.
 */

import type { Id } from '../shared/contracts.ts';

/** Anything the registry can own. */
export interface Disposable {
  dispose(): void;
}

export interface EntityEntry<V> {
  readonly id: Id;
  readonly generation: number;
  readonly epoch: Id | null;
  readonly value: V;
  /** Frame stamp from `beginFrame`/`upsert`, used to sweep entities the authority stopped reporting. */
  seen: number;
}

export interface UpsertResult<V> {
  readonly entry: EntityEntry<V>;
  /** True when this call created the value (a fresh entity or a new generation). */
  readonly created: boolean;
  /** True when an entity with the same id existed under a different generation or epoch. */
  readonly replaced: boolean;
}

export type CreateEntity<V, O> = (id: Id, generation: number, epoch: Id | null, options: O) => V;

export class EntityRegistry<V extends Disposable, O = undefined> {
  private readonly byId = new Map<Id, EntityEntry<V>>();
  private readonly create: CreateEntity<V, O>;
  private readonly release: (value: V) => void;
  private frame = 0;
  private disposed = false;

  constructor(create: CreateEntity<V, O>, release: (value: V) => void = value => value.dispose()) {
    this.create = create;
    this.release = release;
  }

  get size(): number {
    return this.byId.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Exact identity of the value: a stale caller can compare it against what it last rendered. */
  get(id: Id): V | undefined {
    return this.byId.get(id)?.value;
  }

  entry(id: Id): EntityEntry<V> | undefined {
    return this.byId.get(id);
  }

  has(id: Id): boolean {
    return this.byId.has(id);
  }

  ids(): Id[] {
    return [...this.byId.keys()];
  }

  entries(): EntityEntry<V>[] {
    return [...this.byId.values()];
  }

  beginFrame(): number {
    this.frame += 1;
    return this.frame;
  }

  /**
   * Create or update one entity. Same (id, generation, epoch) updates in place — the caller owns the
   * visual's per-frame mutation; anything else disposes the old value and builds a new one.
   */
  upsert(id: Id, generation: number, epoch: Id | null, options: O): UpsertResult<V> {
    this.assertLive();
    const existing = this.byId.get(id);
    if (existing && existing.generation === generation && existing.epoch === epoch) {
      existing.seen = this.frame;
      return { entry: existing, created: false, replaced: false };
    }
    if (existing) {
      this.release(existing.value);
      this.byId.delete(id);
    }
    const entry: EntityEntry<V> = {
      id,
      generation,
      epoch,
      value: this.create(id, generation, epoch, options),
      seen: this.frame,
    };
    this.byId.set(id, entry);
    return { entry, created: true, replaced: existing !== undefined };
  }

  remove(id: Id): boolean {
    this.assertLive();
    const existing = this.byId.get(id);
    if (!existing) return false;
    this.release(existing.value);
    this.byId.delete(id);
    return true;
  }

  /** Retire every entity that does not belong to `epoch`: a new match must not inherit the old one. */
  setEpoch(epoch: Id | null): number {
    this.assertLive();
    let retired = 0;
    for (const [id, entry] of this.byId) {
      if (entry.epoch === epoch) continue;
      this.release(entry.value);
      this.byId.delete(id);
      retired += 1;
    }
    return retired;
  }

  /** Drop entities the authority stopped reporting in the current frame. */
  pruneUnseen(): number {
    this.assertLive();
    let pruned = 0;
    for (const [id, entry] of this.byId) {
      if (entry.seen === this.frame) continue;
      this.release(entry.value);
      this.byId.delete(id);
      pruned += 1;
    }
    return pruned;
  }

  clear(): number {
    this.assertLive();
    const cleared = this.byId.size;
    for (const entry of this.byId.values()) this.release(entry.value);
    this.byId.clear();
    return cleared;
  }

  /** Idempotent: the second call is a no-op, matching SessionScope teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.byId.values()) this.release(entry.value);
    this.byId.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('EntityRegistry is disposed');
  }
}

export interface DetailJob {
  /** Stable identity of the entity the job belongs to: `${kind}:${id}`. */
  readonly key: string;
  readonly id: Id;
  readonly generation: number;
  readonly epoch: Id | null;
  readDistance: number;
  /** The local pilot's locked contact, or an immediate objective marker. */
  target: boolean;
}

/** Nearest first, targets ahead of everything: what the pilot is looking at is worth building first. */
function detailPriority(a: DetailJob, b: DetailJob): number {
  if (a.target !== b.target) return a.target ? -1 : 1;
  return a.readDistance - b.readDistance;
}

export class DetailQueue {
  /** Hard cap on pending detailed builds (A4: bounded ≤64). */
  static readonly MAX_PENDING = 64;

  private readonly jobs = new Map<string, DetailJob>();

  get size(): number {
    return this.jobs.size;
  }

  /**
   * Queue a detailed build. At capacity the worse of (incoming, worst pending) is dropped, so the
   * queue keeps the 64 most valuable jobs instead of refusing everything once it fills.
   */
  enqueue(job: DetailJob): boolean {
    if (this.jobs.has(job.key)) {
      this.jobs.set(job.key, job);
      return true;
    }
    if (this.jobs.size < DetailQueue.MAX_PENDING) {
      this.jobs.set(job.key, job);
      return true;
    }
    let worstKey: string | null = null;
    let worst: DetailJob | null = null;
    for (const candidate of this.jobs.values()) {
      if (!worst || detailPriority(candidate, worst) > 0) {
        worst = candidate;
        worstKey = candidate.key;
      }
    }
    if (!worst || !worstKey || detailPriority(job, worst) >= 0) return false;
    this.jobs.delete(worstKey);
    this.jobs.set(job.key, job);
    return true;
  }

  /** Re-score a pending job as the camera moves; returns false when it is no longer queued. */
  refresh(key: string, readDistance: number, target: boolean): boolean {
    const job = this.jobs.get(key);
    if (!job) return false;
    job.readDistance = readDistance;
    job.target = target;
    return true;
  }

  /** Cancel superseded generation/epoch work in one pass. */
  cancelWhere(predicate: (job: DetailJob) => boolean): number {
    let cancelled = 0;
    for (const [key, job] of this.jobs) {
      if (!predicate(job)) continue;
      this.jobs.delete(key);
      cancelled += 1;
    }
    return cancelled;
  }

  /** Take the best `limit` jobs, nearest and target-first. */
  take(limit: number): DetailJob[] {
    if (limit <= 0 || this.jobs.size === 0) return [];
    const ordered = [...this.jobs.values()].sort(detailPriority);
    const taken = ordered.slice(0, limit);
    for (const job of taken) this.jobs.delete(job.key);
    return taken;
  }

  /** Nearest-first view, for diagnostics and tests. */
  peek(): readonly DetailJob[] {
    return [...this.jobs.values()].sort(detailPriority);
  }

  clear(): number {
    const cleared = this.jobs.size;
    this.jobs.clear();
    return cleared;
  }
}
