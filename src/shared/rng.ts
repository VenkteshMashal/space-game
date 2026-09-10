/**
 * Seeded random streams (Plan B7: "Separate seeded RNG streams for mission, fracture and each
 * bot"). Separate streams matter because a mission roll must not change when a bot changes its mind,
 * and a replay must reproduce both exactly.
 *
 * mulberry32: 32-bit state, no allocation, identical results in every JS engine (all arithmetic is
 * integer or exact float), which is what the replay and the checkpoint format need.
 */

export type RngStream = 'mission' | 'fracture' | 'sensor' | 'bot' | 'spawn' | 'storm' | 'geometry';

/**
 * The original generator the procedural rock and hull geometry was authored against. It is kept
 * byte-for-byte so moving it here could not change a single asteroid or hull: `createRng` is for
 * new gameplay streams, this is for content that must keep its exact appearance.
 */
export function randomSeed(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** True with probability `chance`. */
  chance(chance: number): boolean;
  /** Current state, for checkpoints. */
  state(): number;
}

export function createRng(seed: number, stream: RngStream = 'mission', index = 0): Rng {
  return rngFromState(mix(seed, streamKey(stream) + index * 0x9e3779b9));
}

/** Rebuild a stream from a checkpointed state (Plan B9 saves the RNG streams). */
export function restoreRng(state: number): Rng {
  return rngFromState(state >>> 0);
}

function rngFromState(initial: number): Rng {
  let state = initial >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => (maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive)),
    range: (min: number, max: number) => min + next() * (max - min),
    chance: (probability: number) => next() < probability,
    state: () => state,
  };
}

function streamKey(stream: RngStream): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stream.length; i++) {
    hash ^= stream.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mix(seed: number, salt: number): number {
  let value = (seed ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}
