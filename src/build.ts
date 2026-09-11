import * as THREE from 'three';
import { CORES, PARTS, partFits } from './parts';
import type { PartCategory } from './parts';
import type { ShipSpec } from './physics';

export type Build = { id: string; name: string; core: string; slots: Record<string, string | null> };

export type DerivedStats = {
  name: string; dryMass: number; fuel: number; thrust: number; hull: number;
  torque: number; cargo: number; cooling: number;
  mounts: { weapon: string; lx: number; ly: number }[];
  scanScale: number; collectScale: number;
  accel: number; gees: number; valid: boolean; problems: string[]; warnings: string[]; cost: number;
};

export type PresetId = 'balanced' | 'mining' | 'combat';
type PresetPlacement = { part: string; category: PartCategory; quantity: number };
export type BuildPreset = {
  id: PresetId; name: string; blurb: string; core: string; placements: PresetPlacement[];
};

/** Starter recipes describe intent; presetBuild places each part only on a compatible socket. */
export const BUILD_PRESETS: readonly BuildPreset[] = [
  {
    id: 'balanced', name: 'Balanced', blurb: 'A dependable two engine frame for first sorties.', core: 'spar',
    placements: [
      { part: 'eng-d9', category: 'engine', quantity: 1 },
      { part: 'tnk-m', category: 'tank', quantity: 1 },
      { part: 'wpn-ac20', category: 'weapon', quantity: 1 },
      { part: 'rcs-pod', category: 'rcs', quantity: 1 },
    ],
  },
  {
    id: 'mining', name: 'Mining', blurb: 'Ore capacity and collection range for belt work.', core: 'truss',
    placements: [
      { part: 'eng-d9', category: 'engine', quantity: 1 },
      { part: 'tnk-m', category: 'tank', quantity: 1 },
      { part: 'crg-pod', category: 'cargo', quantity: 1 },
      { part: 'utl-coll', category: 'utility', quantity: 1 },
      { part: 'wpn-cutter', category: 'weapon', quantity: 1 },
      { part: 'rcs-pod', category: 'rcs', quantity: 1 },
    ],
  },
  {
    id: 'combat', name: 'Combat', blurb: 'Extra armor and breaker mounts for hot approaches.', core: 'truss',
    placements: [
      { part: 'eng-d9', category: 'engine', quantity: 1 },
      { part: 'tnk-m', category: 'tank', quantity: 1 },
      { part: 'wpn-ac70', category: 'weapon', quantity: 2 },
      { part: 'arm-tile', category: 'armor', quantity: 4 },
      { part: 'rcs-pod', category: 'rcs', quantity: 1 },
    ],
  },
];

/** Alias kept short for UI and external callers that want to enumerate starter recipes. */
export const PRESETS = BUILD_PRESETS;

export type PurchaseItem = { id: string; name: string; cost: number; kind: 'core' | 'part' };
export type PurchaseQuote = { items: PurchaseItem[]; total: number };

function presetInfo(id: PresetId): BuildPreset {
  return BUILD_PRESETS.find(preset => preset.id === id) ?? BUILD_PRESETS[0];
}

/** Create a new recipe without granting any of its core or parts. */
export function presetBuild(id: PresetId, buildId = `preset-${id}`, name = presetInfo(id).name): Build {
  const preset = presetInfo(id);
  const build = createBuild(preset.core, name, buildId);
  const occupied = new Set<string>();
  for (const placement of preset.placements) {
    const part = PARTS[placement.part];
    if (!part) continue;
    let placed = 0;
    const sockets = [...CORES[preset.core].hardpoints].sort((a, b) => {
      // Utility gear prefers the dedicated wing fitting. Cargo pods keep the cargo rail free
      // for actual hold capacity when a recipe asks for both systems.
      if (placement.category !== 'utility') return 0;
      const aWing = a.accepts.includes('utility') && a.accepts.includes('wing') ? 0 : 1;
      const bWing = b.accepts.includes('utility') && b.accepts.includes('wing') ? 0 : 1;
      return aWing - bWing;
    });
    for (const hardpoint of sockets) {
      if (placed >= placement.quantity || occupied.has(hardpoint.id) || !partFits(part, hardpoint)) continue;
      const mirror = hardpoint.mirrorOf;
      if (mirror && occupied.has(mirror)) continue;
      toggleSlot(build, hardpoint.id, part.id);
      occupied.add(hardpoint.id);
      if (mirror) occupied.add(mirror);
      placed++;
    }
  }
  return build;
}

