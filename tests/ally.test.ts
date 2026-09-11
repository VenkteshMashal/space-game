import { describe, expect, test } from 'bun:test';
import { createAlly, stepAlly } from '../src/ally';

const DT = 1 / 120;

describe('ally autopilot', () => {
  test('initializes the hull heading along the first route leg', () => {
    const ally = createAlly('test', 'Barge', { x: 0, y: 0 }, [{ x: 1000, y: 0 }], 220);

    expect(ally.state.angle).toBeCloseTo(-Math.PI / 2);
    stepAlly(ally, DT);
    expect(ally.state.velocity.x).toBeGreaterThan(0);
  });

  test('uses velocity projected onto the route for cruise control', () => {
    const ally = createAlly('test', 'Barge', { x: 0, y: 0 }, [{ x: 1000, y: 0 }], 220);
    ally.state.velocity = { x: 0, y: 140 };

    stepAlly(ally, DT);

    // The barge is moving quickly sideways but has no closing velocity, so it should still burn
    // toward the waypoint.
    expect(ally.state.thrustLevel).toBeGreaterThan(0);
  });

  test('starts braking before an intermediate waypoint using actual acceleration', () => {
    const ally = createAlly('test', 'Barge', { x: 0, y: 0 }, [{ x: 1000, y: 0 }, { x: 2000, y: 0 }], 220);
    ally.state.velocity = { x: 80, y: 0 };

    stepAlly(ally, DT);

    expect(ally.state.velocity.x).toBeLessThan(80);
    expect(ally.state.rcsActive).toBe(true);
  });

  test('bends around an optional nearby obstacle', () => {
    const ally = createAlly('test', 'Barge', { x: 0, y: 0 }, [{ x: 1000, y: 0 }], 220);

    stepAlly(ally, DT, [{ x: 300, y: 0, radius: 100 }]);

    expect(Math.abs(ally.state.velocity.y)).toBeGreaterThan(0);
  });
});
