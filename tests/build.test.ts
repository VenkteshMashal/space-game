import { describe, expect, test } from 'bun:test';
import { CORES, PARTS, partFits } from '../src/parts';
import type { Hardpoint, PartCategory } from '../src/parts';
import {
  buildSpec, createBuild, derive, presetBuild, purchaseQuoteForBuild, purchaseQuoteForPreset, toggleSlot,
} from '../src/build';
import type { Build } from '../src/build';

function socketFor(build: Build, category: PartCategory, index = 0): Hardpoint {
  const socket = CORES[build.core].hardpoints.filter(entry => entry.accepts.includes(category))[index];
  if (!socket) throw new Error(`no ${category} socket ${index} on ${build.core}`);
  return socket;
}

function socketsFor(build: Build, category: PartCategory): Hardpoint[] {
  return CORES[build.core].hardpoints.filter(entry => entry.accepts.includes(category));
}

function fit(build: Build, category: PartCategory, partId: string, index = 0) {
  toggleSlot(build, socketFor(build, category, index).id, partId);
}

/** Fills every socket of a category; mirrored pairs resolve to one part per socket either way. */
function fillAll(build: Build, category: PartCategory, partId: string) {
  for (const socket of socketsFor(build, category)) toggleSlot(build, socket.id, partId);
}

function workingBuild(core = 'truss'): Build {
  const build = createBuild(core, 'Hauler', `test-${core}`);
  fit(build, 'engine', 'eng-d9', 0);
  fit(build, 'engine', 'eng-d9', 1);
  fit(build, 'tank', 'tnk-m', 0);
  fit(build, 'tank', 'tnk-m', 1);
  fit(build, 'weapon', 'wpn-ac20', 0);
  fit(build, 'armor', 'arm-tile', 0);
  fit(build, 'rcs', 'rcs-pod', 0);
  return build;
}

describe('the part catalogue', () => {
  test('every core offers the sockets it promises and every socket accepts something', () => {
    for (const core of Object.values(CORES)) {
      expect(core.hardpoints.length).toBeGreaterThanOrEqual(8);
      const ids = core.hardpoints.map(hardpoint => hardpoint.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const hardpoint of core.hardpoints) {
        expect(hardpoint.accepts.length).toBeGreaterThan(0);
        expect(hardpoint.label.length).toBeGreaterThan(0);
      }
    }
    for (const [core, counts] of Object.entries({
      spar: { engine: 2, tank: 2, weapon: 4, wing: 2, rcs: 2 },
      truss: { engine: 3, tank: 3, weapon: 6, cargo: 2, armor: 4, wing: 2, rcs: 4 },
      keel: { engine: 4, tank: 4, weapon: 6, cargo: 4, armor: 8, rcs: 4 },
    })) {
      for (const [category, count] of Object.entries(counts)) {
        const sockets = CORES[core].hardpoints.filter(hardpoint => hardpoint.accepts.includes(category as PartCategory));
        expect(sockets.length).toBeGreaterThanOrEqual(count);
      }
    }
  });

  test('every part is coherent and fits a socket that accepts its category', () => {
    for (const part of Object.values(PARTS)) {
      expect(part.mass).toBeGreaterThan(0);
      expect(part.cost).toBe(0);
      const socket: Hardpoint = { id: 'probe', x: 0, y: 0, z: 0, angle: 0, accepts: [part.category], label: 'probe' };
      expect(partFits(part, socket)).toBe(true);
      expect(partFits(part, { ...socket, accepts: ['wing'] })).toBe(part.category === 'wing');
    }
    for (const core of Object.values(CORES)) expect(core.cost).toBe(0);
    for (const id of ['eng-d4', 'eng-d9', 'eng-k12']) expect(PARTS[id].thrust).toBeGreaterThan(0);
    for (const id of ['tnk-s', 'tnk-m', 'tnk-l']) expect(PARTS[id].fuel).toBeGreaterThan(0);
    for (const id of ['wpn-ac20', 'wpn-ac70', 'wpn-gauss', 'wpn-cutter', 'wpn-swarm']) expect(PARTS[id].weapon).toBeTruthy();
    expect(PARTS['rcs-pod'].torque).toBeGreaterThan(0);
    expect(PARTS['wng-rad'].cooling).toBeGreaterThan(0);
  });
});

