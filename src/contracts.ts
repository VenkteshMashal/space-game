import { canDock, canRecover, distance, length, recoveryRadius, RELAY, STATION } from './physics';
import type { Cargo, ShipState, Vec2 } from './physics';
import type { HostileKind } from './combat';

/** Anything an objective can point at. Resolved against the world at the moment it is asked for. */
export type TargetRef =
  | { at: 'relay' }
  | { at: 'station' }
  | { at: 'derelict' }
  | { at: 'cargo'; id: string }
  | { at: 'point'; x: number; y: number }
  | { at: 'nearest-rock'; minRadius?: number }
  | { at: 'nearest-hostile' }
  | { at: 'ally'; id: string };

export type Objective =
  | { kind: 'hold'; target: TargetRef; radius: number; speed: number; seconds: number; label: string }
  | { kind: 'recover'; cargo: string; label: string }
  | { kind: 'dock'; label: string }
  | { kind: 'destroy'; what: 'hostile' | 'rock'; count: number; minRadius?: number; countFrom?: 'stage' | 'contract'; label: string }
  | { kind: 'collect'; amount: number; label: string }
  | { kind: 'reach'; target: TargetRef; radius: number; subject?: 'ship' | 'ally'; ally?: string; label: string }
  | { kind: 'protect'; ally: string; label: string };

/** An escort stage hands the run an NPC to look after, with the route it flies. */
export type EscortSpec = { id: string; name: string; at: TargetRef; route: TargetRef[]; hull: number };

export type SpawnSpec = { kind: HostileKind; near: TargetRef; count: number; spread: number; reaction?: number };
export type Stage = { title: string; objectives: Objective[]; onEnter?: SpawnSpec[]; banner?: string; escort?: EscortSpec };

export type Contract = {
  id: string; title: string; kicker: string; brief: string;
  kind: 'salvage' | 'mining' | 'bounty' | 'survey' | 'escort';
  danger: 0 | 1 | 2 | 3;
  stages: Stage[];
  payout: number;
  /** The optional extra. `from` is the stage it appears in, so a bonus can wait for the story. */
  bonus?: { label: string; credits: number; objective: Objective; from?: number };
  requires?: string[];
  timeLimit?: number;
};

/** Everything an objective may read. Kept explicit so this module never reaches into the shell. */
export type World = {
  ship: ShipState;
  cargos: Cargo[];
  /** Planar rock positions, for navigation hints that point at work rather than at a contact. */
  rocks: { x: number; y: number; radius: number }[];
  hostiles: { x: number; y: number }[];
  /** NPCs on the player's side: an escort objective fails the run when one is lost. */
  allies: { id: string; name: string; position: Vec2; hull: number; maxHull: number }[];
  counters: {
    hostilesKilled: number;
    rocksBroken: number;
    /** Radii of the rocks broken this sortie, which is what a minimum-size objective counts. */
    brokenRadii: number[];
    /** Cumulative units mined this sortie; it may exceed the ship's current cargo load. */
    oreHeld: number;
  };
};

export type Run = {
  contract: Contract;
  stageIndex: number;
  /** Objective key -> 0..1, the only thing the HUD needs to draw a stage row. */
  progress: Record<string, number>;
  /** Seconds accumulated toward each hold objective. */
  hold: Record<string, number>;
  /** Slow-resolving contacts: accumulated scan time per cargo. */
  scan: Record<string, number>;
  scanned: string[];
  /** Stage indices whose onEnter has already fired, so a stage never spawns twice. */
  entered: number[];
  /** Allies this run has actually had on the field, so an escort is only lost once it existed. */
  knownAllies: string[];
  baselines: Record<string, number>;
  elapsed: number;
  docked: boolean;
  payout: number;
  complete: boolean;
  failed?: string;
};

export type RunSignal =
  | { type: 'stage'; index: number; stage: Stage }
  | { type: 'spawn'; spec: SpawnSpec }
  | { type: 'escort'; spec: EscortSpec }
  | { type: 'scan'; cargo: Cargo }
  | { type: 'objective'; objective: Objective }
  | { type: 'recovered'; cargo: Cargo; remaining: number }
  | { type: 'complete'; payout: number }
  | { type: 'failed'; reason: string };

export type NavTarget = { id: string; name: string; position: Vec2 };

export type ScanSpec = { radius: number; speed: number; seconds: number };
export const SCAN: { archive: ScanSpec; blackbox: ScanSpec } = {
  archive: { radius: 130, speed: 26, seconds: 3.4 },
  blackbox: { radius: 125, speed: 20, seconds: 4.2 },
};

