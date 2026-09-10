/**
 * Own-ship prediction and remote interpolation (Plan B4.5–B4.7).
 *
 * Two rules shape this file. Prediction replays the *same* `stepMotion` the authority runs, so a
 * predicted frame can only differ by the inputs the server has not seen yet. And prediction is
 * limited to own flight plus provisional cosmetic shots: score, damage, inventory and module state
 * are never predicted, because a wrong guess there is a lie the player can act on.
 *
 * Correction is split in two: physical state takes the authoritative value immediately, while a
 * visual offset decays over ~100 ms so the hull does not visibly teleport for a small error. Beyond
 * 25 m, or on a life/epoch change, the offset is dropped and the ship snaps.
 */

import type { FitDerivation, FlightIntent, Id, PredictionState, ScheduledInput, SlotKind, Vec2 } from '../../shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../../shared/contracts.ts';
import { normalizeAngle, stepMotion } from '../../sim/motion.ts';

/** Discontinuity threshold: beyond this the mesh snaps instead of sliding (B4.7). */
export const SNAP_DISTANCE_M = 25;
/** Visual correction half-life, in seconds; a small error is gone in about 100 ms. */
const CORRECTION_TAU_S = 0.1;
const HISTORY_TICKS = 256;

export interface PredictionMismatch { errorM: number; snapped: boolean; sequential: boolean }

export class Predictor {
  private history: PredictionState[] = [];
  private pending: ScheduledInput[] = [];
  private offset: Vec2 = { x: 0, y: 0 };
  private lifeId: Id | null = null;
  private epoch: Id | null = null;
  private appliedSeq = 0;
  private lastAuthoritativeTick = -1;
  private mismatch = 0;

  constructor(private readonly derived: FitDerivation, private readonly priority: readonly SlotKind[]) {}

  /** A life or epoch change invalidates every prediction; history must not survive it. */
  setLife(lifeId: Id, epoch: Id): boolean {
    if (this.lifeId === lifeId && this.epoch === epoch) return false;
    this.lifeId = lifeId;
    this.epoch = epoch;
    this.reset();
    return true;
  }

  reset(): void {
    this.history.length = 0;
    this.pending.length = 0;
    this.offset = { x: 0, y: 0 };
    this.appliedSeq = 0;
    this.lastAuthoritativeTick = -1;
  }

  /** Record the authoritative self state from a snapshot and return the correction it implies. */
  reconcile(authoritative: PredictionState, appliedSeq: number, previous: PredictionState | null): PredictionMismatch {
    this.appliedSeq = appliedSeq;
    this.pending = this.pending.filter(input => input.seq > appliedSeq);
    this.history.push(cloneState(authoritative));
    if (this.history.length > HISTORY_TICKS) this.history.shift();
    const error = previous ? distance(previous.position, authoritative.position) : 0;
    // "Sequential" is about the authority's own timeline, not about the predicted present: the
    // prediction normally runs ahead of the newest snapshot, and that is not a discontinuity.
    const sequential = authoritative.tick > this.lastAuthoritativeTick;
    this.lastAuthoritativeTick = Math.max(this.lastAuthoritativeTick, authoritative.tick);
    const snapped = error > SNAP_DISTANCE_M || !sequential;
    if (error > 0) this.mismatch += 1;
    if (snapped || !previous) {
      // Snap: the mesh takes the authoritative position with no residual correction.
      this.offset = { x: 0, y: 0 };
    } else {
      // Keep showing where the ship *was* being drawn and slide to the authoritative pose.
      this.offset = {
        x: previous.position.x + this.offset.x - authoritative.position.x,
        y: previous.position.y + this.offset.y - authoritative.position.y,
      };
    }
    return { errorM: error, snapped, sequential };
  }

  recordInput(frame: ScheduledInput): void {
    this.pending.push(frame);
    if (this.pending.length > 64) this.pending.shift();
  }

  /** Latest authoritative sample, or null before the first snapshot arrives. */
  latest(): PredictionState | null {
    return this.history.length > 0 ? this.history[this.history.length - 1]! : null;
  }

  /**
   * Replay from the newest authoritative tick to `nowTick`. Inputs the authority has not
   * acknowledged are applied at their scheduled tick; after that the last known intent holds, which
   * matches the server's input lease.
   */
  predict(nowTick: number, heldIntent: FlightIntent | null): PredictionState | null {
    const start = this.latest();
    if (!start) return null;
    const target = Math.max(start.tick, Math.min(nowTick, start.tick + HISTORY_TICKS));
    const state = cloneState(start);
    const dt = 1 / RELEASE.physicsHz;
    const scheduled = [...this.pending].sort((a, b) => a.applyAtTick - b.applyAtTick || a.seq - b.seq);
    let intent = heldIntent ?? EMPTY_FLIGHT_INTENT;
    for (let tick = start.tick + 1; tick <= target; tick++) {
      for (const input of scheduled) if (input.applyAtTick === tick) intent = input.intent;
      stepMotion({
        body: state,
        resources: state,
        derived: this.derived,
        priority: this.priority,
        intent,
        dt,
        scanning: false,
        weaponDemandMW: 0,
      });
      // The authority integrates position in its contact step; the client has no contact step, so
      // it advances by the predicted velocity for the same tick.
      state.position = { x: state.position.x + state.velocity.x * dt, y: state.position.y + state.velocity.y * dt };
      state.angle = normalizeAngle(state.angle + state.angularVelocity * dt);
      state.tick = tick;
    }
    return state;
  }

