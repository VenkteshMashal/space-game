/**
 * Prediction and interpolation rules from Plan B4. These assert what a player would observe — no
 * teleporting for small corrections, a clean snap for a real discontinuity, and remote ships that
 * coast to a halt rather than inventing motion when the stream stops.
 */

import { describe, expect, test } from 'bun:test';
import { derivedFitFor } from './helpers/fits.ts';
import type { FlightIntent, PredictionState } from '../src/shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../src/shared/contracts.ts';
import { Predictor, RemoteInterpolator, SNAP_DISTANCE_M, renderTickFor, shortestAngleDelta } from '../src/client/session/prediction.ts';

const derived = derivedFitFor('kestrel');
const priority = ['engine', 'reactor', 'sensor', 'utility', 'weapon', 'armor'] as const;

function stateAt(tick: number, x: number, y = 0, velocityX = 0): PredictionState {
  return {
    tick,
    position: { x, y },
    velocity: { x: velocityX, y: 0 },
    angle: 0,
    angularVelocity: 0,
    fuelKg: derived.fuelCapacityKg,
    heatMJ: 0,
    capacitorMJ: derived.capacitorMJ,
    angularAssist: true,
  };
}

const intent = (patch: Partial<FlightIntent>): FlightIntent => ({ ...EMPTY_FLIGHT_INTENT, ...patch });

describe('predictor', () => {
  test('two predictors fed the same history and inputs agree exactly', () => {
    const run = (): PredictionState | null => {
      const predictor = new Predictor(derived, priority);
      predictor.setLife('life:1', 'epoch:1');
      predictor.reconcile(stateAt(10, 0, 0, 100), 1, null);
      predictor.recordInput({ seq: 2, applyAtTick: 12, intent: intent({ thrust: 1 }) });
      return predictor.predict(20, intent({ turn: 0.5 }));
    };
    expect(run()).toEqual(run());
  });

  test('a predicted frame continues the ship past the newest authoritative tick', () => {
    const predictor = new Predictor(derived, priority);
    predictor.setLife('life:1', 'epoch:1');
    predictor.reconcile(stateAt(10, 0, 0, 100), 1, null);
    const predicted = predictor.predict(10 + RELEASE.physicsHz, intent({ thrust: 1 }))!;
    expect(predicted.tick).toBe(10 + RELEASE.physicsHz);
    expect(Math.hypot(predicted.velocity.x, predicted.velocity.y)).toBeGreaterThan(100);
  });

  test('it predicts nothing before the first authoritative sample', () => {
    const predictor = new Predictor(derived, priority);
    expect(predictor.predict(100, null)).toBeNull();
    expect(predictor.latest()).toBeNull();
  });

  test('a small correction slides instead of teleporting, and is gone within a fifth of a second', () => {
    const predictor = new Predictor(derived, priority);
    predictor.setLife('life:1', 'epoch:1');
    predictor.reconcile(stateAt(10, 0), 1, null);
    const previous = stateAt(12, 3);
    const outcome = predictor.reconcile(stateAt(11, 0), 2, previous);
    expect(outcome.snapped).toBe(false);
    const rendered = predictor.renderPosition(stateAt(11, 0));
    expect(rendered.x).toBeCloseTo(3, 6);
    for (let tick = 0; tick < Math.ceil(0.2 * RELEASE.physicsHz); tick++) predictor.decay(1 / RELEASE.physicsHz);
    expect(predictor.renderPosition(stateAt(11, 0)).x).toBeLessThan(0.5);
    for (let tick = 0; tick < RELEASE.physicsHz; tick++) predictor.decay(1 / RELEASE.physicsHz);
    expect(predictor.correcting()).toBe(false);
  });

  test('a teleport, a life change and an out-of-order snapshot all snap', () => {
    const predictor = new Predictor(derived, priority);
    predictor.setLife('life:1', 'epoch:1');
    predictor.reconcile(stateAt(10, 0), 1, null);
    expect(predictor.reconcile(stateAt(11, SNAP_DISTANCE_M + 5), 2, stateAt(11, 0)).snapped).toBe(true);
    expect(predictor.correcting()).toBe(false);
    expect(predictor.setLife('life:2', 'epoch:1')).toBe(true);
    expect(predictor.latest()).toBeNull();
    predictor.reconcile(stateAt(10, 0), 1, null);
    expect(predictor.reconcile(stateAt(9, 0), 2, stateAt(10, 0)).snapped).toBe(true);
  });

  test('acknowledged inputs stop replaying, so the prediction settles on the authority', () => {
    const predictor = new Predictor(derived, priority);
    predictor.setLife('life:1', 'epoch:1');
    predictor.recordInput({ seq: 5, applyAtTick: 11, intent: intent({ thrust: 1 }) });
    predictor.recordInput({ seq: 6, applyAtTick: 12, intent: intent({ thrust: 1 }) });
    predictor.reconcile(stateAt(12, 0, 0, 50), 6, null);
    const settled = predictor.predict(12, null)!;
    expect(settled.velocity.x).toBeCloseTo(50, 6);
  });
});