export function scanSpec(cargo: Cargo, scanScale = 1): ScanSpec {
  const base = cargo.kind === 'blackbox' ? SCAN.blackbox : SCAN.archive;
  const scale = Math.max(0.01, scanScale);
  return scale === 1 ? base : { ...base, seconds: base.seconds / scale };
}

const key = (stage: number, index: number) => `${stage}:${index}`;
const BONUS_KEY = 'bonus';

export function createRun(contract: Contract): Run {
  return {
    contract, stageIndex: 0, progress: {}, hold: {}, scan: {}, scanned: [], entered: [], knownAllies: [], baselines: {},
    elapsed: 0, docked: false, payout: 0, complete: false,
  };
}

export function stage(run: Run): Stage { return run.contract.stages[Math.min(run.stageIndex, run.contract.stages.length - 1)]; }

/** A contract is offered only when everything it requires has been completed. */
export function available(contract: Contract, profile: { completed: string[] }): boolean {
  return (contract.requires ?? []).every(id => profile.completed.includes(id));
}

export function lockedBy(contract: Contract, profile: { completed: string[] }): Contract | undefined {
  const missing = (contract.requires ?? []).find(id => !profile.completed.includes(id));
  return missing ? CONTRACTS.find(entry => entry.id === missing) : undefined;
}

function cargoAt(world: World, id: string): Cargo | undefined {
  return world.cargos.find(cargo => cargo.id === id);
}

export function resolveTarget(world: World, ref: TargetRef): Vec2 | undefined {
  switch (ref.at) {
    case 'relay': return RELAY;
    case 'station': return STATION;
    case 'derelict': return cargoAt(world, 'blackbox')?.position;
    case 'cargo': return cargoAt(world, ref.id)?.position;
    case 'point': return { x: ref.x, y: ref.y };
    case 'nearest-rock': return nearest(world, world.rocks.filter(rock => rock.radius >= (ref.minRadius ?? 0)));
    case 'nearest-hostile': return nearest(world, world.hostiles);
    case 'ally': return world.allies.find(entry => entry.id === ref.id)?.position;
  }
}

function nearest(world: World, list: { x: number; y: number }[]): Vec2 | undefined {
  let best: Vec2 | undefined;
  let bestRange = Infinity;
  for (const entry of list) {
    const range = distance(world.ship.position, entry);
    if (range < bestRange) { bestRange = range; best = { x: entry.x, y: entry.y }; }
  }
  return best;
}

export function targetName(world: World, ref: TargetRef): string {
  switch (ref.at) {
    case 'relay': return 'Nereid relay';
    case 'station': return 'Wayfarer station';
    case 'derelict': return 'Kite’s End';
    case 'cargo': return cargoAt(world, ref.id)?.name ?? 'Lost contact';
    case 'point': return 'Waypoint';
    case 'nearest-rock': return 'Nearest ore';
    case 'nearest-hostile': return 'Nearest hostile';
    case 'ally': return world.allies.find(entry => entry.id === ref.id)?.name ?? 'Escort' ;
  }
}

function navId(ref: TargetRef): string {
  switch (ref.at) {
    case 'relay': return 'relay';
    case 'station': return 'station';
    case 'derelict': return 'derelict';
    case 'cargo': return ref.id;
    case 'point': return `waypoint:${Math.round(ref.x)}:${Math.round(ref.y)}`;
    case 'nearest-rock': return 'ore';
    case 'nearest-hostile': return 'hostile';
    case 'ally': return ref.id;
  }
}

/**
 * The cargos a contract wants: every cargo named by an incomplete recover objective in the current
 * stage, plus the bonus contact once its stage has come. Nothing else can be scanned, which is what
 * gates salvage runs.
 */
export function activeCargoIds(run: Run, world: World): string[] {
  const ids: string[] = [];
  for (const objective of stage(run).objectives) {
    if (objective.kind === 'recover' && progressOf(run, objective) < 1) ids.push(objective.cargo);
  }
  const bonus = run.contract.bonus;
  if (bonus && bonus.objective.kind === 'recover' && run.stageIndex >= (bonus.from ?? 0) && progressOf(run, bonus.objective) < 1) {
    ids.push(bonus.objective.cargo);
  }
  return ids.filter(id => cargoAt(world, id));
}