describe('deriving a build', () => {
  test('an empty core is invalid, and says which system is missing', () => {
    const stats = derive(createBuild('truss', 'Bare frame', 'bare'));
    expect(stats.valid).toBe(false);
    expect(stats.dryMass).toBe(CORES.truss.mass);
    expect(stats.problems.join(' | ')).toMatch(/engine/i);
    expect(stats.problems.join(' | ')).toMatch(/propellant|tank/i);
  });

  test('a working build derives its numbers straight from its parts', () => {
    const build = createBuild('truss', 'Measured', 'measured');
    fillAll(build, 'engine', 'eng-d9');
    fillAll(build, 'tank', 'tnk-m');
    fillAll(build, 'weapon', 'wpn-ac20');
    fillAll(build, 'armor', 'arm-tile');
    fillAll(build, 'rcs', 'rcs-pod');
    const tanks = socketsFor(build, 'tank').length;
    const engines = socketsFor(build, 'engine').length;
    const guns = socketsFor(build, 'weapon').length;
    const plates = socketsFor(build, 'armor').length;
    const pods = socketsFor(build, 'rcs').length;
    const stats = derive(build);
    expect(stats.dryMass).toBe(CORES.truss.mass + engines * PARTS['eng-d9'].mass + tanks * PARTS['tnk-m'].mass
      + guns * PARTS['wpn-ac20'].mass + plates * PARTS['arm-tile'].mass + pods * PARTS['rcs-pod'].mass);
    expect(stats.fuel).toBe(tanks * (PARTS['tnk-m'].fuel ?? 0));
    expect(stats.thrust).toBe(engines * (PARTS['eng-d9'].thrust ?? 0));
    expect(stats.hull).toBe(CORES.truss.hull + plates * (PARTS['arm-tile'].hull ?? 0));
    expect(stats.mounts.length).toBe(guns);
    expect(stats.accel).toBeCloseTo(stats.thrust / (stats.dryMass + stats.fuel), 6);
    expect(stats.gees).toBeCloseTo(stats.accel / 9.81, 6);
    expect(stats.valid).toBe(true);
    expect(stats.problems).toEqual([]);
  });

  test('a weapon lands on its socket, in mount order', () => {
    const build = workingBuild();
    const first = socketFor(build, 'weapon', 0);
    // Skip the first socket's mirror: installing there would replace the same pair.
    const second = socketsFor(build, 'weapon').find(socket => socket.id !== first.id && socket.id !== first.mirrorOf)!;
    toggleSlot(build, second.id, 'wpn-gauss');
    const stats = derive(build);
    expect(stats.mounts[0]).toEqual({ weapon: 'ac20', lx: first.x, ly: first.y });
    expect(stats.mounts.find(mount => mount.weapon === 'gauss')).toEqual({ weapon: 'gauss', lx: second.x, ly: second.y });
  });

  test('adding a tank raises propellant and lowers acceleration', () => {
    const build = workingBuild();
    const before = derive(build);
    fit(build, 'tank', 'tnk-l', 2);
    const after = derive(build);
    expect(after.fuel).toBeGreaterThan(before.fuel);
    expect(after.dryMass).toBeGreaterThan(before.dryMass);
    expect(after.accel).toBeLessThan(before.accel);
  });

  test('attitude authority falls as the build gets heavier', () => {
    const light = workingBuild();
    const heavy = workingBuild();
    fillAll(heavy, 'armor', 'arm-tile');
    fillAll(heavy, 'cargo', 'crg-pod');
    expect(derive(heavy).dryMass).toBeGreaterThan(derive(light).dryMass);
    expect(derive(heavy).torque).toBeLessThan(derive(light).torque);
  });

  test('unknown slots are ignored, while a known part in the wrong socket is blocked', () => {
    const build = workingBuild();
    build.slots['not-a-socket'] = 'wpn-gauss';
    build.slots[socketFor(build, 'cargo', 0).id] = 'not-a-part';
    expect(derive(build).valid).toBe(true);
    const wrong = socketFor(build, 'cargo', 0);
    toggleSlot(build, wrong.id, 'eng-d4');
    expect(build.slots[wrong.id]).toBe('not-a-part');
    build.slots[wrong.id] = 'eng-d4';
    const stats = derive(build);
    expect(stats.valid).toBe(false);
    expect(stats.problems.join(' | ')).toMatch(/does not fit/i);
    expect(stats.thrust).toBe(derive(workingBuild()).thrust);
    expect(() => buildSpec(build)).not.toThrow();
  });

  test('a build turns into a spec the simulation can fly', () => {
    const build = workingBuild();
    const spec = buildSpec(build);
    const stats = derive(build);
    expect(spec.mass).toBe(stats.dryMass);
    expect(spec.fuel).toBe(stats.fuel);
    expect(spec.hull).toBe(Math.round(stats.hull));
    expect(spec.thrust).toBe(stats.thrust);
    expect(spec.length).toBeGreaterThan(10);
    expect(spec.scanScale).toBe(stats.scanScale);
    expect(spec.collectScale).toBe(stats.collectScale);
  });

  test('mirrored sockets install and clear as a pair', () => {
    const build = createBuild('truss', 'Pair test', 'pair');
    const mirrored = CORES.truss.hardpoints.find(hardpoint => hardpoint.mirrorOf);
    expect(mirrored).toBeTruthy();
    const part = Object.values(PARTS).find(entry => partFits(entry, mirrored!))!;
    toggleSlot(build, mirrored!.id, part.id);
    expect(build.slots[mirrored!.id]).toBe(part.id);
    expect(build.slots[mirrored!.mirrorOf!]).toBe(part.id);
    toggleSlot(build, mirrored!.id, null);
    expect(build.slots[mirrored!.id]).toBeNull();
    expect(build.slots[mirrored!.mirrorOf!]).toBeNull();
  });

  test('starter presets place only fitting parts and produce useful mission builds', () => {
    for (const id of ['balanced', 'mining', 'combat', 'patrol'] as const) {
      const build = presetBuild(id, `preset-${id}`);
      for (const [slot, partId] of Object.entries(build.slots)) {
        const hardpoint = CORES[build.core].hardpoints.find(entry => entry.id === slot)!;
        expect(partFits(PARTS[partId!], hardpoint)).toBe(true);
      }
      expect(derive(build).valid).toBe(true);
    }
    const mining = presetBuild('mining');
    const miningStats = derive(mining);
    expect(miningStats.cargo).toBeGreaterThan(0);
    expect(miningStats.mounts.some(mount => mount.weapon === 'cutter')).toBe(true);
    const collectorSocket = Object.entries(mining.slots).find(([, part]) => part === 'utl-coll')?.[0];
    expect(CORES[mining.core].hardpoints.find(socket => socket.id === collectorSocket)?.accepts).toContain('wing');
    expect(derive(presetBuild('combat')).mounts.length).toBeGreaterThan(0);
  });

  test('the patrol starter is valid and every installed component fits its Aegis mount', () => {
    const patrol = presetBuild('patrol', 'patrol-test', 'Patrol');
    expect(patrol.core).toBe('aegis');
    expect(derive(patrol).valid).toBe(true);
    for (const [slot, partId] of Object.entries(patrol.slots)) {
      const hardpoint = CORES.aegis.hardpoints.find(entry => entry.id === slot)!;
      expect(partId).toBeTruthy();
      expect(partFits(PARTS[partId!], hardpoint)).toBe(true);
    }
    for (const id of ['eng-fusion', 'tnk-m', 'wpn-pdc', 'wpn-torpedo', 'wpn-plasma', 'crg-heavy', 'wng-split', 'rcs-vector']) {
      expect(Object.values(patrol.slots)).toContain(id);
    }
  });

  test('survey hardware uses free multiplier values and the strongest fitted array', () => {
    expect(PARTS['utl-scan'].cost).toBe(0);
    expect(PARTS['utl-scan'].scanScale).toBe(2);
    expect(PARTS['utl-array'].cost).toBe(0);
    expect(PARTS['utl-array'].scanScale).toBe(3);
    const build = createBuild('aegis', 'Sensors', 'sensors');
    const sensor = CORES.aegis.hardpoints.find(entry => entry.id === 'sensor-spine')!;
    const cargo = CORES.aegis.hardpoints.find(entry => entry.id === 'port-cargo')!;
    toggleSlot(build, sensor.id, 'utl-scan', false);
    toggleSlot(build, cargo.id, 'utl-array', false);
    expect(derive(build).scanScale).toBe(3);
  });

  test('free catalog purchase compatibility returns an empty quote', () => {
    const build = presetBuild('balanced');
    const quote = purchaseQuoteForBuild(build, ['eng-d9', 'tnk-m', 'wpn-ac20', 'rcs-pod']);
    expect(quote).toEqual({ items: [], total: 0 });
    const mining = purchaseQuoteForPreset('mining', ['eng-d9', 'tnk-m', 'rcs-pod']);
    expect(mining).toEqual({ items: [], total: 0 });
    expect(purchaseQuoteForPreset('patrol', [])).toEqual({ items: [], total: 0 });
  });

  test('toggleSlot supports an asymmetric fit when mirroring is disabled', () => {
    const build = createBuild('truss', 'Asymmetric', 'asymmetric');
    const port = socketFor(build, 'weapon', 0);
    const starboard = CORES.truss.hardpoints.find(entry => entry.id === port.mirrorOf)!;
    toggleSlot(build, port.id, 'wpn-pdc', false);
    expect(build.slots[port.id]).toBe('wpn-pdc');
    expect(build.slots[starboard.id]).toBeUndefined();
    toggleSlot(build, starboard.id, 'wpn-torpedo', false);
    expect(build.slots[starboard.id]).toBe('wpn-torpedo');
    expect(build.slots[port.id]).toBe('wpn-pdc');
    toggleSlot(build, port.id, null, false);
    expect(build.slots[port.id]).toBeNull();
    expect(build.slots[starboard.id]).toBe('wpn-torpedo');
  });
});
