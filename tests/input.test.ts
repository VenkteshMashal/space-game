import { describe, expect, test } from 'bun:test';
import {
  BindingError,
  DEFAULT_BINDINGS,
  assignBinding,
  bindingConflicts,
  keyLabel,
  sanitizeBindings,
  validateBindings,
} from '../src/input/bindings.ts';
import type { ActionId } from '../src/input/bindings.ts';
import { InputRouter, computeTouchLayout } from '../src/input/router.ts';
import type { PointerSample, Rect, TouchViewport } from '../src/input/touch.ts';
import { EMPTY_FLIGHT_INTENT } from '../src/shared/contracts.ts';

const LANDSCAPE: TouchViewport = { width: 844, height: 390 };
const PORTRAIT: TouchViewport = { width: 390, height: 844 };
const SMALL_LANDSCAPE: TouchViewport = { width: 568, height: 320 };
const SMALL_PORTRAIT: TouchViewport = { width: 320, height: 568 };

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function sample(id: number, x: number, y: number): PointerSample {
  return { id, x, y, pointerType: 'touch' };
}

describe('bindings', () => {
  test('the defaults are conflict-free and reserve browser navigation', () => {
    expect(() => validateBindings(DEFAULT_BINDINGS)).not.toThrow();
    const all = new Set(bindingConflicts(DEFAULT_BINDINGS).map((conflict) => conflict.code));
    expect(all.size).toBe(0);
    expect(DEFAULT_BINDINGS.thrust).toEqual(['KeyW']);
    expect(DEFAULT_BINDINGS.scoreboard).toEqual(['KeyG']);
  });

  test('a duplicate assignment is rejected', () => {
    expect(() => validateBindings({ ...DEFAULT_BINDINGS, turnLeft: ['KeyD'] })).toThrow(BindingError);
    const conflicts = bindingConflicts({ ...DEFAULT_BINDINGS, turnLeft: ['KeyD'] });
    expect(conflicts).toContainEqual({ code: 'KeyD', kind: 'duplicate', actions: ['turnLeft', 'turnRight'] });
  });

  test('Tab and Escape cannot be remapped', () => {
    expect(() => validateBindings({ ...DEFAULT_BINDINGS, map: ['Tab'] })).toThrow(BindingError);
    expect(bindingConflicts({ ...DEFAULT_BINDINGS, help: ['Escape'] })[0]).toMatchObject({ code: 'Escape', kind: 'reserved' });
  });

  test('assignBinding refuses a code another action owns but accepts a free one', () => {
    const mapped = assignBinding(DEFAULT_BINDINGS, 'map', 'KeyJ');
    expect(mapped.map).toContain('KeyJ');
    expect(() => assignBinding(DEFAULT_BINDINGS, 'map', 'KeyW')).toThrow(BindingError);
    expect(() => assignBinding(DEFAULT_BINDINGS, 'map', 'Tab')).toThrow(BindingError);
  });

  test('sanitizing repairs a bad remap instead of throwing', () => {
    const repaired = sanitizeBindings({ thrust: ['KeyS'], map: ['Tab'], brake: ['KeyX', 'KeyX'] });
    expect(repaired.thrust).toEqual(['KeyW']);
    expect(repaired.map).toEqual(['KeyM']);
    expect(repaired.brake).toEqual(['KeyX']);
    expect(() => sanitizeBindings('nonsense')).not.toThrow();
  });

  test('key labels are readable', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Digit3')).toBe('3');
  });
});

