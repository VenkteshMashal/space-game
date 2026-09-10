/**
 * Session audio mixer (Plan A5). Five buses (master/music/effects/UI/voice), gesture-only context
 * creation so no browser blocks autoplay, authority events deduplicated by event id across replay,
 * bounded voices (≤32 one-shots, ≤8 continuous engines) culled nearest/important-wins, and total
 * teardown on session dispose. External combat is a restrained tactical sonification: distances are
 * compressed and anything outside the tactical range is simply not played; the vacuum never rings.
 *
 * The context is injected so tests can assert voice budgets and disposal without a browser.
 */

import type { EventPayloadByKind, Id, SessionEvent, Vec2 } from '../shared/contracts.ts';
import {
  createEngineVoice,
  defaultContextFactory,
  playTones,
  toneLength,
  type AudioContextLike,
  type AudioNodeLike,
  type EngineVoice,
  type GainLike,
  type OneShotVoice,
  type ToneStep,
} from './synth.ts';

export type BusId = 'master' | 'music' | 'effects' | 'ui' | 'voice';
export type CueBus = Exclude<BusId, 'master'>;

export const BUS_IDS: readonly BusId[] = ['master', 'music', 'effects', 'ui', 'voice'];

export type CueId =
  | 'impact-confirmed'
  | 'impact-remote'
  | 'lock-warning'
  | 'thermal-limit'
  | 'objective-complete'
  | 'ally-distress'
  | 'save-failed'
  | 'save-ok'
  | 'boundary'
  | 'destroyed'
  | 'ui-click'
  | 'ui-deny';

export interface CueRecipe {
  readonly bus: CueBus;
  /** Higher wins a voice-budget contest; distance only breaks ties. */
  readonly priority: number;
  readonly gain: number;
  /** Combat/impact cues are placed in the compressed tactical field; alerts and crew are not. */
  readonly spatial: boolean;
  readonly tones: readonly ToneStep[];
}

const CUE_RECIPES: Readonly<Record<CueId, CueRecipe>> = {
  'impact-confirmed': {
    bus: 'effects', priority: 9, gain: 0.5, spatial: true,
    tones: [
      { freq: 900, to: 220, at: 0, duration: 0.16, gain: 0.55, type: 'square' },
      { freq: 1500, to: 600, at: 0, duration: 0.08, gain: 0.25, type: 'triangle' },
    ],
  },
  'impact-remote': {
    bus: 'effects', priority: 4, gain: 0.32, spatial: true,
    tones: [{ freq: 520, to: 190, at: 0, duration: 0.12, gain: 0.4, type: 'triangle' }],
  },
  'lock-warning': {
    bus: 'ui', priority: 6, gain: 0.34, spatial: false,
    tones: [
      { freq: 640, to: 900, at: 0, duration: 0.1, gain: 0.5, type: 'triangle' },
      { freq: 640, to: 900, at: 0.16, duration: 0.1, gain: 0.42, type: 'triangle' },
    ],
  },
  'thermal-limit': {
    bus: 'effects', priority: 6, gain: 0.34, spatial: false,
    tones: [{ freq: 320, to: 190, at: 0, duration: 0.5, gain: 0.45, type: 'sawtooth' }],
  },
  'objective-complete': {
    bus: 'ui', priority: 5, gain: 0.3, spatial: false,
    tones: [
      { freq: 523, at: 0, duration: 0.24, gain: 0.4, type: 'sine' },
      { freq: 659, at: 0.1, duration: 0.24, gain: 0.38, type: 'sine' },
      { freq: 784, at: 0.2, duration: 0.3, gain: 0.36, type: 'sine' },
    ],
  },
  'ally-distress': {
    bus: 'voice', priority: 9, gain: 0.36, spatial: false,
    tones: [
      { freq: 520, at: 0, duration: 0.18, gain: 0.45, type: 'sine' },
      { freq: 392, at: 0.22, duration: 0.32, gain: 0.4, type: 'sine' },
    ],
  },
  'save-failed': {
    bus: 'voice', priority: 9, gain: 0.36, spatial: false,
    tones: [
      { freq: 220, to: 150, at: 0, duration: 0.4, gain: 0.45, type: 'square' },
      { freq: 180, to: 120, at: 0.3, duration: 0.5, gain: 0.34, type: 'square' },
    ],
  },
  'save-ok': {
    bus: 'ui', priority: 4, gain: 0.28, spatial: false,
    tones: [
      { freq: 660, at: 0, duration: 0.12, gain: 0.4, type: 'triangle' },
      { freq: 880, at: 0.12, duration: 0.2, gain: 0.34, type: 'triangle' },
    ],
  },
  boundary: {
    bus: 'effects', priority: 5, gain: 0.3, spatial: false,
    tones: [
      { freq: 520, at: 0, duration: 0.12, gain: 0.45, type: 'square' },
      { freq: 520, at: 0.2, duration: 0.12, gain: 0.38, type: 'square' },
    ],
  },
  destroyed: {
    bus: 'effects', priority: 8, gain: 0.45, spatial: false,
    tones: [{ freq: 220, to: 60, at: 0, duration: 0.7, gain: 0.5, type: 'sawtooth' }],
  },
  'ui-click': {
    bus: 'ui', priority: 1, gain: 0.22, spatial: false,
    tones: [{ freq: 880, at: 0, duration: 0.05, gain: 0.35, type: 'sine' }],
  },
  'ui-deny': {
    bus: 'ui', priority: 2, gain: 0.24, spatial: false,
    tones: [{ freq: 200, at: 0, duration: 0.12, gain: 0.45, type: 'square' }],
  },
};

