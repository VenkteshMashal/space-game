/**
 * Quality tiers (Plan A6). The renderer measures its own frame cost in rolling windows and steps
 * one tier at a time: down after three bad windows, up after ten good ones. Auto is the default;
 * an explicit Low/Medium/High pins the tier and the controller keeps measuring for telemetry only.
 *
 * Tier is presentation, never rules. The policy below states that as types: no tier may change a
 * hitbox, hide an obstacle, alter contact eligibility or touch the server step. Degrading is
 * honest — fewer particles, simpler materials, a lower DPR cap — or it is not done at all.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export type QualityMode = 'auto' | QualityTier;

export const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

export interface TierBudget {
  readonly tier: QualityTier;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly maxDpr: number;
  /** Particle ring capacity: the one visual budget a low-tier machine can always afford to lose. */
  readonly particles: number;
  /** Detailed meshes built per frame from the bounded queue. */
  readonly detailPerFrame: number;
  readonly gpuMiB: number;
  /**
   * MSAA is chosen when the renderer is created and cannot change without a context rebuild, so it
   * is a tier *start* decision. Bloom/post-processing is not implemented: A6 says to record the
   * cost of expensive shader features before adopting one, and that measurement does not exist yet.
   */
  readonly antialias: boolean;
}

export const TIER_BUDGETS: Readonly<Record<QualityTier, TierBudget>> = {
  low: { tier: 'low', drawCalls: 100, triangles: 150_000, maxDpr: 1, particles: 125, detailPerFrame: 1, gpuMiB: 128, antialias: false },
  medium: { tier: 'medium', drawCalls: 180, triangles: 350_000, maxDpr: 1.5, particles: 250, detailPerFrame: 2, gpuMiB: 192, antialias: true },
  high: { tier: 'high', drawCalls: 250, triangles: 700_000, maxDpr: 2, particles: 500, detailPerFrame: 3, gpuMiB: 256, antialias: true },
};

export const WINDOW_MS = 2000;
export const DESKTOP_TARGET_MS = 16.7;
export const PHONE_TARGET_MS = 33.3;
export const BAD_WINDOWS_TO_STEP_DOWN = 3;
export const GOOD_WINDOWS_TO_STEP_UP = 10;
export const DETAIL_QUEUE_LIMIT = 64;

export interface TierPolicy extends TierBudget {
  readonly mode: QualityMode;
  readonly targetFrameMs: number;
  readonly windowMs: number;
  readonly detailQueueLimit: number;
  /** Contract: tier changes presentation only. */
  readonly gameplay: {
    readonly changeHitboxes: false;
    readonly hideObstacles: false;
    readonly changeContactEligibility: false;
    readonly changeServerStep: false;
  };
}

export interface TierWindow {
  /** 1-based index of the window that just closed. */
  readonly window: number;
  readonly samples: number;
  readonly p95Ms: number;
  readonly tier: QualityTier;
  readonly previousTier: QualityTier;
  readonly direction: 'up' | 'down' | null;
}

export interface TierStats {
  readonly windows: number;
  readonly badRun: number;
  readonly goodRun: number;
  readonly samples: number;
  readonly p95Ms: number;
}

export interface TierOptions {
  readonly mode?: QualityMode;
  readonly tier?: QualityTier;
  readonly targetFrameMs?: number;
  readonly windowMs?: number;
  readonly badWindows?: number;
  readonly goodWindows?: number;
}

export class TierController {
  private mode: QualityMode;
  private current: QualityTier;
  private target: number;
  private readonly windowMs: number;
  private readonly badWindows: number;
  private readonly goodWindows: number;

  private readonly samples: number[] = [];
  private accumulated = 0;
  private windowCount = 0;
  private badRun = 0;
  private goodRun = 0;
  private lastP95 = 0;
  private inspected = 0;

  constructor(options: TierOptions = {}) {
    this.mode = options.mode ?? 'auto';
    this.current = options.tier ?? (this.mode === 'auto' ? 'high' : this.mode);
    this.target = options.targetFrameMs ?? DESKTOP_TARGET_MS;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.badWindows = options.badWindows ?? BAD_WINDOWS_TO_STEP_DOWN;
    this.goodWindows = options.goodWindows ?? GOOD_WINDOWS_TO_STEP_UP;
  }

  get tier(): QualityTier {
    return this.current;
  }

  get qualityMode(): QualityMode {
    return this.mode;
  }

  get budget(): TierBudget {
    return TIER_BUDGETS[this.current];
  }

  get policy(): TierPolicy {
    return {
      ...this.budget,
      mode: this.mode,
      targetFrameMs: this.target,
      windowMs: this.windowMs,
      detailQueueLimit: DETAIL_QUEUE_LIMIT,
      gameplay: { changeHitboxes: false, hideObstacles: false, changeContactEligibility: false, changeServerStep: false },
    };
  }

  get stats(): TierStats {
    return { windows: this.windowCount, badRun: this.badRun, goodRun: this.goodRun, samples: this.inspected, p95Ms: this.lastP95 };
  }

  /** `auto` resumes stepping from wherever the current tier is. */
  setMode(mode: QualityMode): void {
    this.mode = mode;
    if (mode !== 'auto') {
      this.current = mode;
      this.badRun = 0;
      this.goodRun = 0;
    }
  }

  /** Desktop 16.7 ms, midrange phone 33.3 ms: the same logic, measured against a different bar. */
  setTargetFrameMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.target = ms;
  }

  /**
   * Feed one frame duration. Returns the verdict when a window closes, otherwise null. Durations
   * are summed rather than taken from a wall clock: a stalled tab must still close its window.
   */
  sample(frameMs: number): TierWindow | null {
    if (!Number.isFinite(frameMs) || frameMs < 0) return null;
    this.samples.push(frameMs);
    this.accumulated += frameMs;
    this.inspected += 1;
    if (this.accumulated < this.windowMs) return null;

    const p95 = nearestRankP95(this.samples);
    const windowSamples = this.samples.length;
    this.lastP95 = p95;
    this.windowCount += 1;
    const previousTier = this.current;
    let direction: 'up' | 'down' | null = null;

    if (p95 > this.target) {
      this.badRun += 1;
      this.goodRun = 0;
      if (this.mode === 'auto' && this.badRun >= this.badWindows) {
        const next = stepTier(this.current, -1);
        if (next !== this.current) {
          this.current = next;
          direction = 'down';
        }
        this.badRun = 0;
      }
    } else {
      this.goodRun += 1;
      this.badRun = 0;
      if (this.mode === 'auto' && this.goodRun >= this.goodWindows) {
        const next = stepTier(this.current, 1);
        if (next !== this.current) {
          this.current = next;
          direction = 'up';
        }
        this.goodRun = 0;
      }
    }

    this.samples.length = 0;
    this.accumulated = 0;
    return { window: this.windowCount, samples: windowSamples, p95Ms: p95, tier: this.current, previousTier, direction };
  }

  reset(): void {
    this.samples.length = 0;
    this.accumulated = 0;
    this.windowCount = 0;
    this.badRun = 0;
    this.goodRun = 0;
    this.lastP95 = 0;
    this.inspected = 0;
  }
}

function stepTier(tier: QualityTier, delta: number): QualityTier {
  const index = TIER_ORDER.indexOf(tier);
  const next = Math.min(TIER_ORDER.length - 1, Math.max(0, index + delta));
  return TIER_ORDER[next]!;
}

/** Nearest-rank p95: deterministic, allocation-free, and honest about small windows. */
function nearestRankP95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[rank] ?? 0;
}