describe('keyboard intent', () => {
  test('the frozen A3 keys map to the expected axes', () => {
    const router = new InputRouter();
    router.keyDown('KeyW');
    expect(router.intent().thrust).toBe(1);
    router.keyDown('KeyS');
    expect(router.intent().thrust).toBe(0);
    router.keyUp('KeyS');
    router.keyUp('KeyW');
    router.keyDown('KeyA');
    expect(router.intent().turn).toBe(1);
    router.keyDown('KeyD');
    expect(router.intent().turn).toBe(0);
    router.keyUp('KeyA');
    router.keyUp('KeyD');
    router.keyDown('KeyE');
    expect(router.intent().strafe).toBe(1);
    router.keyDown('KeyQ');
    expect(router.intent().strafe).toBe(0);
    router.keyUp('KeyE');
    router.keyUp('KeyQ');
    router.keyDown('KeyX');
    expect(router.intent().brake).toBe(true);
    router.keyUp('KeyX');
    router.keyDown('ShiftLeft');
    expect(router.intent().boost).toBe(true);
    router.keyUp('ShiftLeft');
    router.keyDown('Space');
    expect(router.intent().fireMask & 1).toBe(1);
    router.keyUp('Space');
    router.keyDown('KeyC');
    expect(router.intent().fireMask & 2).toBe(2);
  });

  test('edge actions fire once and the scoreboard hold ignores key repeat', () => {
    const events: [ActionId, 'press' | 'release'][] = [];
    const router = new InputRouter({ onAction: (action, phase) => events.push([action, phase]) });
    router.keyDown('KeyF');
    router.keyDown('KeyF', true);
    router.keyDown('KeyF', true);
    router.keyUp('KeyF');
    expect(events).toEqual([['interact', 'press']]);

    events.length = 0;
    router.keyDown('KeyG');
    router.keyDown('KeyG', true);
    router.keyDown('KeyG', true);
    expect(events).toEqual([['scoreboard', 'press']]);
    router.keyUp('KeyG');
    expect(events).toEqual([['scoreboard', 'press'], ['scoreboard', 'release']]);
  });

  test('a Space-activated focused button never fires the weapon', () => {
    const router = new InputRouter();
    router.setFocusKind('control');
    expect(router.keyDown('Space')).toBe(true);
    expect(router.intent().fireMask).toBe(0);
    router.keyUp('Space');
    router.setFocusKind('none');
    router.keyDown('Space');
    expect(router.intent().fireMask & 1).toBe(1);
  });

  test('a focused text field receives every key untouched', () => {
    const router = new InputRouter();
    router.setFocusKind('text');
    expect(router.keyDown('KeyW')).toBe(false);
    expect(router.keyDown('Space')).toBe(false);
    expect(router.intent()).toEqual(EMPTY_FLIGHT_INTENT);
    router.setFocusKind('none');
    expect(router.keyDown('KeyW')).toBe(true);
  });

  test('blur and a hidden tab clear keys, pointers and fire and report the reason', () => {
    const reasons: string[] = [];
    const router = new InputRouter({ touchViewport: LANDSCAPE, onRelease: (reason) => reasons.push(reason) });
    const layout = router.touchLayout();
    router.keyDown('KeyW');
    router.keyDown('Space');
    router.pointerDown(sample(1, center(layout.firePrimary).x, center(layout.firePrimary).y));
    expect(router.intent().fireMask).not.toBe(0);

    router.handleBlur();
    expect(reasons).toEqual(['blur']);
    expect(router.intent()).toEqual(EMPTY_FLIGHT_INTENT);

    router.keyDown('KeyW');
    router.handleVisibility(true);
    expect(reasons).toEqual(['blur', 'hidden']);
    expect(router.intent().thrust).toBe(0);
    router.handleVisibility(false);
    expect(reasons.length).toBe(2);

    router.handleOverlay(true);
    router.handleLifeChange();
    expect(reasons).toEqual(['blur', 'hidden', 'overlay', 'life-change']);

    // A pointercancel on the play surface is a full capture loss, not just one finger lifting.
    router.keyDown('KeyW');
    router.pointerDown(sample(1, center(layout.move).x, layout.move.y + 4));
    expect(router.intent().thrust).toBeGreaterThan(0.5);
    router.handlePointerCancel();
    expect(reasons).toEqual(['blur', 'hidden', 'overlay', 'life-change', 'overlay']);
    expect(router.intent()).toEqual(EMPTY_FLIGHT_INTENT);
  });
});

describe('gamepad', () => {
  test('is feature-detected and never blocks the keyboard', () => {
    const router = new InputRouter();
    // Bun has no navigator.getGamepads; absence must be a no-op, not an exception.
    expect(router.pollGamepad()).toBe(false);
    router.keyDown('KeyW');
    expect(router.intent().thrust).toBe(1);
    router.keyDown('Space');
    expect(router.intent().fireMask & 1).toBe(1);
  });
});

