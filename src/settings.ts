/**
 * Versioned local settings (Plan A5). One key, safe-default migration, one validated range per
 * value. Every read path (`loadSettings`, `migrate`) returns a complete `Settings` and never
 * throws: corrupt JSON, a partial object, an unknown category or a newer version all fall back to
 * bounded defaults rather than breaking the shell. Bindings live in the controls category so a
 * remap persists with the rest of the pilot's setup.
 */

import { defaultBindings, sanitizeBindings, type Bindings } from './input/bindings.ts';

export const SETTINGS_VERSION = 1;
export const SETTINGS_KEY = 'drift.settings';

export type SettingsCategory = 'flight' | 'controls' | 'audio' | 'graphics' | 'accessibility' | 'storage';
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  'flight', 'controls', 'audio', 'graphics', 'accessibility', 'storage',
];

export type Quality = 'auto' | 'low' | 'medium' | 'high';
export type AimMode = 'pointer' | 'fixed' | 'target';
export type Handedness = 'right' | 'left';
export type TouchAim = 'pad' | 'target';
export type AudioBus = 'master' | 'music' | 'effects' | 'ui' | 'voice';

export interface FlightSettings {
  /** How the ship is pointed: mouse/pointer, keyboard-only fixed gun, or lock-to-target. */
  readonly aimMode: AimMode;
  readonly invertAim: boolean;
  /** Camera velocity look-ahead, 0..1; capped in presentation so the local hull stays visible. */
  readonly lookAhead: number;
  readonly zoom: number;
  readonly assistDefault: boolean;
}

export interface ControlSettings {
  readonly bindings: Bindings;
  readonly gamepad: boolean;
  readonly gamepadDeadzone: number;
  readonly sensitivity: number;
  readonly touchHandedness: Handedness;
  readonly touchAim: TouchAim;
}

export interface AudioSettings extends Record<AudioBus, number> {
  readonly master: number;
  readonly music: number;
  readonly effects: number;
  readonly ui: number;
  readonly voice: number;
}

export interface GraphicsSettings {
  readonly quality: Quality;
  readonly dynamicResolution: boolean;
  readonly bloom: boolean;
  readonly maxDevicePixelRatio: number;
}

export interface AccessibilitySettings {
  readonly reducedMotion: boolean;
  /** 0 disables screen shake entirely; 1 is the authored maximum. */
  readonly screenShake: number;
  /** 0 disables flashes entirely; UI never flashes faster than three times per second regardless. */
  readonly flash: number;
  readonly uiScale: number;
  readonly largeControls: boolean;
  readonly colorblindPatterns: boolean;
  readonly highContrast: boolean;
  readonly subtitles: boolean;
}

export interface StorageSettings {
  /** Normalized host origins, most recent first, bounded. */
  readonly recentHosts: readonly string[];
  readonly keepDrafts: boolean;
  readonly exportReminder: boolean;
}

export interface Settings {
  readonly version: number;
  readonly flight: FlightSettings;
  readonly controls: ControlSettings;
  readonly audio: AudioSettings;
  readonly graphics: GraphicsSettings;
  readonly accessibility: AccessibilitySettings;
  readonly storage: StorageSettings;
}

export type SettingsPatch = { readonly [K in SettingsCategory]?: Partial<Settings[K]> };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MAX_RECENT_HOSTS = 5;

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RawRecord) : {};
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function hostList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim().slice(0, 128);
    if (host.length === 0 || out.includes(host)) continue;
    out.push(host);
    if (out.length >= MAX_RECENT_HOSTS) break;
  }
  return out;
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    flight: { aimMode: 'pointer', invertAim: false, lookAhead: 0.25, zoom: 1, assistDefault: true },
    controls: {
      bindings: defaultBindings(),
      gamepad: true,
      gamepadDeadzone: 0.18,
      sensitivity: 1,
      touchHandedness: 'right',
      touchAim: 'pad',
    },
    audio: { master: 0.8, music: 0.5, effects: 0.8, ui: 0.7, voice: 0.8 },
    graphics: { quality: 'auto', dynamicResolution: true, bloom: false, maxDevicePixelRatio: 1.5 },
    accessibility: {
      reducedMotion: false,
      screenShake: 0.35,
      flash: 0.5,
      uiScale: 1,
      largeControls: false,
      colorblindPatterns: false,
      highContrast: false,
      subtitles: true,
    },
    storage: { recentHosts: [], keepDrafts: true, exportReminder: true },
  };
}

/**
 * Pre-release v0 was flat: `volume`, `muted`, `quality` and `invertY` at the root. Map what is
 * unambiguous and let the sanitizer default the rest.
 */
function fromV0(raw: RawRecord): RawRecord {
  const audio = record(raw.audio);
  if (audio.master === undefined) {
    if (raw.muted === true) audio.master = 0;
    else if (typeof raw.volume === 'number') audio.master = raw.volume;
  }
  const graphics = record(raw.graphics);
  if (graphics.quality === undefined) graphics.quality = raw.quality;
  const flight = record(raw.flight);
  if (flight.invertAim === undefined) flight.invertAim = raw.invertY;
  return { ...raw, version: 1, audio, graphics, flight };
}