export interface PlayRequest {
  readonly cue: CueId;
  /** Dedupe key, normally an authority `eventId`: the same event plays once across replay. */
  readonly key?: string;
  readonly position?: Vec2 | null;
  readonly gain?: number;
}

export interface MixerOptions {
  readonly contextFactory?: () => AudioContextLike | null;
  readonly selfPilotId?: Id | null;
  readonly maxEffectVoices?: number;
  readonly maxEngines?: number;
  readonly volumes?: Partial<Record<BusId, number>>;
}

interface EffectVoice {
  readonly key: string | null;
  readonly priority: number;
  readonly position: Vec2 | null;
  readonly endAt: number;
  readonly handle: OneShotVoice;
}

interface EngineSlot {
  readonly id: Id;
  readonly voice: EngineVoice;
  thrust: number;
  position: Vec2 | null;
  score: number;
}

const MAX_PLAYED_KEYS = 256;
/** Compressed tactical range: farther combat is dropped, never distant thunder. */
const AUDIBLE_RANGE_M = 1200;
const MIN_AUDIBLE_GAIN = 0.02;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Pure event -> cue mapping so the cue conventions are testable without a mixer. */
export function cueForEvent(event: SessionEvent, selfPilotId: Id | null): CueId | null {
  switch (event.kind) {
    case 'impact': {
      const payload = event.payload as EventPayloadByKind['impact'];
      return payload.victimPilotId === selfPilotId || payload.attackerPilotId === selfPilotId
        ? 'impact-confirmed'
        : 'impact-remote';
    }
    case 'notice': {
      const payload = event.payload as EventPayloadByKind['notice'];
      if (payload.code === 'thermal-limit') return 'thermal-limit';
      if (payload.code === 'boundary-warning' || payload.code === 'boundary-tow') return 'boundary';
      return null;
    }
    case 'objective': {
      const payload = event.payload as EventPayloadByKind['objective'];
      return payload.state === 'complete' ? 'objective-complete' : null;
    }
    case 'save': {
      const payload = event.payload as EventPayloadByKind['save'];
      if (payload.state === 'failed') return 'save-failed';
      if (payload.state === 'saved') return 'save-ok';
      return null;
    }
    case 'life': {
      const payload = event.payload as EventPayloadByKind['life'];
      if (payload.pilotId === selfPilotId) return payload.life === 'destroyed' ? 'destroyed' : null;
      return payload.life === 'disabled' || payload.life === 'destroyed' ? 'ally-distress' : null;
    }
    default:
      return null;
  }
}

export class AudioMixer {
  private readonly factory: () => AudioContextLike | null;
  private readonly maxEffectVoices: number;
  private readonly maxEngines: number;
  private readonly volumes: Record<BusId, number>;
  private readonly playedKeys = new Set<string>();
  private readonly effects: EffectVoice[] = [];
  private readonly engines = new Map<Id, EngineSlot>();
  private selfPilotId: Id | null;
  private context: AudioContextLike | null = null;
  private buses: Record<BusId, GainLike> | null = null;
  private listenerPoint: Vec2 = { x: 0, y: 0 };
  private unlocked = false;
  private disposed = false;

