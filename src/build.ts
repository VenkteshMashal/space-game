import * as THREE from 'three';
import { CORES, PARTS } from './parts';
import type { ShipSpec } from './physics';

export type Build = { id: string; name: string; core: string; slots: Record<string, string | null> };

export type DerivedStats = {
  name: string; dryMass: number; fuel: number; thrust: number; hull: number;
  torque: number; cargo: number; cooling: number;
  mounts: { weapon: string; lx: number; ly: number }[];
  scanScale: number; collectScale: number;
  accel: number; gees: number; valid: boolean; problems: string[]; cost: number;
};

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
    if (!part) continue;
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
  if (thrust <= 0) problems.push('No engine. This will not move.');
  if (fuel <= 0) problems.push('No propellant tank.');
  if (accel < 2.2) problems.push('Under 0.22 g — too sluggish to hold station against a rock.');
  if (torque < 0.35) problems.push('Too little attitude authority. Add an RCS quad or shed mass.');
  if (hull < 40) problems.push('Structurally marginal. One collision ends the sortie.');

  return {
    name: build.name, dryMass, fuel, thrust, hull, torque, cargo, cooling, mounts,
    scanScale, collectScale, accel, gees: accel / 9.81, valid: problems.length === 0, problems, cost,
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
    if (!part) continue;
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
  const slot = core.hardpoints.find(hardpoint => hardpoint.id === hardpointId);
  if (!slot) return;
  build.slots[hardpointId] = partId;
  const mirrorOf = slot.mirrorOf;
  if (mirrorOf && core.hardpoints.some(hardpoint => hardpoint.id === mirrorOf)) build.slots[mirrorOf] = partId;
}