function sanitize(raw: RawRecord): Settings {
  const flight = record(raw.flight);
  const controls = record(raw.controls);
  const audio = record(raw.audio);
  const graphics = record(raw.graphics);
  const accessibility = record(raw.accessibility);
  const storage = record(raw.storage);

  return {
    version: SETTINGS_VERSION,
    flight: {
      aimMode: oneOf(flight.aimMode, ['pointer', 'fixed', 'target'] as const, 'pointer'),
      invertAim: bool(flight.invertAim, false),
      lookAhead: num(flight.lookAhead, 0.25, 0, 1),
      zoom: num(flight.zoom, 1, 0.5, 2),
      assistDefault: bool(flight.assistDefault, true),
    },
    controls: {
      bindings: sanitizeBindings(controls.bindings),
      gamepad: bool(controls.gamepad, true),
      gamepadDeadzone: num(controls.gamepadDeadzone, 0.18, 0.05, 0.5),
      sensitivity: num(controls.sensitivity, 1, 0.2, 3),
      touchHandedness: oneOf(controls.touchHandedness, ['right', 'left'] as const, 'right'),
      touchAim: oneOf(controls.touchAim, ['pad', 'target'] as const, 'pad'),
    },
    audio: {
      master: num(audio.master, 0.8, 0, 1),
      music: num(audio.music, 0.5, 0, 1),
      effects: num(audio.effects, 0.8, 0, 1),
      ui: num(audio.ui, 0.7, 0, 1),
      voice: num(audio.voice, 0.8, 0, 1),
    },
    graphics: {
      quality: oneOf(graphics.quality, ['auto', 'low', 'medium', 'high'] as const, 'auto'),
      dynamicResolution: bool(graphics.dynamicResolution, true),
      bloom: bool(graphics.bloom, false),
      maxDevicePixelRatio: num(graphics.maxDevicePixelRatio, 1.5, 1, 2),
    },
    accessibility: {
      reducedMotion: bool(accessibility.reducedMotion, false),
      screenShake: num(accessibility.screenShake, 0.35, 0, 1),
      flash: num(accessibility.flash, 0.5, 0, 1),
      uiScale: num(accessibility.uiScale, 1, 1, 2),
      largeControls: bool(accessibility.largeControls, false),
      colorblindPatterns: bool(accessibility.colorblindPatterns, false),
      highContrast: bool(accessibility.highContrast, false),
      subtitles: bool(accessibility.subtitles, true),
    },
    storage: {
      recentHosts: hostList(storage.recentHosts),
      keepDrafts: bool(storage.keepDrafts, true),
      exportReminder: bool(storage.exportReminder, true),
    },
  };
}

/**
 * Accept anything and return usable settings. A version newer than ours cannot be trusted for
 * semantics, but its known fields are still range-clamped, so the worst case is a defaulted value.
 */
export function migrate(raw: unknown): Settings {
  try {
    let draft = record(raw);
    const version = typeof draft.version === 'number' && Number.isFinite(draft.version) ? Math.floor(draft.version) : 0;
    if (version < 1) draft = fromV0(draft);
    return freezeDeep(sanitize(draft));
  } catch {
    return freezeDeep(defaultSettings());
  }
}

function defaultStorage(): StorageLike {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') return storage;
  } catch {
    /* Access can throw in privacy modes; settings then live for the session only. */
  }
  return { getItem: () => null, setItem: () => undefined };
}

export function loadSettings(storage: StorageLike = defaultStorage()): Settings {
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (!text) return freezeDeep(defaultSettings());
    return migrate(JSON.parse(text) as unknown);
  } catch {
    return freezeDeep(defaultSettings());
  }
}

export function saveSettings(settings: Settings, storage: StorageLike = defaultStorage()): Settings {
  const normalized = migrate(settings);
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    /* Quota or private mode: keep the normalized value in memory, surface nothing here. */
  }
  return normalized;
}

export function resetCategory(settings: Settings, category: SettingsCategory): Settings {
  return migrate({ ...settings, [category]: defaultSettings()[category] });
}

function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const merged: Record<string, unknown> = { ...current };
  for (const category of SETTINGS_CATEGORIES) {
    const change = patch[category];
    if (change) merged[category] = { ...current[category], ...change };
  }
  return migrate(merged);
}

/** Small reactive wrapper so the Settings/Controls pages can read, patch and reset one live copy. */
export class SettingsStore {
  private current: Settings;
  private readonly storage: StorageLike;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
    this.current = loadSettings(this.storage);
  }

  get(): Settings {
    return this.current;
  }

  subscribe(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(patch: SettingsPatch): Settings {
    this.current = saveSettings(applyPatch(this.current, patch), this.storage);
    this.emit();
    return this.current;
  }

  reset(category: SettingsCategory): Settings {
    this.current = saveSettings(resetCategory(this.current, category), this.storage);
    this.emit();
    return this.current;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.current);
  }
}