/** The key an objective's progress lives under: its position in its stage, or the bonus slot. */
function objectiveKey(run: Run, objective: Objective): string {
  if (objective === run.contract.bonus?.objective) return BONUS_KEY;
  for (let index = 0; index < run.contract.stages.length; index++) {
    const position = run.contract.stages[index].objectives.indexOf(objective);
    if (position >= 0) return key(index, position);
  }
  return BONUS_KEY;
}

export function progressOf(run: Run, objective: Objective): number {
  return run.progress[objectiveKey(run, objective)] ?? 0;
}

export function isScanned(run: Run, id: string): boolean { return run.scanned.includes(id); }

export function scanProgress(run: Run, id: string, spec: ScanSpec): number {
  return Math.min(1, (run.scan[id] ?? 0) / spec.seconds);
}

export function remainingCargos(run: Run, world: World): number {
  const wanted = new Set<string>();
  for (const entry of run.contract.stages) {
    for (const objective of entry.objectives) if (objective.kind === 'recover') wanted.add(objective.cargo);
  }
  return [...wanted].filter(id => !cargoAt(world, id)?.collected).length;
}

/** Objective progress for one step. Hold and destroy objectives accumulate; the rest are states. */
function evaluate(run: Run, world: World, objective: Objective, id: string, dt: number): number {
  switch (objective.kind) {
    case 'hold': {
      // A completed hold is a milestone. It must survive the flight to the next objective.
      if ((run.progress[id] ?? 0) >= 1) return 1;
      const at = resolveTarget(world, objective.target);
      const inRange = Boolean(at) && distance(world.ship.position, at!) < objective.radius && length(world.ship.velocity) < objective.speed;
      const current = run.hold[id] ?? 0;
      run.hold[id] = inRange ? current + dt : Math.max(0, current - dt * 1.7);
      return Math.min(1, run.hold[id] / objective.seconds);
    }
    case 'recover':
      return cargoAt(world, objective.cargo)?.collected ? 1 : 0;
    case 'dock':
      return run.docked ? 1 : 0;
    case 'destroy': {
      const count = objective.what === 'hostile'
        ? world.counters.hostilesKilled
        : world.counters.brokenRadii.filter(radius => radius >= (objective.minRadius ?? 0)).length;
      const baselineKey = objective.countFrom === 'contract' ? 'run:' + objective.what : id;
      const since = count - (run.baselines[baselineKey] ?? count);
      return Math.min(1, since / objective.count);
    }
    case 'collect':
      return Math.min(1, world.counters.oreHeld / objective.amount);
    case 'reach': {
      // Escort routes use the same objective shape but measure the named NPC at the destination.
      if ((run.progress[id] ?? 0) >= 1) return 1;
      if (objective.subject === 'ally') {
        const ally = world.allies.find(entry => entry.id === objective.ally);
        const at = resolveTarget(world, objective.target);
        return ally && ally.hull > 0 && at && distance(ally.position, at) < objective.radius ? 1 : 0;
      }
      const at = resolveTarget(world, objective.target);
      return at && distance(world.ship.position, at) < objective.radius ? 1 : 0;
    }
    case 'protect': {
      const ally = world.allies.find(entry => entry.id === objective.ally);
      if (!ally || ally.hull <= 0) return 0;
      // The bonus form of the objective asks for an intact barge, not merely a surviving one.
      return id === BONUS_KEY ? Math.min(1, ally.hull / Math.max(1, ally.maxHull) / 0.6) : 1;
    }
  }
}

/** Marks a stage entered: banner, one-time spawns and the destroy baselines for its objectives. */
function enterStage(run: Run, world: World, signals: RunSignal[]) {
  const current = stage(run);
  run.entered.push(run.stageIndex);
  // Contract-scoped destroy objectives include kills made during an approach stage. The first
  // stage entry is the mission's counter baseline; later stages keep using that same baseline.
  if (run.stageIndex === 0) {
    if (run.baselines['run:hostile'] === undefined) run.baselines['run:hostile'] = world.counters.hostilesKilled;
    if (run.baselines['run:rock'] === undefined) run.baselines['run:rock'] = world.counters.brokenRadii.length;
  }
  // A new stage wants its own approach, so an earlier dock no longer counts.
  run.docked = false;
  current.objectives.forEach((objective, index) => {
    if (objective.kind !== 'destroy') return;
    if (objective.countFrom === 'contract') return;
    run.baselines[key(run.stageIndex, index)] = objective.what === 'hostile'
      ? world.counters.hostilesKilled
      : world.counters.brokenRadii.filter(radius => radius >= (objective.minRadius ?? 0)).length;
  });
  signals.push({ type: 'stage', index: run.stageIndex, stage: current });
  for (const spec of current.onEnter ?? []) signals.push({ type: 'spawn', spec });
  if (current.escort) signals.push({ type: 'escort', spec: current.escort });
}