function quoteForIds(ids: string[], owned: Iterable<string>): PurchaseQuote {
  const carried = new Set(owned);
  const seen = new Set<string>();
  const items: PurchaseItem[] = [];
  for (const id of ids) {
    if (seen.has(id) || carried.has(id)) continue;
    const core = CORES[id];
    const part = PARTS[id];
    if (!core && !part) continue;
    seen.add(id);
    items.push({ id, name: core?.name ?? part!.name, cost: core?.cost ?? part!.cost, kind: core ? 'core' : 'part' });
  }
  return { items, total: items.reduce((total, item) => total + item.cost, 0) };
}

/** The unique items still needed to make a saved build owned and launchable. */
export function purchaseQuoteForBuild(build: Build, owned: Iterable<string>): PurchaseQuote {
  const core = CORES[build.core];
  if (!core) return { items: [], total: 0 };
  const ids = [core.id];
  for (const hardpoint of core.hardpoints) {
    const part = PARTS[build.slots[hardpoint.id] ?? ''];
    if (part && partFits(part, hardpoint)) ids.push(part.id);
  }
  return quoteForIds(ids, owned);
}

export function purchaseQuoteForPreset(id: PresetId, owned: Iterable<string>): PurchaseQuote {
  return purchaseQuoteForBuild(presetBuild(id), owned);
}

/** A fresh build: the core and empty sockets. The caller installs the parts. */
export function createBuild(core: string, name: string, id: string): Build {
  return { id, name, core, slots: {} };
}

/** The one place every flight number comes from. Stock ships keep their own stat block. */
export function derive(build: Build): DerivedStats {
  const core = CORES[build.core];
  let dryMass = core.mass, fuel = 0, thrust = 0, hull = core.hull;
  let rawTorque = core.torque, cargo = 0, cooling = core.cooling, cost = core.cost;
  let scanScale = 1, collectScale = 1;
  const mounts: DerivedStats['mounts'] = [];

  for (const hardpoint of core.hardpoints) {
    const part = PARTS[build.slots[hardpoint.id] ?? ''];
    if (!part || !partFits(part, hardpoint)) continue;
    dryMass += part.mass; cost += part.cost;
    fuel += part.fuel ?? 0; thrust += part.thrust ?? 0; hull += part.hull ?? 0;
    rawTorque += part.torque ?? 0; cargo += part.cargo ?? 0; cooling += part.cooling ?? 0;
    if (part.weapon) mounts.push({ weapon: part.weapon, lx: hardpoint.x, ly: hardpoint.y });
    if (part.id === 'utl-scan') scanScale *= 0.5;
    if (part.id === 'utl-coll') collectScale *= 3;
  }

  // Angular acceleration falls as mass grows. Normalising against the truss core's 34 t keeps the
  // existing SHIPS torque values (0.82 - 2.05) as the readable scale a player already has a feel for.
  const torque = rawTorque * (34000 / Math.max(8000, dryMass));
  const wet = dryMass + fuel;
  const accel = thrust / wet;

  const problems: string[] = [];
  const warnings: string[] = [];
  const incompatible = new Set<string>();
  for (const hardpoint of core.hardpoints) {
    const installedId = build.slots[hardpoint.id];
    const part = installedId ? PARTS[installedId] : undefined;
    if (part && !partFits(part, hardpoint) && !incompatible.has(part.id)) {
      incompatible.add(part.id);
      problems.push(`${part.name} does not fit ${hardpoint.label}.`);
    }
  }
  if (thrust <= 0) problems.push('No engine. This will not move.');
  if (fuel <= 0) problems.push('No propellant tank.');
  if (accel < 2.2) problems.push('Under 0.22 g — too sluggish to hold station against a rock.');
  if (torque < 0.35) problems.push('Too little attitude authority. Add an RCS quad or shed mass.');
  if (hull < 40) problems.push('Structurally marginal. One collision ends the sortie.');
  if (cargo <= 0) warnings.push('No ore hold. Mining sorties cannot bring cargo home.');
  if (mounts.length <= 0) warnings.push('No weapon mount. Combat sorties will have no offensive systems.');
  if (scanScale === 1) warnings.push('No survey mast. Survey scans use standard timing.');
  if (cargo > 0 && collectScale === 1) warnings.push('No ore collector. Pickup range remains standard.');

  return {
    name: build.name, dryMass, fuel, thrust, hull, torque, cargo, cooling, mounts,
    scanScale, collectScale, accel, gees: accel / 9.81, valid: problems.length === 0, problems, warnings, cost,
  };
}