  /** Rendered position: the physical prediction plus the decaying visual offset. */
  renderPosition(predicted: PredictionState): Vec2 {
    return { x: predicted.position.x + this.offset.x, y: predicted.position.y + this.offset.y };
  }

  /** Decay the visual offset. A correction is invisible after roughly 100 ms. */
  decay(dt: number): void {
    const factor = Math.exp(-dt / CORRECTION_TAU_S);
    this.offset = { x: this.offset.x * factor, y: this.offset.y * factor };
    // A centimetre of residual offset is below one pixel at gameplay zoom; keeping it forever would
    // leave the hull permanently off its predicted pose.
    if (Math.abs(this.offset.x) < 0.01 && Math.abs(this.offset.y) < 0.01) this.offset = { x: 0, y: 0 };
  }

  /** True while the ship is showing a correction; the HUD uses it to avoid drawing false colliders. */
  correcting(): boolean {
    return this.offset.x !== 0 || this.offset.y !== 0;
  }

  corrections(): number {
    return this.mismatch;
  }
}

function cloneState(state: PredictionState): PredictionState {
  return {
    tick: state.tick,
    position: { x: state.position.x, y: state.position.y },
    velocity: { x: state.velocity.x, y: state.velocity.y },
    angle: state.angle,
    angularVelocity: state.angularVelocity,
    fuelKg: state.fuelKg,
    heatMJ: state.heatMJ,
    capacitorMJ: state.capacitorMJ,
    angularAssist: state.angularAssist,
  };
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface RemoteSample {
  tick: number;
  position: Vec2;
  velocity: Vec2;
  angle: number;
}

export interface RemoteRender {
  position: Vec2;
  velocity: Vec2;
  angle: number;
  /** True when the newest sample is older than the extrapolation window. */
  stale: boolean;
  /** True when the render time lies beyond the newest sample, so the position is extrapolated. */
  extrapolated: boolean;
}

const MAX_EXTRAPOLATION_S = 0.1;
const REMOTE_HISTORY_TICKS = 64;

/** Remote ships keep a 64-tick history and are rendered behind the newest sample (B4). */
export class RemoteInterpolator {
  private samples: RemoteSample[] = [];
  delayMs = 100;

  push(sample: RemoteSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && sample.tick <= last.tick) return;
    this.samples.push({ tick: sample.tick, position: { ...sample.position }, velocity: { ...sample.velocity }, angle: sample.angle });
    if (this.samples.length > REMOTE_HISTORY_TICKS) this.samples.shift();
  }

  /** Adapt the render delay to observed jitter within 50–150 ms, with hysteresis (B4). */
  adapt(jitterMs: number): void {
    const target = Math.min(150, Math.max(50, 100 + jitterMs));
    // Hysteresis: a small jitter excursion must not make the delay oscillate every window.
    if (Math.abs(target - this.delayMs) < 10) return;
    this.delayMs += Math.sign(target - this.delayMs) * 10;
  }

  sample(renderTick: number): RemoteRender | null {
    if (this.samples.length === 0) return null;
    const newest = this.samples[this.samples.length - 1]!;
    const oldest = this.samples[0]!;
    if (renderTick <= oldest.tick) {
      return { position: { ...oldest.position }, velocity: { ...oldest.velocity }, angle: oldest.angle, stale: true, extrapolated: false };
    }
    if (renderTick >= newest.tick) {
      const aheadTicks = renderTick - newest.tick;
      const aheadSeconds = aheadTicks / RELEASE.physicsHz;
      if (aheadSeconds > MAX_EXTRAPOLATION_S) {
        return { position: { ...newest.position }, velocity: { ...newest.velocity }, angle: newest.angle, stale: true, extrapolated: false };
      }
      return {
        position: { x: newest.position.x + newest.velocity.x * aheadSeconds, y: newest.position.y + newest.velocity.y * aheadSeconds },
        velocity: { ...newest.velocity },
        angle: newest.angle,
        stale: false,
        extrapolated: true,
      };
    }
    for (let index = this.samples.length - 1; index > 0; index--) {
      const next = this.samples[index]!;
      const prev = this.samples[index - 1]!;
      if (renderTick < prev.tick || renderTick > next.tick) continue;
      const span = next.tick - prev.tick;
      const t = span === 0 ? 0 : (renderTick - prev.tick) / span;
      return {
        position: { x: prev.position.x + (next.position.x - prev.position.x) * t, y: prev.position.y + (next.position.y - prev.position.y) * t },
        velocity: { x: prev.velocity.x + (next.velocity.x - prev.velocity.x) * t, y: prev.velocity.y + (next.velocity.y - prev.velocity.y) * t },
        angle: prev.angle + shortestAngleDelta(prev.angle, next.angle) * t,
        stale: false,
        extrapolated: false,
      };
    }
    return { position: { ...newest.position }, velocity: { ...newest.velocity }, angle: newest.angle, stale: false, extrapolated: false };
  }

  size(): number {
    return this.samples.length;
  }
}

/** Interpolate the short way round, so a ship crossing ±π does not spin the long way. */
export function shortestAngleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/** Render tick for a snapshot stream: newest authority tick minus the adaptive delay. */
export function renderTickFor(newestTick: number, delayMs: number): number {
  return newestTick - (delayMs / 1000) * RELEASE.physicsHz;
}