/** One step of contract progress: spawns, scans, stage transitions and completion. */
export function updateRun(run: Run, world: World, dt: number): RunSignal[] {
  const signals: RunSignal[] = [];
  if (run.complete || run.failed) return signals;
  run.elapsed += dt;
  if (run.contract.timeLimit && run.elapsed > run.contract.timeLimit) {
    run.failed = 'The window closed before the work was done.';
    return [{ type: 'failed', reason: run.failed }];
  }
  const current = stage(run);
  if (!run.entered.includes(run.stageIndex)) enterStage(run, world, signals);
  // Contacts resolve only when the contract is asking for them.
  const wanted = new Set(activeCargoIds(run, world));
  for (const id of wanted) {
    const cargo = cargoAt(world, id)!;
    if (cargo.collected || isScanned(run, cargo.id)) continue;
    const scanScale = (world.ship.spec as ShipState['spec'] & { scanScale?: number }).scanScale ?? 1;
    const spec = scanSpec(cargo, scanScale);
    const inRange = distance(world.ship.position, cargo.position) < Math.max(spec.radius, recoveryRadius(world.ship, cargo) + 60) && length(world.ship.velocity) < spec.speed;
    const previous = run.scan[cargo.id] ?? 0;
    run.scan[cargo.id] = inRange ? previous + dt : Math.max(0, previous - dt * 1.7);
    if (run.scan[cargo.id] >= spec.seconds) {
      run.scanned.push(cargo.id);
      signals.push({ type: 'scan', cargo });
    }
  }
  let advanced = true;
  for (let index = 0; index < current.objectives.length; index++) {
    const objective = current.objectives[index];
    const id = key(run.stageIndex, index);
    const before = run.progress[id] ?? 0;
    const now = evaluate(run, world, objective, id, dt);
    run.progress[id] = now;
    if (now >= 1 && before < 1) signals.push({ type: 'objective', objective });
    if (now < 1) advanced = false;
    // An escort is only lost once it has been on the field: the spawn arrives with the stage signal.
    if (objective.kind === 'protect') {
      const ally = world.allies.find(entry => entry.id === objective.ally);
      if (ally && !run.knownAllies.includes(ally.id)) run.knownAllies.push(ally.id);
      if (ally && ally.hull <= 0) {
        run.failed = objective.label + ' — the escort was lost.';
        signals.push({ type: 'failed', reason: run.failed });
        return signals;
      }
      if (!ally && run.knownAllies.includes(objective.ally)) {
        run.failed = `${objective.label} — the escort was lost.`;
        signals.push({ type: 'failed', reason: run.failed });
        return signals;
      }
    }
  }
  const bonus = run.contract.bonus;
  if (bonus && run.stageIndex >= (bonus.from ?? 0)) {
    const before = run.progress[BONUS_KEY] ?? 0;
    const now = evaluate(run, world, bonus.objective, BONUS_KEY, dt);
    run.progress[BONUS_KEY] = now;
    if (now >= 1 && before < 1) signals.push({ type: 'objective', objective: bonus.objective });
  }
  if (advanced) {
    if (run.stageIndex >= run.contract.stages.length - 1) {
      run.complete = true;
      run.payout = run.contract.payout + (bonus && (run.progress[BONUS_KEY] ?? 0) >= 1 ? run.contract.bonus!.credits : 0);
      signals.push({ type: 'complete', payout: run.payout });
    } else {
      run.stageIndex++;
      enterStage(run, world, signals);
    }
  }
  return signals;
}

/** The contact the interact control would act on right now, if any. */
export function interactive(run: Run, world: World): Cargo | undefined {
  if (run.complete || run.failed) return undefined;
  const wanted = new Set(activeCargoIds(run, world));
  return world.cargos
    .filter(cargo => wanted.has(cargo.id) && isScanned(run, cargo.id) && canRecover(world.ship, cargo))
    .sort((a, b) => distance(world.ship.position, a.position) - distance(world.ship.position, b.position))[0];
}

export function recoverCargo(run: Run, cargo: Cargo, world: World): RunSignal[] {
  if (run.complete || run.failed || !activeCargoIds(run, world).includes(cargo.id) || !isScanned(run, cargo.id) || !canRecover(world.ship, cargo)) return [];
  cargo.collected = true;
  return [{ type: 'recovered', cargo, remaining: remainingCargos(run, world) }];
}

