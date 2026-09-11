import { CORES, PARTS, partFits } from './parts';
import type { Build } from './build';
import { CONTRACTS } from './contracts';
import { clamp } from './physics';
import type { ShipClass } from './physics';

const KEY = 'drift-profile-v1';
const LEGACY_BEST = 'drift-best-time';
const LEGACY_CALLSIGN = 'drift-callsign';

export type Profile = {
  v: 1;
  credits: number;
  owned: string[];
  builds: Build[];
  activeShip: { kind: 'stock'; id: ShipClass } | { kind: 'build'; id: string };
  completed: string[];
  bestTimes: Record<string, number>;
  callsign: string;
};

export const STARTING_CREDITS = 6000;
const STARTING_PARTS = ['eng-d9', 'tnk-m', 'wpn-ac20', 'rcs-pod', 'arm-tile'];
/** Contract ids a profile may claim. Phase 4 widens this list with the contract board. */
const CONTRACT_IDS = CONTRACTS.map(contract => contract.id);
/** The first contract shipped with an en-dash id; profiles written then still count. */
const LEGACY_IDS: Record<string, string> = { 'SR–084': 'SR-084' };
const STOCK_CLASSES: ShipClass[] = ['kestrel', 'mule', 'needle'];

export function fresh(): Profile {
  return {
    v: 1, credits: STARTING_CREDITS, owned: [...STARTING_PARTS], builds: [],
    activeShip: { kind: 'stock', id: 'kestrel' }, completed: [], bestTimes: {}, callsign: 'Rook',
  };
}

/** A build survives load only if its core exists and every filled slot names a real hardpoint and part. */
export function validBuild(value: unknown): value is Build {
  if (!value || typeof value !== 'object') return false;
  const build = value as Build;
  const core = CORES[build.core];
  if (!core || typeof build.id !== 'string' || typeof build.name !== 'string') return false;
  if (!build.slots || typeof build.slots !== 'object') return false;
  for (const [slot, part] of Object.entries(build.slots)) {
    const hardpoint = core.hardpoints.find(entry => entry.id === slot);
    if (!hardpoint) return false;
    if (part === null) continue;
    if (typeof part !== 'string' || !(part in PARTS) || !partFits(PARTS[part], hardpoint)) return false;
  }
  return true;
}

function normalizeId(id: unknown): string { return typeof id === 'string' ? LEGACY_IDS[id] ?? id : ''; }

function validActive(value: unknown, profile: Profile): boolean {
  if (!value || typeof value !== 'object') return false;
  const active = value as Profile['activeShip'];
  if (active.kind === 'stock') return STOCK_CLASSES.includes(active.id);
  if (active.kind === 'build') return profile.builds.some(build => build.id === active.id);
  return false;
}

export function load(): Profile {
  let stored: string | null = null;
  try { stored = localStorage.getItem(KEY); } catch { return fresh(); }
  if (stored === null) {
    const profile = fresh();
    let migrated = false;
    try {
      const best = Number(localStorage.getItem(LEGACY_BEST));
      if (Number.isFinite(best) && best > 0) { profile.bestTimes[CONTRACTS[0].id] = best; migrated = true; }
      const callsign = localStorage.getItem(LEGACY_CALLSIGN);
      if (callsign) { profile.callsign = callsign.slice(0, 14); migrated = true; }
      if (migrated) {
        localStorage.removeItem(LEGACY_BEST);
        localStorage.removeItem(LEGACY_CALLSIGN);
      }
    } catch { /* Storage is optional, as everywhere here. */ }
    save(profile);
    return profile;
  }
  try {
    const raw = JSON.parse(stored);
    if (!raw || raw.v !== 1) return fresh();
    const profile = fresh();
    // Take each field only if it is the right shape; anything else falls back to the fresh default.
    if (Number.isFinite(raw.credits)) profile.credits = clamp(Math.floor(raw.credits), 0, 1e9);
    if (Array.isArray(raw.owned)) profile.owned = raw.owned.filter((id: unknown) => typeof id === 'string' && (id in PARTS || id in CORES));
    if (Array.isArray(raw.builds)) profile.builds = raw.builds.filter(validBuild).slice(0, 24);
    if (Array.isArray(raw.completed)) profile.completed = raw.completed.map(normalizeId).filter((id: unknown) => typeof id === 'string' && CONTRACT_IDS.includes(id));
    if (typeof raw.callsign === 'string') profile.callsign = raw.callsign.slice(0, 14);
    if (raw.bestTimes && typeof raw.bestTimes === 'object') {
      for (const [id, time] of Object.entries(raw.bestTimes)) {
        const key = normalizeId(id);
        if (CONTRACT_IDS.includes(key) && Number.isFinite(time) && Number(time) > 0) profile.bestTimes[key] = Number(time);
      }
    }
    if (validActive(raw.activeShip, profile)) profile.activeShip = raw.activeShip;
    return profile;
  } catch { return fresh(); }
}

export function save(profile: Profile): void {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* Storage is optional, as elsewhere. */ }
}

/** Credits leave the balance only through here, so no purchase can go negative. */
export function spend(profile: Profile, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0 || profile.credits < amount) return false;
  profile.credits -= amount;
  save(profile);
  return true;
}

export function earn(profile: Profile, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  profile.credits = clamp(profile.credits + amount, 0, 1e9);
  save(profile);
}

export function own(profile: Profile, id: string): boolean {
  return profile.owned.includes(id);
}

/** Records the best time for a contract, returning the previous best so the debrief can compare. */
export function recordTime(profile: Profile, contract: string, seconds: number): number {
  const previous = profile.bestTimes[contract] ?? 0;
  if (!(seconds > 0)) return previous;
  if (previous === 0 || seconds < previous) { profile.bestTimes[contract] = seconds; save(profile); return previous; }
  return previous;
}

export function bestTime(profile: Profile, contract: string): number {
  return profile.bestTimes[contract] ?? 0;
}
