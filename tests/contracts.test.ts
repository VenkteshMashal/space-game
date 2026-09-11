import { describe, expect, test } from 'bun:test';
import { createCargo, createObstacles, createShip, distance, RELAY, STATION } from '../src/physics';
import type { Cargo, ShipState, Vec2 } from '../src/physics';
import {
  CONTRACTS, SCAN, activeCargoIds, available, completeDock, createRun, dockable, interactive,
  isScanned, lockedBy, objectiveSummary, progressOf, recoverCargo, remainingCargos, scanProgress, scanSpec,
  suggestTarget, updateRun,
} from '../src/contracts';
import type { Contract, Objective, Run, RunSignal, Stage, World } from '../src/contracts';

const DT = 1 / 120;

const SR = CONTRACTS.find(contract => contract.id === 'SR-084')!;
const MN = CONTRACTS.find(contract => contract.id === 'MN-210')!;
const BT = CONTRACTS.find(contract => contract.id === 'BT-047')!;
const SV = CONTRACTS.find(contract => contract.id === 'SV-119')!;

const relayObjective = SR.stages[0].objectives[0] as Extract<Objective, { kind: 'hold' }>;
const RELAY_SECONDS = relayObjective.seconds;

/** A mutable world with the counters every destroy/collect objective reads. */
function makeWorld(ship: ShipState = createShip(), cargos: Cargo[] = createCargo()): World {
  return {
    ship, cargos,
    rocks: createObstacles().filter(rock => rock.z === 0).map(rock => ({ x: rock.x, y: rock.y, radius: rock.radius })),
    hostiles: [],
    allies: [],
    counters: { hostilesKilled: 0, rocksBroken: 0, brokenRadii: [], oreHeld: 0 },
  };
}

/** Pins the hull in place and steps the run; the contract never moves the ship itself. */
function holdStation(run: Run, world: World, position: Vec2, seconds: number, speed = 0): RunSignal[] {
  world.ship.position = { ...position };
  world.ship.velocity = { x: speed, y: 0 };
  const signals: RunSignal[] = [];
  for (let i = 0; i < Math.round(seconds * 120); i++) signals.push(...updateRun(run, world, DT));
  return signals;
}

function scannedArchive(run: Run, world: World, index: number): Cargo {
  holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
  holdStation(run, world, world.cargos[index].position, SCAN.archive.seconds + 0.2);
  return world.cargos[index];
}

/** Recovers one of the three archives and lets the run notice, so the stage can advance. */
function recoverArchive(run: Run, world: World, index: number): Cargo {
  const cargo = scannedArchive(run, world, index);
  recoverCargo(run, cargo, world);
  holdStation(run, world, world.ship.position, DT * 2);
  return cargo;
}

/** A minimal contract literal for the objective-shape tests. */
function synth(stages: Stage[], extra: Partial<Contract> = {}): Contract {
  return { id: 'T-test', title: 'Test', kicker: '', brief: '', kind: 'salvage', danger: 0, stages, payout: 100, ...extra };
}

