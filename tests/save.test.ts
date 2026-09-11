import { beforeEach, describe, expect, test } from 'bun:test';
import {
  STARTING_CREDITS, bestTime, earn, fresh, load, own, recordTime, save, spend, validBuild,
} from '../src/save';
import { CONTRACTS } from '../src/contracts';

const KEY = 'drift-profile-v1';

/** Minimal in-memory stand-in for the browser's localStorage. Never touches real storage. */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

function seed(value: unknown): void {
  localStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('fresh profile', () => {
  test('starts with 6000 credits and the five starting parts', () => {
    const profile = fresh();
    expect(STARTING_CREDITS).toBe(6000);
    expect(profile.credits).toBe(6000);
    expect(profile.owned.slice().sort()).toEqual(['arm-tile', 'eng-d9', 'rcs-pod', 'tnk-m', 'wpn-ac20']);
    expect(profile.completed).toEqual([]);
    expect(profile.builds).toEqual([]);
    expect(profile.activeShip).toEqual({ kind: 'stock', id: 'kestrel' });
    expect(profile.v).toBe(1);
  });

  test('load() with empty storage returns and persists a usable profile', () => {
    const profile = load();
    expect(profile.credits).toBe(6000);
    expect(profile.owned).toHaveLength(5);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(load().credits).toBe(6000);
  });
});

describe('load() validation', () => {
  test('corrupt JSON falls back to a fresh profile instead of throwing', () => {
    seed('{not json at all');
    const profile = load();
    expect(profile.credits).toBe(6000);
    expect(profile.owned).toHaveLength(5);
  });

  test('a version other than 1 is discarded', () => {
    seed({ v: 2, credits: 999999, owned: ['eng-d9'] });
    expect(load().credits).toBe(6000);
    expect(load().owned).toHaveLength(5);
  });

  test('wrong-typed fields are dropped or clamped', () => {
    seed({
      v: 1,
      credits: -50,
      owned: ['eng-d9', 'bogus-part', 42],
      builds: [{ id: 'bad' }],
      completed: ['SR-084', 'ZZ-999', 7],
      bestTimes: { 'SR-084': 12.5, 'ZZ-999': 5, bad: 'x' },
      callsign: 42,
      activeShip: { kind: 'stock', id: 'frigate' },
    });
    const profile = load();
    expect(profile.credits).toBe(0);
    expect(profile.owned).toEqual(['eng-d9']);
    expect(profile.builds).toEqual([]);
    expect(profile.completed).toEqual(['SR-084']);
    expect(profile.bestTimes).toEqual({ 'SR-084': 12.5 });
    expect(profile.callsign).toBe('Rook');
    expect(profile.activeShip).toEqual({ kind: 'stock', id: 'kestrel' });
  });

  test('credits are clamped to the top of the safe range', () => {
    seed({ v: 1, credits: 5e9, completed: [] });
    expect(load().credits).toBe(1e9);
  });

  test('legacy en-dash SR-084 ids are normalised to the real contract id', () => {
    seed({
      v: 1, credits: 100,
      completed: ['SR–084', 'ZZ-999'],
      bestTimes: { 'SR–084': 42 },
      activeShip: { kind: 'stock', id: 'kestrel' },
    });
    const profile = load();
    expect(profile.completed).toEqual(['SR-084']);
    expect(profile.bestTimes['SR-084']).toBe(42);
  });

  test('every shipped contract id survives a round trip', () => {
    const ids = CONTRACTS.map(contract => contract.id);
    const profile = fresh();
    profile.completed = [...ids, 'ZZ-999'];
    profile.bestTimes = Object.fromEntries(ids.map((id, index) => [id, index + 1]));
    save(profile);

    const loaded = load();
    expect(loaded.completed.slice().sort()).toEqual([...ids].sort());
    expect(Object.keys(loaded.bestTimes).slice().sort()).toEqual([...ids].sort());
  });
});

describe('validBuild', () => {
  test('accepts a build whose core, slots and parts exist', () => {
    expect(validBuild({ id: 'b1', name: 'Runner', core: 'spar', slots: { 'port-engine-1': 'eng-d4' } })).toBe(true);
    expect(validBuild({ id: 'b2', name: 'Empty', core: 'spar', slots: {} })).toBe(true);
  });

  test('rejects unknown cores, slots and parts', () => {
    expect(validBuild(null)).toBe(false);
    expect(validBuild({ id: 'b', name: 'n', core: 'nope', slots: {} })).toBe(false);
    expect(validBuild({ id: 'b', name: 'n', core: 'spar', slots: { 'not-a-hardpoint': 'eng-d4' } })).toBe(false);
    expect(validBuild({ id: 'b', name: 'n', core: 'spar', slots: { 'port-engine-1': 'not-a-part' } })).toBe(false);
  });
});

describe('economy', () => {
  test('spend never drives the balance negative', () => {
    const profile = fresh();
    profile.credits = 100;
    expect(spend(profile, 150)).toBe(false);
    expect(profile.credits).toBe(100);
    expect(spend(profile, -5)).toBe(false);
    expect(profile.credits).toBe(100);
    expect(spend(profile, 100)).toBe(true);
    expect(profile.credits).toBe(0);
    expect(spend(profile, 1)).toBe(false);
    expect(profile.credits).toBe(0);
  });

  test('earn adds credits and ignores nonsense', () => {
    const profile = fresh();
    profile.credits = 0;
    earn(profile, 500);
    expect(profile.credits).toBe(500);
    earn(profile, -20);
    expect(profile.credits).toBe(500);
    earn(profile, Number.NaN);
    expect(profile.credits).toBe(500);
    earn(profile, 1e12);
    expect(profile.credits).toBe(1e9);
  });

  test('own reports the parts a profile carries', () => {
    const profile = fresh();
    expect(own(profile, 'eng-d9')).toBe(true);
    expect(own(profile, 'eng-k12')).toBe(false);
  });

  test('recordTime keeps the better time and returns the previous one', () => {
    const profile = fresh();
    expect(recordTime(profile, 'SR-084', 100)).toBe(0);
    expect(bestTime(profile, 'SR-084')).toBe(100);
    expect(recordTime(profile, 'SR-084', 120)).toBe(100);
    expect(bestTime(profile, 'SR-084')).toBe(100);
    expect(recordTime(profile, 'SR-084', 80)).toBe(100);
    expect(bestTime(profile, 'SR-084')).toBe(80);
    expect(recordTime(profile, 'SR-084', 0)).toBe(80);
    expect(bestTime(profile, 'SR-084')).toBe(80);
    expect(bestTime(profile, 'MN-210')).toBe(0);
  });
});