/** Closing the contract happens at the dock: that is where the payment lands. */
export function completeDock(run: Run, world: World): RunSignal[] {
  if (run.complete || run.failed) return [];
  if (!canDock(world.ship)) return [];
  run.docked = true;
  return updateRun(run, world, 0);
}

export function dockable(run: Run, world: World): boolean {
  return !run.complete && !run.failed && canDock(world.ship);
}

/** Where the navigation computer would send a pilot next: the nearest unfinished objective. */
export function suggestTarget(run: Run, world: World): NavTarget | undefined {
  if (run.complete || run.failed) return undefined;
  const wanted: TargetRef[] = [];
  for (const objective of stage(run).objectives) {
    if (progressOf(run, objective) >= 1) continue;
    if (objective.kind === 'recover') wanted.push({ at: 'cargo', id: objective.cargo });
    else if (objective.kind === 'hold' || objective.kind === 'reach') wanted.push(objective.target);
    else if (objective.kind === 'dock') wanted.push({ at: 'station' });
    else if (objective.kind === 'destroy' && objective.what === 'rock') wanted.push({ at: 'nearest-rock', minRadius: objective.minRadius });
    else if (objective.kind === 'destroy') wanted.push({ at: 'nearest-hostile' });
    else if (objective.kind === 'protect') wanted.push({ at: 'ally', id: objective.ally });
  }
  if (!wanted.length) {
    const bonus = run.contract.bonus;
    if (bonus && bonus.objective.kind === 'recover') wanted.push({ at: 'cargo', id: bonus.objective.cargo });
    else if (stage(run).objectives.some(objective => objective.kind === 'collect')) wanted.push({ at: 'nearest-rock' });
  }
  const ranked = wanted
    .map(ref => ({ ref, position: resolveTarget(world, ref) }))
    .filter(entry => entry.position)
    .sort((a, b) => distance(world.ship.position, a.position!) - distance(world.ship.position, b.position!));
  const best = ranked[0];
  if (!best) return undefined;
  return { id: navId(best.ref), name: targetName(world, best.ref), position: best.position! };
}

export function objectiveSummary(run: Run): { label: string; progress: number; done: boolean }[] {
  const rows = stage(run).objectives.map(objective => {
    const progress = progressOf(run, objective);
    return { label: objective.label, progress, done: progress >= 1 };
  });
  const bonus = run.contract.bonus;
  if (bonus) {
    const progress = run.progress[BONUS_KEY] ?? 0;
    rows.push({ label: bonus.label, progress, done: progress >= 1 });
  }
  return rows;
}