describe('touch controls', () => {
  test('every interactive target meets the 44 px minimum at every target size', () => {
    const viewports = [LANDSCAPE, PORTRAIT, SMALL_LANDSCAPE, SMALL_PORTRAIT];
    for (const viewport of viewports) {
      for (const handedness of ['right', 'left'] as const) {
        const layout = computeTouchLayout(viewport, { handedness, aim: 'pad' });
        for (const rect of Object.values(layout)) {
          expect(rect.width).toBeGreaterThanOrEqual(44);
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 0.001);
          expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 0.001);
        }
      }
    }
  });

  test('the left-handed layout mirrors the clusters', () => {
    const right = computeTouchLayout(LANDSCAPE, { handedness: 'right', aim: 'pad' });
    const left = computeTouchLayout(LANDSCAPE, { handedness: 'left', aim: 'pad' });
    expect(right.move.x + right.move.width / 2).toBeLessThan(LANDSCAPE.width / 2);
    expect(left.move.x + left.move.width / 2).toBeGreaterThan(LANDSCAPE.width / 2);
    expect(left.aim.x + left.aim.width / 2).toBeLessThan(LANDSCAPE.width / 2);
  });

  test('two pointers steer and fire at once and release independently', () => {
    const router = new InputRouter({ touchViewport: LANDSCAPE });
    const layout = router.touchLayout();
    const padUp = { x: center(layout.move).x, y: layout.move.y + 4 };
    expect(router.pointerDown(sample(1, padUp.x, padUp.y))).toBe(true);
    expect(router.pointerDown(sample(2, center(layout.firePrimary).x, center(layout.firePrimary).y))).toBe(true);

    const both = router.intent();
    expect(both.thrust).toBeGreaterThan(0.5);
    expect(both.fireMask & 1).toBe(1);

    // Right thumb lifts: fire clears, steering continues.
    router.pointerUp(2);
    const steering = router.intent();
    expect(steering.fireMask).toBe(0);
    expect(steering.thrust).toBeGreaterThan(0.5);

    // Left thumb lifts: the pad recentres.
    router.pointerUp(1);
    expect(router.intent().thrust).toBe(0);
  });

  test('a pointer cancel releases only that pointer', () => {
    const router = new InputRouter({ touchViewport: LANDSCAPE });
    const layout = router.touchLayout();
    router.pointerDown(sample(1, center(layout.move).x, layout.move.y + 4));
    router.pointerDown(sample(2, center(layout.firePrimary).x, center(layout.firePrimary).y));
    router.pointerCancel(2);
    expect(router.intent().fireMask).toBe(0);
    expect(router.intent().thrust).toBeGreaterThan(0.5);
    router.pointerUp(1);
    expect(router.intent().thrust).toBe(0);
  });

  test('a second pointer cannot steal a pad already in use', () => {
    const router = new InputRouter({ touchViewport: LANDSCAPE });
    const layout = router.touchLayout();
    expect(router.pointerDown(sample(1, center(layout.move).x, layout.move.y + 4))).toBe(true);
    expect(router.pointerDown(sample(3, center(layout.move).x, center(layout.move).y))).toBe(false);
    router.pointerUp(1);
    expect(router.pointerDown(sample(3, center(layout.move).x, center(layout.move).y))).toBe(true);
  });

  test('brake, boost, interact and the secondary fire button are reachable', () => {
    const pressed: string[] = [];
    const router = new InputRouter({ touchViewport: LANDSCAPE, onAction: (action) => pressed.push(action) });
    const layout = router.touchLayout();
    expect(router.pointerDown(sample(1, center(layout.brake).x, center(layout.brake).y))).toBe(true);
    expect(router.intent().brake).toBe(true);
    router.pointerUp(1);
    expect(router.intent().brake).toBe(false);

    router.pointerDown(sample(2, center(layout.boost).x, center(layout.boost).y));
    expect(router.intent().boost).toBe(true);
    router.pointerUp(2);

    router.pointerDown(sample(3, center(layout.interact).x, center(layout.interact).y));
    expect(pressed).toEqual(['interact']);
    router.pointerUp(3);

    router.pointerDown(sample(4, center(layout.fireSecondary).x, center(layout.fireSecondary).y));
    expect(router.intent().fireMask & 2).toBe(2);
  });

  test('the aim pad points where the thumb pushes', () => {
    const router = new InputRouter({ touchViewport: LANDSCAPE });
    const layout = router.touchLayout();
    const aim = center(layout.aim);
    router.pointerDown(sample(1, aim.x, aim.y));
    router.pointerMove(sample(1, aim.x + layout.aim.width / 2 - 4, aim.y));
    const intent = router.intent();
    expect(intent.aimWorld).not.toBeNull();
    expect(intent.aimWorld!.x).toBeGreaterThan(0.6);
    expect(Math.abs(intent.aimWorld!.y)).toBeLessThan(0.2);
    router.pointerUp(1);
    expect(router.intent().aimWorld).toBeNull();
  });

  test('lock-to-visible-target cycles a lock instead of free aiming', () => {
    const cycles: number[] = [];
    const router = new InputRouter({
      touchViewport: LANDSCAPE,
      touchAim: 'target',
      onCycleLock: (direction) => cycles.push(direction),
    });
    const layout = router.touchLayout();
    const aim = center(layout.aim);
    router.pointerDown(sample(1, aim.x, aim.y));
    router.pointerMove(sample(1, aim.x + layout.aim.width / 2 - 2, aim.y));
    expect(cycles).toEqual([1]);
    expect(router.intent().aimWorld).toBeNull();
    router.pointerMove(sample(1, aim.x - layout.aim.width / 2 + 2, aim.y));
    expect(cycles).toEqual([1, -1]);
    router.pointerUp(1);
  });
});
