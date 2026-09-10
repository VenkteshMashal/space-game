import { describe, expect, test } from 'bun:test';
import {
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsStore,
  defaultSettings,
  loadSettings,
  migrate,
  resetCategory,
  saveSettings,
} from '../src/settings.ts';
import type { Settings, StorageLike } from '../src/settings.ts';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.data.set(key, value);
  }
}

const throwingStorage: StorageLike = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
};

describe('settings migration', () => {
  test('an empty store yields the defaults, versioned', () => {
    const settings = loadSettings(new MemoryStorage());
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings).toEqual(defaultSettings());
  });

  test('corrupt input never throws and falls back to safe defaults', () => {
    const garbage: unknown[] = [null, undefined, 42, 'settings', [1, 2, 3], { version: 'x' }, { flight: [] }, Symbol];
    for (const raw of garbage) {
      expect(() => migrate(raw)).not.toThrow();
      const settings = migrate(raw);
      expect(settings.version).toBe(SETTINGS_VERSION);
      expect(settings.audio.master).toBeGreaterThanOrEqual(0);
      expect(settings.audio.master).toBeLessThanOrEqual(1);
      expect(settings.controls.bindings.thrust.length).toBeGreaterThan(0);
    }
  });

  test('a partial object keeps what is valid and defaults the rest', () => {
    const settings = migrate({ audio: { master: 0.2 }, flight: { zoom: 1.5 } });
    expect(settings.audio.master).toBe(0.2);
    expect(settings.flight.zoom).toBe(1.5);
    expect(settings.audio.music).toBe(defaultSettings().audio.music);
    expect(settings.graphics.quality).toBe('auto');
  });

  test('the legacy flat v0 shape maps onto the current categories', () => {
    const settings = migrate({ version: 0, volume: 0.3, muted: false, quality: 'high', invertY: true });
    expect(settings.version).toBe(1);
    expect(settings.audio.master).toBe(0.3);
    expect(settings.graphics.quality).toBe('high');
    expect(settings.flight.invertAim).toBe(true);
  });

  test('an unversioned document is treated as v0 and an explicit mute wins over volume', () => {
    expect(migrate({ volume: 0.4 }).audio.master).toBe(0.4);
    expect(migrate({ version: 0, volume: 0.4, muted: true }).audio.master).toBe(0);
  });

  test('out-of-range numbers clamp instead of leaking into the shell', () => {
    const settings = migrate({
      audio: { master: 9, music: -3, effects: Number.NaN, ui: Number.POSITIVE_INFINITY },
      flight: { zoom: 99, lookAhead: -5 },
      accessibility: { screenShake: 7, flash: -1, uiScale: 12 },
      graphics: { maxDevicePixelRatio: 9 },
      controls: { gamepadDeadzone: 0.9, sensitivity: 0 },
    });
    expect(settings.audio.master).toBe(1);
    expect(settings.audio.music).toBe(0);
    expect(settings.audio.effects).toBeCloseTo(0.8, 5);
    expect(settings.audio.ui).toBeCloseTo(0.7, 5);
    expect(settings.flight.zoom).toBe(2);
    expect(settings.flight.lookAhead).toBe(0);
    expect(settings.accessibility.screenShake).toBe(1);
    expect(settings.accessibility.flash).toBe(0);
    expect(settings.accessibility.uiScale).toBe(2);
    expect(settings.graphics.maxDevicePixelRatio).toBe(2);
    expect(settings.controls.gamepadDeadzone).toBe(0.5);
    expect(settings.controls.sensitivity).toBe(0.2);
  });

  test('motion, flash and shake can be reduced all the way to zero', () => {
    const settings = migrate({ accessibility: { screenShake: 0, flash: 0, reducedMotion: true } });
    expect(settings.accessibility.screenShake).toBe(0);
    expect(settings.accessibility.flash).toBe(0);
    expect(settings.accessibility.reducedMotion).toBe(true);
  });

  test('unknown quality and enums fall back rather than propagating', () => {
    expect(migrate({ graphics: { quality: 'ultra' } }).graphics.quality).toBe('auto');
    expect(migrate({ graphics: { quality: 'low' } }).graphics.quality).toBe('low');
    expect(migrate({ flight: { aimMode: 'psychic' } }).flight.aimMode).toBe('pointer');
    expect(migrate({ controls: { touchHandedness: 'both' } }).controls.touchHandedness).toBe('right');
  });

  test('a newer version is clamped, not trusted or thrown away', () => {
    const settings = migrate({ version: 99, audio: { master: 5 }, flight: { zoom: 1.25 } });
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.audio.master).toBe(1);
    expect(settings.flight.zoom).toBe(1.25);
  });

  test('recent hosts stay bounded, unique and textual', () => {
    const settings = migrate({ storage: { recentHosts: ['a:1', 'a:1', 7, null, 'b:2', 'c:3', 'd:4', 'e:5', 'f:6'] } });
    expect(settings.storage.recentHosts).toEqual(['a:1', 'b:2', 'c:3', 'd:4', 'e:5']);
  });

  test('a conflicting binding inside settings repairs to the safe default', () => {
    const settings = migrate({ controls: { bindings: { thrust: ['KeyS'], map: ['Tab'], brake: ['KeyX', 'KeyX'] } } });
    // KeyS already belongs to reverse, so thrust keeps its default; Tab is reserved.
    expect(settings.controls.bindings.thrust).toEqual(['KeyW']);
    expect(settings.controls.bindings.map).toEqual(['KeyM']);
    expect(settings.controls.bindings.brake).toEqual(['KeyX']);
  });
});

