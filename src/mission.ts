import { canRecover, distance, length, RELAY, STATION } from './physics';
import type { Cargo, ShipState } from './physics';

export type MissionStage = 'relay' | 'recover' | 'dock' | 'complete';

export const CONTRACT = { id: 'SR–084', title: 'Ghosts in the belt', archive: 3200, completion: 2800, blackbox: 4200 };

export type ScanSpec = { radius: number; speed: number; seconds: number };
/** A hold-station scan: close to the contact and slow enough for the sensor mast to resolve it. */
export const SCAN: { relay: ScanSpec; archive: ScanSpec; blackbox: ScanSpec } = {
  relay: { radius: 145, speed: 22, seconds: 2.6 },
  archive: { radius: 130, speed: 26, seconds: 3.4 },
  blackbox: { radius: 125, speed: 20, seconds: 4.2 },
};

export function scanSpec(cargo: Cargo): ScanSpec { return cargo.kind === 'blackbox' ? SCAN.blackbox : SCAN.archive; }

export type MissionState = {
  stage: MissionStage;
  scan: Record<string, number>;
  scanned: string[];
  scannedArchives: number;
  payout: number;
};

export type MissionSignal =
  | { type: 'relay' }
  | { type: 'scan'; cargo: Cargo }
  | { type: 'recovered'; cargo: Cargo; remaining: number }
  | { type: 'archives' }
  | { type: 'docked'; payout: number };

export function createMission(): MissionState {
  return { stage: 'relay', scan: {}, scanned: [], scannedArchives: 0, payout: 0 };
}

export function isScanned(mission: MissionState, id: string) { return mission.scanned.includes(id); }

export function remainingArchives(mission: MissionState, cargos: Cargo[]) {
  return cargos.filter(cargo => cargo.kind === 'archive' && !cargo.collected).length;
}

/** Progress of any single scan, 0 at rest and 1 the moment the contact resolves. */
export function scanProgress(mission: MissionState, id: string, spec: ScanSpec) {
  return Math.min(1, (mission.scan[id] ?? 0) / spec.seconds);
}

function accumulate(mission: MissionState, id: string, inRange: boolean, dt: number, seconds: number) {
  const current = mission.scan[id] ?? 0;
  mission.scan[id] = inRange ? current + dt : Math.max(0, current - dt * 1.7);
  return mission.scan[id] >= seconds;
}

/** Advances relay download and contact scans; returns the mission beats that fired this step. */
export function updateMission(mission: MissionState, ship: ShipState, cargos: Cargo[], dt: number): MissionSignal[] {
  const signals: MissionSignal[] = [];
  const speed = length(ship.velocity);
  if (mission.stage === 'relay') {
    const spec = SCAN.relay;
    const inRange = distance(ship.position, RELAY) < spec.radius && speed < spec.speed;
    if (accumulate(mission, 'relay', inRange, dt, spec.seconds)) {
      mission.stage = 'recover';
      signals.push({ type: 'relay' });
    }
    return signals;
  }
  if (mission.stage === 'complete') return signals;
  for (const cargo of cargos) {
    if (cargo.collected || isScanned(mission, cargo.id)) continue;
    const spec = scanSpec(cargo);
    const inRange = distance(ship.position, cargo.position) < spec.radius && speed < spec.speed;
    if (accumulate(mission, cargo.id, inRange, dt, spec.seconds)) {
      mission.scanned.push(cargo.id);
      if (cargo.kind === 'archive') mission.scannedArchives++;
      signals.push({ type: 'scan', cargo });
    }
  }
  return signals;
}

/** The contact the interact control would act on right now, if any. */
export function interactive(mission: MissionState, ship: ShipState, cargos: Cargo[]): Cargo | undefined {
  if (mission.stage === 'relay' || mission.stage === 'complete') return undefined;
  return cargos
    .filter(cargo => isScanned(mission, cargo.id) && canRecover(ship, cargo))
    .sort((a, b) => distance(ship.position, a.position) - distance(ship.position, b.position))[0];
}

export function recoverCargo(mission: MissionState, cargo: Cargo, cargos: Cargo[]): MissionSignal[] {
  if (cargo.collected || !isScanned(mission, cargo.id)) return [];
  cargo.collected = true;
  mission.payout += cargo.kind === 'blackbox' ? CONTRACT.blackbox : CONTRACT.archive;
  const signals: MissionSignal[] = [{ type: 'recovered', cargo, remaining: remainingArchives(mission, cargos) }];
  if (cargo.kind === 'archive' && remainingArchives(mission, cargos) === 0) {
    mission.stage = 'dock';
    signals.push({ type: 'archives' });
  }
  return signals;
}

export function completeDock(mission: MissionState): MissionSignal[] {
  if (mission.stage !== 'dock') return [];
  mission.stage = 'complete';
  mission.payout += CONTRACT.completion;
  return [{ type: 'docked', payout: mission.payout }];
}

export function dockable(mission: MissionState, ship: ShipState) {
  return mission.stage !== 'complete' && distance(ship.position, STATION) < 115 && length(ship.velocity) < 8;
}

/** Where the navigation computer would send a pilot next: unresolved contacts first, then station. */
export function suggestTarget(mission: MissionState, ship: ShipState, cargos: Cargo[]) {
  if (mission.stage === 'relay') return 'relay';
  const pending = cargos
    .filter(cargo => !cargo.collected)
    .sort((a, b) => Number(isScanned(mission, a.id)) - Number(isScanned(mission, b.id))
      || distance(ship.position, a.position) - distance(ship.position, b.position));
  return pending[0]?.id ?? 'station';
}

export function contactName(id: string, cargos: Cargo[]) {
  if (id === 'station') return 'Wayfarer station';
  if (id === 'relay') return 'Nereid relay';
  if (id === 'derelict') return 'Kite’s End';
  return cargos.find(cargo => cargo.id === id)?.name ?? 'No target';
}