describe('remote interpolation', () => {
  test('two samples are interpolated at the midpoint of the render time', () => {
    const remote = new RemoteInterpolator();
    remote.push({ tick: 100, position: { x: 0, y: 0 }, velocity: { x: 60, y: 0 }, angle: 0 });
    remote.push({ tick: 104, position: { x: 2, y: 0 }, velocity: { x: 60, y: 0 }, angle: 0 });
    const mid = remote.sample(102)!;
    expect(mid.position.x).toBeCloseTo(1, 6);
    expect(mid.extrapolated).toBe(false);
    expect(mid.stale).toBe(false);
  });

  test('a gap in the stream is extrapolated briefly and then held, never invented', () => {
    const remote = new RemoteInterpolator();
    remote.push({ tick: 100, position: { x: 0, y: 0 }, velocity: { x: 120, y: 0 }, angle: 0 });
    const near = remote.sample(100 + Math.round(0.05 * RELEASE.physicsHz))!;
    expect(near.extrapolated).toBe(true);
    expect(near.position.x).toBeCloseTo(6, 4);
    const far = remote.sample(100 + Math.round(0.4 * RELEASE.physicsHz))!;
    expect(far.stale).toBe(true);
    expect(far.position.x).toBe(0);
  });

  test('the render delay adapts to jitter inside 50–150 ms without oscillating', () => {
    const remote = new RemoteInterpolator();
    expect(remote.delayMs).toBe(100);
    remote.adapt(5);
    expect(remote.delayMs).toBe(100);
    remote.adapt(60);
    expect(remote.delayMs).toBeGreaterThan(100);
    expect(remote.delayMs).toBeLessThanOrEqual(150);
    for (let i = 0; i < 20; i++) remote.adapt(60);
    expect(remote.delayMs).toBe(150);
    for (let i = 0; i < 20; i++) remote.adapt(-80);
    expect(remote.delayMs).toBe(50);
  });

  test('an out-of-order or duplicate sample is ignored and history stays bounded', () => {
    const remote = new RemoteInterpolator();
    remote.push({ tick: 10, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: 0 });
    remote.push({ tick: 10, position: { x: 99, y: 0 }, velocity: { x: 0, y: 0 }, angle: 0 });
    expect(remote.sample(10)!.position.x).toBe(0);
    for (let tick = 11; tick < 200; tick++) remote.push({ tick, position: { x: tick, y: 0 }, velocity: { x: 0, y: 0 }, angle: 0 });
    expect(remote.size()).toBeLessThanOrEqual(64);
  });

  test('angle interpolation takes the short way around the wrap', () => {
    expect(shortestAngleDelta(3.0, -3.0)).toBeGreaterThan(0);
    const remote = new RemoteInterpolator();
    remote.push({ tick: 0, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: 3.1 });
    remote.push({ tick: 10, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, angle: -3.1 });
    const mid = remote.sample(5)!;
    expect(Math.abs(mid.angle)).toBeGreaterThan(3.1);
  });

  test('render time sits behind the newest authoritative tick by the delay', () => {
    expect(renderTickFor(300, 100)).toBeCloseTo(288, 6);
    expect(renderTickFor(300, 50)).toBeCloseTo(294, 6);
  });
});