describe('SR-084 salvage contract', () => {
  test('archive contacts stay unresolved until the relay telemetry is pulled', () => {
    const run = createRun(SR), world = makeWorld();
    holdStation(run, world, world.cargos[0].position, SCAN.archive.seconds + 1);
    expect(run.stageIndex).toBe(0);
    expect(run.scanned).toEqual([]);
    expect(interactive(run, world)).toBeUndefined();
  });

  test('holding station at the relay downloads telemetry and opens the recovery stage', () => {
    const run = createRun(SR), world = makeWorld();
    holdStation(run, world, RELAY, RELAY_SECONDS - 0.4);
    expect(run.stageIndex).toBe(0);
    const signals = holdStation(run, world, RELAY, 0.6);
    expect(signals.some(signal => signal.type === 'stage' && signal.index === 1)).toBe(true);
    expect(signals.some(signal => signal.type === 'spawn')).toBe(true);
    expect(run.stageIndex).toBe(1);
  });

  test('a scan needs both range and a slow approach, and decays when either is lost', () => {
    const run = createRun(SR), world = makeWorld();
    holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
    holdStation(run, world, world.cargos[0].position, SCAN.archive.seconds / 2);
    const partial = scanProgress(run, 'cargo-1', SCAN.archive);
    expect(partial).toBeGreaterThan(0.4);
    holdStation(run, world, { x: world.cargos[0].position.x, y: world.cargos[0].position.y + 900 }, 1);
    expect(scanProgress(run, 'cargo-1', SCAN.archive)).toBeLessThan(partial);
    holdStation(run, world, world.cargos[0].position, SCAN.archive.seconds, SCAN.archive.speed + 10);
    expect(run.scanned).not.toContain('cargo-1');
  });

  test('recovery is gated on a completed scan, proximity and a safe closing speed', () => {
    const run = createRun(SR), world = makeWorld();
    const cargo = scannedArchive(run, world, 0);
    expect(run.scanned).toContain(cargo.id);
    expect(isScanned(run, cargo.id)).toBe(true);

    world.ship.position = { x: cargo.position.x + 400, y: cargo.position.y };
    world.ship.velocity = { x: 0, y: 0 };
    expect(interactive(run, world)).toBeUndefined();

    world.ship.position = { ...cargo.position };
    world.ship.velocity = { x: 14, y: 0 };
    expect(interactive(run, world)).toBeUndefined();

    world.ship.velocity = { x: 0, y: 0 };
    expect(interactive(run, world)?.id).toBe(cargo.id);

    const signals = recoverCargo(run, cargo, world);
    expect(signals[0].type).toBe('recovered');
    expect(cargo.collected).toBe(true);
    expect(remainingCargos(run, world)).toBe(2);
    expect(run.payout).toBe(0);
    expect(run.stageIndex).toBe(1);
  });

  test('recovery refuses an unscanned or already collected contact', () => {
    const run = createRun(SR), world = makeWorld();
    holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
    const cargo = world.cargos[0];
    expect(recoverCargo(run, cargo, world)).toEqual([]);
    expect(cargo.collected).toBe(false);

    holdStation(run, world, cargo.position, SCAN.archive.seconds + 0.2);
    expect(recoverCargo(run, cargo, world)[0].type).toBe('recovered');
    expect(recoverCargo(run, cargo, world)).toEqual([]);
  });

  test('the contract docks only after all three archives and then pays the completion fee', () => {
    const run = createRun(SR), world = makeWorld();
    for (let index = 0; index < 3; index++) recoverArchive(run, world, index);
    expect(run.stageIndex).toBe(2);
    expect(run.payout).toBe(0);

    world.ship.position = { ...STATION };
    world.ship.velocity = { x: 9, y: 0 };
    expect(dockable(run, world)).toBe(false);
    world.ship.velocity = { x: 0, y: 0 };
    expect(dockable(run, world)).toBe(true);

    const signals = completeDock(run, world);
    expect(signals.find(signal => signal.type === 'complete')).toEqual({ type: 'complete', payout: SR.payout });
    expect(run.complete).toBe(true);
    expect(run.payout).toBe(SR.payout);
    expect(completeDock(run, world)).toEqual([]);
    expect(updateRun(run, world, DT)).toEqual([]);
  });

  test('the black box is optional salvage that pays its bonus once the contract closes', () => {
    const run = createRun(SR), world = makeWorld();
    const blackbox = world.cargos.find(cargo => cargo.kind === 'blackbox')!;
    holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
    holdStation(run, world, blackbox.position, SCAN.blackbox.seconds + 0.2);
    expect(run.scanned).toContain('blackbox');

    recoverCargo(run, blackbox, world);
    expect(blackbox.collected).toBe(true);
    expect(run.stageIndex).toBe(1);
    expect(run.payout).toBe(0);
    expect(dockable(run, world)).toBe(false);

    for (let index = 0; index < 3; index++) recoverArchive(run, world, index);
    world.ship.position = { ...STATION };
    world.ship.velocity = { x: 0, y: 0 };
    completeDock(run, world);
    expect(run.complete).toBe(true);
    expect(run.payout).toBe(SR.payout + SR.bonus!.credits);
  });

  test('navigation points at the relay first, then the nearest unresolved contact', () => {
    const run = createRun(SR), world = makeWorld();
    expect(suggestTarget(run, world)?.id).toBe('relay');
    holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
    const nearest = world.cargos
      .filter(cargo => cargo.kind === 'archive')
      .sort((a, b) => distance(world.ship.position, a.position) - distance(world.ship.position, b.position))[0];
    expect(suggestTarget(run, world)?.id).toBe(nearest.id);
  });
});

