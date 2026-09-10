/**
 * Narrow structural WebAudio surface plus the original synth voices (Plan A5). The legacy
 * `src/audio.ts` drone is a sawtooth through a 190 Hz lowpass whose pitch follows thrust; that
 * recipe lives here so the mixer can inject a test context, run several engines and tear every
 * oscillator down on dispose. Nothing in this file touches a global or creates a context.
 */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface FilterLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
}

export interface OscillatorLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  createBiquadFilter(): FilterLike;
  resume(): Promise<void>;
  suspend?(): Promise<void>;
  close(): Promise<void>;
}

/** The real AudioContext satisfies this structurally; the `unknown` casts only bridge lib types. */
export function defaultContextFactory(): AudioContextLike | null {
  const globals = globalThis as {
    AudioContext?: new () => unknown;
    webkitAudioContext?: new () => unknown;
  };
  const Ctor = globals.AudioContext ?? globals.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor() as AudioContextLike;
  } catch {
    return null;
  }
}

export interface EngineVoice {
  update(thrust: number, level: number): void;
  stop(): void;
}

/** One continuous drive: oscillator -> lowpass -> gain, matching the legacy synth's character. */
export function createEngineVoice(context: AudioContextLike, destination: AudioNodeLike): EngineVoice {
  const gain = context.createGain();
  gain.gain.value = 0;
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 190;
  const oscillator = context.createOscillator();
  oscillator.type = 'sawtooth';
  oscillator.frequency.value = 42;
  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  oscillator.start();
  return {
    update(thrust, level) {
      const target = thrust < 0 ? 0 : thrust;
      gain.gain.setTargetAtTime(level * (0.012 + target * 0.028), context.currentTime, 0.15);
      oscillator.frequency.setTargetAtTime(40 + target * 27, context.currentTime, 0.15);
    },
    stop() {
      oscillator.onended = null;
      try {
        oscillator.stop();
      } catch {
        /* Already stopped. */
      }
      oscillator.disconnect();
      filter.disconnect();
      gain.disconnect();
    },
  };
}

export interface ToneStep {
  readonly freq: number;
  readonly to?: number;
  readonly at: number;
  readonly duration: number;
  readonly gain: number;
  readonly type: string;
}

export interface OneShotVoice {
  stop(): void;
}

/** Enveloped tone stack for one cue; every oscillator stops itself at `at + duration`. */
export function playTones(
  context: AudioContextLike,
  destination: AudioNodeLike,
  tones: readonly ToneStep[],
  level: number,
): OneShotVoice {
  const out = context.createGain();
  out.gain.value = level;
  out.connect(destination);
  const oscillators: OscillatorLike[] = [];
  for (const tone of tones) {
    const start = context.currentTime + tone.at;
    const end = start + tone.duration;
    const oscillator = context.createOscillator();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(Math.max(1, tone.freq), start);
    if (tone.to !== undefined) oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, tone.to), end);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(tone.gain, start + Math.min(0.02, tone.duration * 0.25));
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(envelope);
    envelope.connect(out);
    oscillator.start(start);
    oscillator.stop(end);
    oscillators.push(oscillator);
  }
  return {
    stop() {
      for (const oscillator of oscillators) {
        oscillator.onended = null;
        try {
          oscillator.stop(context.currentTime);
        } catch {
          /* Already stopped by its schedule. */
        }
        oscillator.disconnect();
      }
      out.disconnect();
    },
  };
}

export function toneLength(tones: readonly ToneStep[]): number {
  let end = 0;
  for (const tone of tones) end = Math.max(end, tone.at + tone.duration);
  return end;
}