export const CONTRACTS: Contract[] = [
  {
    id: 'SR-084', title: 'Ghosts in the belt', kind: 'salvage', danger: 1,
    kicker: 'Nereid recovery zone',
    brief: 'A survey crew stopped transmitting. Their relay still answers, and the three archives it left behind are still out there.',
    payout: 2800,
    stages: [
      {
        title: 'Relay telemetry', banner: 'Hold station at the Nereid relay',
        objectives: [{ kind: 'hold', target: { at: 'relay' }, radius: 145, speed: 22, seconds: 2.6, label: 'Hold inside 145 m under 22 m/s' }],
      },
      {
        title: 'Resolve and recover',
        // Scavengers followed the same signal you did. They arrive once the archives light up.
        onEnter: [{ kind: 'raider', near: { at: 'cargo', id: 'cargo-3' }, count: 2, spread: 400 }],
        objectives: [
          { kind: 'recover', cargo: 'cargo-1', label: 'Flight recorder' },
          { kind: 'recover', cargo: 'cargo-2', label: 'Research canister' },
          { kind: 'recover', cargo: 'cargo-3', label: 'Survey archive' },
        ],
      },
      { title: 'Return to Wayfarer', objectives: [{ kind: 'dock', label: 'Dock under 8 m/s' }] },
    ],
    bonus: { label: 'Kite’s End black box', credits: 4200, from: 1, objective: { kind: 'recover', cargo: 'blackbox', label: 'Black box' } },
  },
  {
    id: 'MN-210', title: 'Quota run', kind: 'mining', danger: 0,
    kicker: 'Wayfarer refinery',
    brief: 'The refinery is short again. Break rock, fill your pods, come home. Nothing out there wants to stop you.',
    payout: 5200,
    stages: [
      {
        title: 'Break and collect',
        objectives: [
          { kind: 'destroy', what: 'rock', count: 8, minRadius: 26, label: 'Break 8 rocks over 26 m' },
          { kind: 'collect', amount: 420, label: 'Collect 420 units of ore' },
        ],
      },
      { title: 'Deliver', objectives: [{ kind: 'dock', label: 'Dock and unload' }] },
    ],
    bonus: { label: 'Overfill the hold', credits: 2200, objective: { kind: 'collect', amount: 700, label: '700 units of ore' } },
  },
  {
    id: 'BT-047', title: 'Nest at Kite’s End', kind: 'bounty', danger: 3,
    kicker: 'Standing bounty',
    brief: 'Raiders have been staging off the wreck of Kite’s End. Wayfarer wants the nest cleared and the lane quiet again.',
    payout: 9400, requires: ['SR-084'],
    stages: [
      {
        title: 'Approach', banner: 'They will see you coming',
        onEnter: [{ kind: 'turret', near: { at: 'derelict' }, count: 2, spread: 220 }],
        objectives: [{ kind: 'reach', target: { at: 'derelict' }, radius: 700, label: 'Close to 700 m' }],
      },
      {
        title: 'Clear the nest',
        onEnter: [
          { kind: 'raider', near: { at: 'derelict' }, count: 3, spread: 500 },
          { kind: 'interceptor', near: { at: 'derelict' }, count: 2, spread: 800, reaction: 0.18 },
        ],
        objectives: [{ kind: 'destroy', what: 'hostile', count: 7, countFrom: 'contract', label: 'Destroy 7 hostiles' }],
      },
      { title: 'Report in', objectives: [{ kind: 'dock', label: 'Dock at Wayfarer' }] },
    ],
  },
  {
    id: 'SV-119', title: 'Blackout survey', kind: 'survey', danger: 2, timeLimit: 420,
    kicker: 'Timed · seven minutes',
    brief: 'Three sensor drops before the window closes. The last survey team lost a drone here, and something seeded mines along the line.',
    payout: 7100, requires: ['SR-084'],
    stages: [
      {
        title: 'Drop one',
        onEnter: [{ kind: 'mine', near: { at: 'point', x: -1900, y: 900 }, count: 6, spread: 600 }],
        objectives: [{ kind: 'hold', target: { at: 'point', x: -1900, y: 900 }, radius: 120, speed: 14, seconds: 4, label: 'Hold at drop one' }],
      },
      { title: 'Drop two', objectives: [{ kind: 'hold', target: { at: 'point', x: 2050, y: -1500 }, radius: 120, speed: 14, seconds: 4, label: 'Hold at drop two' }] },
      {
        title: 'Drop three',
        onEnter: [{ kind: 'interceptor', near: { at: 'point', x: 400, y: 1700 }, count: 2, spread: 500 }],
        objectives: [
          { kind: 'hold', target: { at: 'point', x: 400, y: 1700 }, radius: 120, speed: 14, seconds: 4, label: 'Hold at drop three' },
          { kind: 'dock', label: 'Return before the window closes' },
        ],
      },
    ],
  },
  {
    id: 'EC-005', title: 'Walk the hauler home', kind: 'escort', danger: 3,
    kicker: 'Convoy · Wayfarer',
    brief: 'The ore barge Ceres Run is loaded and unarmed, and the lane it has to cross is not empty. Fly with it and bring it in.',
    payout: 11800, requires: ['BT-047'],
    stages: [
      {
        title: 'Escort the barge',
        banner: 'Ceres Run is under way — stay with her',
        escort: {
          id: 'hauler', name: 'Ceres Run', at: { at: 'point', x: -620, y: 720 }, hull: 220,
          route: [{ at: 'point', x: 500, y: 1500 }, { at: 'point', x: 1900, y: 600 }, { at: 'station' }],
        },
        onEnter: [
          { kind: 'raider', near: { at: 'point', x: -600, y: 700 }, count: 2, spread: 900 },
          { kind: 'raider', near: { at: 'point', x: 900, y: 1200 }, count: 2, spread: 900 },
        ],
        objectives: [
          { kind: 'protect', ally: 'hauler', label: 'Keep Ceres Run alive' },
          { kind: 'reach', target: { at: 'station' }, radius: 400, subject: 'ally', ally: 'hauler', label: 'Bring her to Wayfarer' },
          { kind: 'dock', label: 'Dock at Wayfarer' },
        ],
      },
    ],
    bonus: { label: 'Undamaged barge', credits: 3200, objective: { kind: 'protect', ally: 'hauler', label: 'Ceres Run above 60% hull' } },
  },
];