describe('run mechanics', () => {
  test('stage entry fires exactly once', () => {
    const run = createRun(SR), world = makeWorld();
    const first = holdStation(run, world, RELAY, DT);
    expect(first.filter(signal => signal.type === 'stage')).toHaveLength(1);
    expect(first.find(signal => signal.type === 'stage')).toMatchObject({ index: 0 });
    const second = holdStation(run, world, RELAY, DT);
    expect(second.filter(signal => signal.type === 'stage')).toHaveLength(0);
    expect(run.entered).toEqual([0]);
  });

  test('contacts scan only while a contract asks for them', () => {
    const run = createRun(SR), world = makeWorld();
    holdStation(run, world, RELAY, DT);
    expect(activeCargoIds(run, world)).not.toContain('cargo-1');
    expect(activeCargoIds(run, world)).not.toContain('cargo-2');
    expect(activeCargoIds(run, world)).not.toContain('cargo-3');

    holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
    expect(activeCargoIds(run, world).sort()).toEqual(['blackbox', 'cargo-1', 'cargo-2', 'cargo-3']);

    recoverArchive(run, world, 0);
    expect(activeCargoIds(run, world)).not.toContain('cargo-1');
    expect(activeCargoIds(run, world)).toContain('cargo-2');
    expect(activeCargoIds(run, world)).toContain('cargo-3');
  });

  test('a stage with two objectives does not advance until both are complete', () => {
    const contract = synth([
      {
        title: 'Both', objectives: [
          { kind: 'reach', target: { at: 'point', x: 0, y: 0 }, radius: 50, label: 'Close' },
          { kind: 'reach', target: { at: 'point', x: 0, y: 0 }, radius: 200, label: 'Near' },
        ],
      },
      { title: 'Dock', objectives: [{ kind: 'dock', label: 'Dock' }] },
    ]);
    const run = createRun(contract), world = makeWorld();
    holdStation(run, world, { x: 120, y: 0 }, 0.1);
    expect(run.stageIndex).toBe(0);
    expect(objectiveSummary(run).map(row => row.done)).toEqual([false, true]);
    holdStation(run, world, { x: 0, y: 0 }, 0.1);
    expect(run.stageIndex).toBe(1);
  });

  test('destroy counts only what happened since the stage was entered, and respects minRadius', () => {
    const contract = synth([
      { title: 'Break', objectives: [{ kind: 'destroy', what: 'rock', count: 4, minRadius: 26, label: 'Rocks' }] },
    ]);
    const run = createRun(contract), world = makeWorld();
    world.counters.brokenRadii = [40, 12];
    holdStation(run, world, { x: 0, y: 0 }, DT);
    expect(run.baselines['0:0']).toBe(1);

    world.counters.brokenRadii = [40, 12, 30, 5];
    holdStation(run, world, { x: 0, y: 0 }, DT);
    expect(progressOf(run, contract.stages[0].objectives[0])).toBeCloseTo(0.25);
  });

  test('destroy counts hostiles from the entry baseline too', () => {
    const contract = synth([
      { title: 'Clear', objectives: [{ kind: 'destroy', what: 'hostile', count: 2, label: 'Raiders' }] },
    ]);
    const run = createRun(contract), world = makeWorld();
    world.counters.hostilesKilled = 5;
    holdStation(run, world, { x: 0, y: 0 }, DT);
    expect(run.baselines['0:0']).toBe(5);
    world.counters.hostilesKilled = 6;
    holdStation(run, world, { x: 0, y: 0 }, DT);
    expect(progressOf(run, contract.stages[0].objectives[0])).toBeCloseTo(0.5);
  });

  test('completed holds and reaches stay complete while the next objective is performed', () => {
    const contract = synth([{
      title: 'Hold then return',
      objectives: [
        { kind: 'hold', target: { at: 'relay' }, radius: 100, speed: 10, seconds: 0.1, label: 'Hold' },
        { kind: 'reach', target: { at: 'point', x: 0, y: 0 }, radius: 20, label: 'Reach' },
        { kind: 'dock', label: 'Dock' },
      ],
    }]);
    const run = createRun(contract), world = makeWorld();
    holdStation(run, world, RELAY, 0.2);
    expect(progressOf(run, contract.stages[0].objectives[0])).toBe(1);
    expect(progressOf(run, contract.stages[0].objectives[1])).toBe(0);

    holdStation(run, world, { x: 900, y: 900 }, 0.3);
    expect(progressOf(run, contract.stages[0].objectives[0])).toBe(1);
    holdStation(run, world, { x: 0, y: 0 }, 0.1);
    expect(progressOf(run, contract.stages[0].objectives[1])).toBe(1);
    holdStation(run, world, { x: 900, y: 900 }, 0.3);
    expect(progressOf(run, contract.stages[0].objectives[1])).toBe(1);
  });

  test('SV-119 keeps the final survey hold complete while the player docks', () => {
    const run = createRun(SV), world = makeWorld();
    run.stageIndex = 2;
    const drop = { x: 400, y: 1700 };
    holdStation(run, world, drop, 4.2);
    expect(run.stageIndex).toBe(2);
    expect(progressOf(run, SV.stages[2].objectives[0])).toBe(1);

    world.ship.position = { ...STATION };
    world.ship.velocity = { x: 0, y: 0 };
    completeDock(run, world);
    expect(run.complete).toBe(true);
  });

  test('BT-047 counts approach kills toward all seven hostiles', () => {
    const run = createRun(BT), world = makeWorld();
    holdStation(run, world, { x: 0, y: 0 }, DT);
    world.counters.hostilesKilled = 2;
    world.ship.position = { ...world.cargos.find(cargo => cargo.id === 'blackbox')!.position };
    holdStation(run, world, world.ship.position, DT);
    expect(run.stageIndex).toBe(1);

    world.counters.hostilesKilled = 7;
    holdStation(run, world, world.ship.position, DT);
    expect(run.stageIndex).toBe(2);
  });

  test('scaled scan specs shorten scan time and preserve the default', () => {
    const cargo = createCargo()[0];
    expect(scanSpec(cargo).seconds).toBe(SCAN.archive.seconds);
    expect(scanSpec(cargo, 2).seconds).toBeCloseTo(SCAN.archive.seconds / 2);

    const run = createRun(SR), world = makeWorld();
    world.ship.spec = { ...world.ship.spec, scanScale: 2 } as typeof world.ship.spec;
    holdStation(run, world, RELAY, RELAY_SECONDS + 0.2);
    holdStation(run, world, cargo.position, SCAN.archive.seconds / 2 + 0.2);
    expect(run.scanned).toContain(cargo.id);
  });

  test('collect objectives read cumulative mined units beyond current cargo capacity', () => {
    const contract = synth([{ title: 'Unload', objectives: [{ kind: 'collect', amount: 420, label: 'Ore' }] }]);
    const run = createRun(contract), world = makeWorld();
    world.counters.oreHeld = 420;
    world.ship.spec = { ...world.ship.spec, cargo: 320 };
    holdStation(run, world, { x: 0, y: 0 }, DT);
    expect(progressOf(run, contract.stages[0].objectives[0])).toBe(1);
  });

  test('escort completion requires the living barge at station and a player dock', () => {
    const run = createRun(CONTRACTS.find(contract => contract.id === 'EC-005')!), world = makeWorld();
    const ally = { id: 'hauler', name: 'Ceres Run', position: { x: 0, y: 0 }, hull: 220, maxHull: 220 };
    world.allies = [ally];
    holdStation(run, world, { x: 0, y: 0 }, DT);
    world.ship.position = { ...STATION };
    world.ship.velocity = { x: 0, y: 0 };
    completeDock(run, world);
    expect(run.complete).toBe(false);

    ally.position = { x: STATION.x + 10, y: STATION.y };
    completeDock(run, world);
    expect(run.complete).toBe(true);
  });

  test('an escort fails immediately when its present ally has zero hull', () => {
    const run = createRun(CONTRACTS.find(contract => contract.id === 'EC-005')!), world = makeWorld();
    world.allies = [{ id: 'hauler', name: 'Ceres Run', position: { x: 0, y: 0 }, hull: 0, maxHull: 220 }];
    const signals = holdStation(run, world, { x: 0, y: 0 }, DT);
    expect(run.failed).toContain('escort was lost');
    expect(signals.some(signal => signal.type === 'failed')).toBe(true);
  });

  test('a time limit fails the run exactly once and stops signalling', () => {
    const contract = synth([
      { title: 'Hold', objectives: [{ kind: 'hold', target: { at: 'relay' }, radius: 200, speed: 50, seconds: 100, label: 'Hold' }] },
    ], { timeLimit: 1 });
    const run = createRun(contract), world = makeWorld();
    const early = holdStation(run, world, RELAY, 0.6);
    expect(early.some(signal => signal.type === 'failed')).toBe(false);
    const late = holdStation(run, world, RELAY, 0.6);
    expect(late.filter(signal => signal.type === 'failed')).toHaveLength(1);
    expect(run.failed).toBeTruthy();
    expect(updateRun(run, world, DT)).toEqual([]);
    expect(suggestTarget(run, world)).toBeUndefined();
  });

  test('contracts unlock only once their requirement is completed', () => {
    expect(available(SR, { completed: [] })).toBe(true);
    expect(available(BT, { completed: [] })).toBe(false);
    expect(available(BT, { completed: ['SR-084'] })).toBe(true);
    expect(lockedBy(BT, { completed: [] })?.id).toBe('SR-084');
    expect(lockedBy(BT, { completed: ['SR-084'] })).toBeUndefined();
    expect(available(SV, { completed: [] })).toBe(false);
    expect(available(SV, { completed: ['SR-084'] })).toBe(true);
    expect(lockedBy(SV, { completed: [] })?.id).toBe('SR-084');
  });

  test('the staged contract data covers the four kinds with expected shapes', () => {
    expect(MN.kind).toBe('mining');
    expect(BT.kind).toBe('bounty');
    expect(SV.kind).toBe('survey');
    expect(SV.timeLimit).toBe(420);
    expect(SR.stages).toHaveLength(3);
    expect(BT.requires).toEqual(['SR-084']);
  });
});