describe('settings persistence', () => {
  test('save then load round-trips through one key', () => {
    const storage = new MemoryStorage();
    const changed: Settings = migrate({ audio: { master: 0.11 } });
    saveSettings(changed, storage);
    expect(storage.writes).toBe(1);
    expect(storage.data.has(SETTINGS_KEY)).toBe(true);
    expect(loadSettings(storage).audio.master).toBeCloseTo(0.11, 5);
  });

  test('a corrupt stored string loads defaults without throwing', () => {
    const storage = new MemoryStorage();
    storage.data.set(SETTINGS_KEY, '{ not json ');
    expect(() => loadSettings(storage)).not.toThrow();
    expect(loadSettings(storage)).toEqual(defaultSettings());
  });

  test('storage that throws is survivable in both directions', () => {
    expect(loadSettings(throwingStorage)).toEqual(defaultSettings());
    expect(() => saveSettings(defaultSettings(), throwingStorage)).not.toThrow();
  });

  test('saving clamps out-of-range values written by a caller', () => {
    const storage = new MemoryStorage();
    const stored = saveSettings({ ...defaultSettings(), audio: { ...defaultSettings().audio, master: 4 } }, storage);
    expect(stored.audio.master).toBe(1);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!).audio.master).toBe(1);
  });
});

describe('settings reset', () => {
  test('resetCategory restores one category and leaves the others alone', () => {
    const current = migrate({
      audio: { master: 0.1, music: 0.1 },
      accessibility: { screenShake: 0 },
      flight: { zoom: 1.75 },
    });
    const afterAudio = resetCategory(current, 'audio');
    expect(afterAudio.audio).toEqual(defaultSettings().audio);
    expect(afterAudio.accessibility.screenShake).toBe(0);
    expect(afterAudio.flight.zoom).toBe(1.75);

    const afterAccessibility = resetCategory(afterAudio, 'accessibility');
    expect(afterAccessibility.accessibility).toEqual(defaultSettings().accessibility);
    expect(afterAccessibility.audio).toEqual(defaultSettings().audio);
  });

  test('every category is resettable', () => {
    const categories = ['flight', 'controls', 'audio', 'graphics', 'accessibility', 'storage'] as const;
    const current = migrate({ audio: { master: 0 }, flight: { zoom: 1.9 }, storage: { keepDrafts: false } });
    for (const category of categories) {
      const reset = resetCategory(current, category);
      expect(reset[category]).toEqual(defaultSettings()[category]);
    }
  });
});

describe('SettingsStore', () => {
  test('patch, persist and notify', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore(storage);
    const seen: Settings[] = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings));
    const updated = store.set({ audio: { master: 0.25 } });
    expect(updated.audio.master).toBe(0.25);
    expect(seen.length).toBe(1);
    expect(loadSettings(storage).audio.master).toBe(0.25);
    unsubscribe();
    store.set({ audio: { master: 0.5 } });
    expect(seen.length).toBe(1);
  });

  test('reset through the store restores only the named category', () => {
    const store = new SettingsStore(new MemoryStorage());
    store.set({ audio: { master: 0.05 }, flight: { zoom: 1.5 } });
    const reset = store.reset('audio');
    expect(reset.audio.master).toBe(defaultSettings().audio.master);
    expect(reset.flight.zoom).toBe(1.5);
  });
});
