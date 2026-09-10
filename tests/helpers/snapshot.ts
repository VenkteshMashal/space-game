/** A representative wire snapshot, shared by the adapter tests so they exercise the real codec. */

import type { Snapshot } from '../../src/shared/contracts.ts';
import { derivedFitFor, fitFor } from './fits.ts';

export function snapshotForTest(epoch = 'epoch-1'): Snapshot {
  const fit = fitFor('kestrel');
  const derived = derivedFitFor('kestrel');
  const ship = (pilotId: string, teamId: string, x: number, y: number, angle: number) => ({
    id: `ship:${pilotId}`,
    pilotId,
    lifeId: `life:${pilotId}:1`,
    teamId,
    position: { x, y },
    velocity: { x: 30, y: 0 },
    angle,
    angularVelocity: 0,
    fit,
    hull: 135,
    hullMax: 135,
    fuelKg: 16000,
    fuelMaxKg: 16000,
    heatMJ: 4,
    heatMaxMJ: 100,
    capacitorMJ: 8,
    life: 'alive' as const,
  });
  return {
    header: { codec: 1, epoch, baselineId: 'baseline-1', stateSeq: 12, tick: 480, eventWatermark: 3, flags: 0 },
    self: {
      tick: 480,
      ship: ship('pilot-1', 'blue', 100, 40, 0.25),
      derived,
      activeInput: null,
      scheduledInputs: [],
      receivedSeq: 12,
      appliedSeq: 12,
      predictionState: {
        tick: 480,
        position: { x: 100, y: 40 },
        velocity: { x: 30, y: 0 },
        angle: 0.25,
        angularVelocity: 0,
        fuelKg: 16000,
        heatMJ: 4,
        capacitorMJ: 8,
        angularAssist: true,
      },
      weapons: [{
        slotId: 'w1',
        partId: 'gun-autocannon',
        group: 0,
        autoDefense: false,
        magazine: 55,
        reserve: 300,
        reloadEndsAtTick: null,
        chargeFraction: 0,
        readyAtTick: 0,
        blockedReason: null,
      }],
    },
    ships: [ship('pilot-1', 'blue', 100, 40, 0.25), ship('pilot-2', 'red', -200, 10, -1)],
    bodies: [{
      id: 'rock-1',
      generation: 1,
      visualId: 'rock-1',
      renderSeed: 7,
      position: { x: 500, y: 0 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      angularVelocity: 0,
      shape: { kind: 'circle', radiusM: 20 },
      collidable: true,
      hull: 90,
      hullMax: 90,
    }],
    projectiles: [],
    contacts: [{ id: 'pilot-2', kind: 'hostile', position: { x: -200, y: 10 }, uncertaintyM: 0, ageTicks: 0, targetable: true }],
    objectives: [],
    teamScores: { blue: 0, red: 0 },
    inventoryRevision: 1,
  };
}