const CORE_LENGTH: Record<string, number> = { spar: 26, truss: 34, keel: 52 };

/** DerivedStats -> the sim's ShipSpec. Above the sim, stock ships and custom builds are interchangeable. */
export function buildSpec(build: Build): ShipSpec {
  const stats = derive(build);
  return {
    name: stats.name, role: 'Custom build',
    mass: stats.dryMass, thrust: stats.thrust, fuel: stats.fuel,
    torque: stats.torque, hull: stats.hull,
    length: CORE_LENGTH[build.core] ?? 34,
    cargo: stats.cargo, cooling: stats.cooling,
    scanScale: stats.scanScale, collectScale: stats.collectScale,
  };
}

export type BuiltShip = {
  group: THREE.Group;
  flames: THREE.Mesh[];
  rcs: THREE.Mesh[];
  turrets: THREE.Group[];
  /** Ore pod fill indicators, brightened as the hold fills. */
  pods: THREE.Mesh[];
  light: THREE.PointLight;
  sockets: Map<string, THREE.Group>;
};

/** Headless assembly: core, one socket group per hardpoint, then the installed parts. */
export function buildFromParts(build: Build): BuiltShip {
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [], rcs: THREE.Mesh[] = [], turrets: THREE.Group[] = [], pods: THREE.Mesh[] = [];
  const sockets = new Map<string, THREE.Group>();
  const core = CORES[build.core];
  core.build(group);

  for (const hardpoint of core.hardpoints) {
    const socket = new THREE.Group();
    socket.position.set(hardpoint.x, hardpoint.y, hardpoint.z);
    socket.rotation.z = hardpoint.angle;
    if (hardpoint.scale) socket.scale.setScalar(hardpoint.scale);
    socket.name = hardpoint.id;
    group.add(socket);
    sockets.set(hardpoint.id, socket);

    const part = PARTS[build.slots[hardpoint.id] ?? ''];
    if (!part || !partFits(part, hardpoint)) continue;
    part.build(socket);
    // Parts publish their moving pieces by name; the assembler collects them without knowing the geometry.
    socket.traverse(child => {
      if (child.name === 'flame' && child instanceof THREE.Mesh) flames.push(child);
      if (child.name === 'rcs-jet' && child instanceof THREE.Mesh) rcs.push(child);
      if (child.name === 'turret-pivot' && child instanceof THREE.Group) turrets.push(child);
      if (child.name === 'cargo-fill' && child instanceof THREE.Mesh) pods.push(child);
    });
  }

  const light = new THREE.PointLight('#73bdff', 0, 140, 1.4);
  light.position.set(0, -53, 8); group.add(light);
  return { group, flames, rcs, turrets, pods, light, sockets };
}

/** Install or clear a part, and its mirror in the same call. */
export function toggleSlot(build: Build, hardpointId: string, partId: string | null): void {
  const core = CORES[build.core];
  if (!core) return;
  const slot = core.hardpoints.find(hardpoint => hardpoint.id === hardpointId);
  if (!slot) return;
  const part = partId ? PARTS[partId] : undefined;
  if (part && !partFits(part, slot)) return;
  const mirrorOf = slot.mirrorOf;
  const mirror = mirrorOf ? core.hardpoints.find(hardpoint => hardpoint.id === mirrorOf) : undefined;
  if (part && mirror && !partFits(part, mirror)) return;
  build.slots[hardpointId] = partId;
  if (mirror) build.slots[mirror.id] = partId;
}
