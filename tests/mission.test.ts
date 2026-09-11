import { describe, expect, test } from 'bun:test';
import { createCargo, createShip, RELAY, STATION } from '../src/physics';
import type { Cargo, ShipState } from '../src/physics';
import { CONTRACT, SCAN, completeDock, createMission, dockable, interactive, recoverCargo, scanProgress, suggestTarget, updateMission } from '../src/mission';
import type { MissionSignal, MissionState } from '../src/mission';

const DT = 1 / 120;

function holdStation(mission: MissionState, ship: ShipState, cargos: Cargo[], position: { x: number; y: number }, seconds: number, speed = 0) {
  ship.position = { ...position };
  ship.velocity = { x: speed, y: 0 };
  const signals: MissionSignal[] = [];
  for (let i = 0; i < Math.round(seconds * 120); i++) signals.push(...updateMission(mission, ship, cargos, DT));
  return signals;
}

function scannedArchive(mission: MissionState, ship: ShipState, cargos: Cargo[], index: number) {
  holdStation(mission, ship, cargos, RELAY, SCAN.relay.seconds + 0.2);
  holdStation(mission, ship, cargos, cargos[index].position, SCAN.archive.seconds + 0.2);
  return cargos[index];
}

describe('staged contract', () => {
  test('archive contacts stay unresolved until the relay telemetry is pulled', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    holdStation(mission, ship, cargos, cargos[0].position, SCAN.archive.seconds + 1);
    expect(mission.stage).toBe('relay');
    expect(mission.scanned).toEqual([]);
    expect(interactive(mission, ship, cargos)).toBeUndefined();
  });

  test('holding station at the relay downloads telemetry and opens the recovery stage', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    holdStation(mission, ship, cargos, RELAY, SCAN.relay.seconds - 0.4);
    expect(mission.stage).toBe('relay');
    const signals = holdStation(mission, ship, cargos, RELAY, 0.6);
    expect(signals.map(signal => signal.type)).toContain('relay');
    expect(mission.stage).toBe('recover');
  });

  test('a scan needs both range and a slow approach, and decays when either is lost', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    holdStation(mission, ship, cargos, RELAY, SCAN.relay.seconds + 0.2);
    holdStation(mission, ship, cargos, cargos[0].position, SCAN.archive.seconds / 2);
    const partial = scanProgress(mission, cargos[0].id, SCAN.archive);
    expect(partial).toBeGreaterThan(0.4);
    holdStation(mission, ship, cargos, { x: cargos[0].position.x, y: cargos[0].position.y + 900 }, 1);
    expect(scanProgress(mission, cargos[0].id, SCAN.archive)).toBeLessThan(partial);
    holdStation(mission, ship, cargos, cargos[0].position, SCAN.archive.seconds, SCAN.archive.speed + 10);
    expect(mission.scanned).not.toContain(cargos[0].id);
  });

  test('recovery is gated on a completed scan, proximity and a safe closing speed', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    const cargo = scannedArchive(mission, ship, cargos, 0);
    expect(mission.scanned).toContain(cargo.id);
    ship.position = { x: cargo.position.x + 400, y: cargo.position.y };
    expect(interactive(mission, ship, cargos)).toBeUndefined();
    ship.position = { ...cargo.position }; ship.velocity = { x: 14, y: 0 };
    expect(interactive(mission, ship, cargos)).toBeUndefined();
    ship.velocity = { x: 0, y: 0 };
    expect(interactive(mission, ship, cargos)?.id).toBe(cargo.id);
    const signals = recoverCargo(mission, cargo, cargos);
    expect(signals[0].type).toBe('recovered');
    expect(cargo.collected).toBe(true);
    expect(mission.payout).toBe(CONTRACT.archive);
    expect(mission.stage).toBe('recover');
  });

  test('the contract docks only after all three archives and then pays the completion fee', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    for (let index = 0; index < 3; index++) {
      const cargo = scannedArchive(mission, ship, cargos, index);
      recoverCargo(mission, cargo, cargos);
    }
    expect(mission.stage).toBe('dock');
    expect(mission.payout).toBe(CONTRACT.archive * 3);
    ship.position = { ...STATION }; ship.velocity = { x: 9, y: 0 };
    expect(dockable(mission, ship)).toBe(false);
    ship.velocity = { x: 0, y: 0 };
    expect(dockable(mission, ship)).toBe(true);
    const signals = completeDock(mission);
    expect(signals[0]).toEqual({ type: 'docked', payout: CONTRACT.archive * 3 + CONTRACT.completion });
    expect(mission.stage).toBe('complete');
    expect(completeDock(mission)).toEqual([]);
  });

  test('the black box is optional salvage that never blocks contract completion', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    const blackbox = cargos.find(cargo => cargo.kind === 'blackbox')!;
    holdStation(mission, ship, cargos, RELAY, SCAN.relay.seconds + 0.2);
    holdStation(mission, ship, cargos, blackbox.position, SCAN.blackbox.seconds + 0.2);
    expect(mission.scanned).toContain(blackbox.id);
    recoverCargo(mission, blackbox, cargos);
    expect(mission.payout).toBe(CONTRACT.blackbox);
    expect(mission.stage).toBe('recover');
    expect(dockable(mission, ship)).toBe(false);
  });

  test('navigation points at the relay first, then the nearest unresolved contact', () => {
    const mission = createMission(), ship = createShip(), cargos = createCargo();
    expect(suggestTarget(mission, ship, cargos)).toBe('relay');
    holdStation(mission, ship, cargos, RELAY, SCAN.relay.seconds + 0.2);
    const nearest = [...cargos].filter(cargo => cargo.kind === 'archive').sort((a, b) => Math.hypot(a.position.x, a.position.y) - Math.hypot(b.position.x, b.position.y))[0];
    expect(suggestTarget(mission, ship, cargos)).toBe(nearest.id);
  });
});