  constructor(options: MixerOptions = {}) {
    this.factory = options.contextFactory ?? defaultContextFactory;
    this.selfPilotId = options.selfPilotId ?? null;
    this.maxEffectVoices = options.maxEffectVoices ?? 32;
    this.maxEngines = options.maxEngines ?? 8;
    this.volumes = {
      master: clamp01(options.volumes?.master ?? 0.8),
      music: clamp01(options.volumes?.music ?? 0.5),
      effects: clamp01(options.volumes?.effects ?? 0.8),
      ui: clamp01(options.volumes?.ui ?? 0.7),
      voice: clamp01(options.volumes?.voice ?? 0.8),
    };
  }

  // --- lifecycle -----------------------------------------------------------------------------

  /** Only ever called from a user gesture; a missing/blocked context returns false, never throws. */
  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    const context = this.ensureContext();
    if (!context) return false;
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        return false;
      }
    }
    this.unlocked = true;
    return true;
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  async suspend(): Promise<void> {
    this.unlocked = false;
    const context = this.context;
    if (context && typeof context.suspend === 'function' && context.state === 'running') {
      try {
        await context.suspend();
      } catch {
        /* Already suspended or closed. */
      }
    }
  }

  /** Idempotent: every voice stops, every bus disconnects, the context closes. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const effect of this.effects) effect.handle.stop();
    this.effects.length = 0;
    for (const engine of this.engines.values()) engine.voice.stop();
    this.engines.clear();
    this.playedKeys.clear();
    const buses = this.buses;
    this.buses = null;
    const context = this.context;
    this.context = null;
    this.unlocked = false;
    if (buses) for (const id of BUS_IDS) buses[id].disconnect();
    if (context) {
      try {
        await context.close();
      } catch {
        /* Already closed. */
      }
    }
  }

  // --- mixing --------------------------------------------------------------------------------

  setVolume(bus: BusId, value: number): void {
    this.volumes[bus] = clamp01(value);
    const buses = this.buses;
    if (buses) buses[bus].gain.value = this.volumes[bus];
  }

  applyVolumes(volumes: Partial<Record<BusId, number>>): void {
    for (const id of BUS_IDS) {
      const value = volumes[id];
      if (typeof value === 'number') this.setVolume(id, value);
    }
  }

  setListener(position: Vec2): void {
    this.listenerPoint = position;
    for (const engine of this.engines.values()) {
      engine.score = this.effectScore(0.5 + Math.abs(engine.thrust), engine.position);
      engine.voice.update(engine.thrust, this.spatialLevel(1, engine.position));
    }
  }

  setSelfPilotId(id: Id | null): void {
    this.selfPilotId = id;
  }

  // --- one-shots -----------------------------------------------------------------------------

  play(request: PlayRequest): boolean {
    if (this.disposed || !this.unlocked || !this.context || !this.buses) return false;
    const recipe = CUE_RECIPES[request.cue];
    if (!recipe) return false;
    if (request.key !== undefined) {
      if (this.playedKeys.has(request.key)) return false;
      this.remember(request.key);
    }
    this.prune();
    const level = this.spatialLevel(recipe.gain * (request.gain ?? 1), recipe.spatial ? request.position ?? null : null);
    // Out of tactical range: silence beats distant noise, and the voice never gets allocated.
    if (level < MIN_AUDIBLE_GAIN) return false;
    if (this.effects.length >= this.maxEffectVoices) {
      const worstIndex = this.worstEffectIndex();
      if (worstIndex < 0) return false;
      const victim = this.effects[worstIndex];
      const incoming = this.effectScore(recipe.priority, request.position ?? null);
      if (this.effectScore(victim.priority, victim.position) >= incoming) return false;
      victim.handle.stop();
      this.effects.splice(worstIndex, 1);
    }
    const handle = playTones(this.context, this.buses[recipe.bus], recipe.tones, level);
    const endAt = this.context.currentTime + toneLength(recipe.tones) + 0.05;
    this.effects.push({ key: request.key ?? null, priority: recipe.priority, position: request.position ?? null, endAt, handle });
    return true;
  }

  /** Authority events dedupe by `eventId`, so a replayed burst never doubles its cue. */
  handleEvent(event: SessionEvent): void {
    const cue = cueForEvent(event, this.selfPilotId);
    if (!cue) return;
    const payload = event.payload as { position?: Vec2 };
    this.play({ cue, key: event.eventId, position: payload.position ?? null });
  }

  activeEffectVoices(): number {
    this.prune();
    return this.effects.length;
  }

  // --- continuous engines --------------------------------------------------------------------

  setEngine(id: Id, thrust: number, position: Vec2 | null): void {
    if (this.disposed || !this.unlocked || !this.context || !this.buses) return;
    const value = Math.min(1, Math.max(-1, thrust));
    const existing = this.engines.get(id);
    if (existing) {
      existing.thrust = value;
      existing.position = position;
      existing.score = this.effectScore(0.5 + Math.abs(value), position);
      existing.voice.update(value, this.spatialLevel(1, position));
      return;
    }
    if (this.engines.size >= this.maxEngines) {
      let worst: Id | null = null;
      let worstScore = Infinity;
      for (const [engineId, engine] of this.engines) {
        if (engine.score < worstScore) {
          worstScore = engine.score;
          worst = engineId;
        }
      }
      const incoming = this.effectScore(0.5 + Math.abs(value), position);
      if (worst === null || worstScore >= incoming) return;
      this.stopEngine(worst);
    }
    const voice = createEngineVoice(this.context, this.buses.effects);
    voice.update(value, this.spatialLevel(1, position));
    this.engines.set(id, { id, voice, thrust: value, position, score: this.effectScore(0.5 + Math.abs(value), position) });
  }

  stopEngine(id: Id): void {
    const engine = this.engines.get(id);
    if (!engine) return;
    engine.voice.stop();
    this.engines.delete(id);
  }

  activeEngines(): number {
    return this.engines.size;
  }

  // --- internals -----------------------------------------------------------------------------

  private ensureContext(): AudioContextLike | null {
    if (this.disposed) return null;
    if (this.context && this.buses) return this.context;
    let context: AudioContextLike | null = null;
    try {
      context = this.factory();
    } catch {
      context = null;
    }
    if (!context) return null;
    const master = context.createGain();
    master.gain.value = this.volumes.master;
    master.connect(context.destination);
    const buses: Record<BusId, GainLike> = { master } as Record<BusId, GainLike>;
    for (const id of ['music', 'effects', 'ui', 'voice'] as const) {
      const gain = context.createGain();
      gain.gain.value = this.volumes[id];
      gain.connect(master);
      buses[id] = gain;
    }
    this.context = context;
    this.buses = buses;
    return context;
  }

  private remember(key: string): void {
    this.playedKeys.add(key);
    while (this.playedKeys.size > MAX_PLAYED_KEYS) {
      const oldest = this.playedKeys.values().next().value;
      if (oldest === undefined) break;
      this.playedKeys.delete(oldest);
    }
  }

  private prune(): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      if (this.effects[index].endAt <= now) {
        this.effects[index].handle.stop();
        this.effects.splice(index, 1);
      }
    }
  }

  private effectScore(priority: number, position: Vec2 | null): number {
    const distance = position ? Math.hypot(position.x - this.listenerPoint.x, position.y - this.listenerPoint.y) : 0;
    return priority * 1_000_000 + Math.max(0, AUDIBLE_RANGE_M - distance);
  }

  private spatialLevel(gain: number, position: Vec2 | null): number {
    if (!position) return gain;
    const distance = Math.hypot(position.x - this.listenerPoint.x, position.y - this.listenerPoint.y);
    return gain * Math.max(0, 1 - distance / AUDIBLE_RANGE_M);
  }

  private worstEffectIndex(): number {
    let worst = -1;
    let worstScore = Infinity;
    for (let index = 0; index < this.effects.length; index += 1) {
      const score = this.effectScore(this.effects[index].priority, this.effects[index].position);
      if (score < worstScore) {
        worstScore = score;
        worst = index;
      }
    }
    return worst;
  }
}

export type { AudioContextLike, AudioNodeLike };
