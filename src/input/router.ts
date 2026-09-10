/**
 * Device intent router (Plan A3): keyboard, mouse, pointer and an optional feature-detected
 * gamepad collapse into one `FlightIntent`. It never talks to the authority — `onRelease` is wired
 * by composition to `session.releaseControls`, and it never writes world state. Release is total on
 * blur, hidden tab, overlay, connection/life change: captured keys, pointers, fire and aim reset
 * and the adapter is told why. A focused text field receives every key untouched; a focused
 * Space-activated button keeps its Space, so activating "Ready" never fires the gun.
 */

import type { FlightIntent, Id, SessionPort, Vec2 } from '../shared/contracts.ts';
import {
  ACTION_KINDS,
  FIRE_BITS,
  sanitizeBindings,
  type ActionId,
  type Bindings,
} from './bindings.ts';
import {
  TouchControls,
  type Handedness,
  type PointerSample,
  type TouchAim,
  type TouchLayout,
  type TouchViewport,
} from './touch.ts';

export type ReleaseReason = Parameters<SessionPort['releaseControls']>[0];
export type FocusKind = 'none' | 'text' | 'control';

export interface InputRouterOptions {
  readonly bindings?: Bindings;
  readonly angularAssist?: boolean;
  readonly sensitivity?: number;
  readonly gamepad?: boolean;
  readonly gamepadDeadzone?: number;
  readonly touchViewport?: TouchViewport;
  readonly touchHandedness?: Handedness;
  readonly touchAim?: TouchAim;
  readonly largeControls?: boolean;
  /** Edge actions (`interact`, `reload`, `map`, …) and the scoreboard press/release. */
  readonly onAction?: (action: ActionId, phase: 'press' | 'release') => void;
  readonly onRelease?: (reason: ReleaseReason) => void;
  readonly onCycleLock?: (direction: -1 | 1) => void;
}

interface PadState {
  thrust: number;
  strafe: number;
  turn: number;
  brake: boolean;
  boost: boolean;
  fireMask: number;
  aim: Vec2 | null;
}

const DEFAULT_VIEWPORT: TouchViewport = { width: 844, height: 390 };
const AXIS_DEADZONE = 0.12;

function clampAxis(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function deadzone(value: number, zone: number): number {
  return Math.abs(value) < zone ? 0 : value;
}

function readPad(pad: Gamepad, zone: number): PadState {
  const axis = (index: number) => deadzone(pad.axes[index] ?? 0, zone);
  const lx = axis(0);
  const ly = axis(1);
  const rx = axis(2);
  const ry = axis(3);
  const button = (index: number) => {
    const entry = pad.buttons[index];
    return entry ? entry.pressed || entry.value > 0.5 : false;
  };
  const rxRaw = pad.axes[2] ?? 0;
  const ryRaw = pad.axes[3] ?? 0;
  const aimLength = Math.hypot(rxRaw, ryRaw);
  return {
    thrust: -ly,
    strafe: lx,
    turn: -rx,
    brake: button(1),
    boost: button(0),
    fireMask: (button(7) ? FIRE_BITS.firePrimary : 0) | (button(6) ? FIRE_BITS.fireSecondary : 0),
    aim: aimLength > AXIS_DEADZONE ? { x: rxRaw / aimLength, y: -ryRaw / aimLength } : null,
  };
}

const EMPTY_PAD: PadState = { thrust: 0, strafe: 0, turn: 0, brake: false, boost: false, fireMask: 0, aim: null };

export class InputRouter {
  private bindings: Bindings;
  private assist: boolean;
  private sensitivity: number;
  private gamepadEnabled: boolean;
  private deadzoneValue: number;
  private readonly callbacks: Pick<InputRouterOptions, 'onAction' | 'onRelease' | 'onCycleLock'>;
  private readonly touch: TouchControls;
  private touchOptions: { handedness: Handedness; aim: TouchAim; largeControls: boolean };
  private readonly keys = new Set<string>();
  private padState: PadState | null = null;
  private pointerAim: Vec2 | null = null;
  private mouseFireMask = 0;
  private lockContactId: Id | null = null;
  private focusKind: FocusKind = 'none';

  constructor(options: InputRouterOptions = {}) {
    this.bindings = options.bindings ?? sanitizeBindings(undefined);
    this.assist = options.angularAssist ?? true;
    this.sensitivity = options.sensitivity ?? 1;
    this.gamepadEnabled = options.gamepad ?? true;
    this.deadzoneValue = options.gamepadDeadzone ?? 0.18;
    this.callbacks = { onAction: options.onAction, onRelease: options.onRelease, onCycleLock: options.onCycleLock };
    this.touchOptions = {
      handedness: options.touchHandedness ?? 'right',
      aim: options.touchAim ?? 'pad',
      largeControls: options.largeControls ?? false,
    };
    this.touch = new TouchControls(options.touchViewport ?? DEFAULT_VIEWPORT, this.touchOptions, {
      onInteract: () => this.callbacks.onAction?.('interact', 'press'),
      onCycleLock: (direction) => this.callbacks.onCycleLock?.(direction),
    });
  }

  // --- configuration -------------------------------------------------------------------------

  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
    // Codes held under the old map are meaningless under the new one.
    this.keys.clear();
  }

  setAngularAssist(on: boolean): void {
    this.assist = on;
  }

  setSensitivity(value: number): void {
    this.sensitivity = Math.min(3, Math.max(0.2, value));
  }

  setGamepadEnabled(on: boolean): void {
    this.gamepadEnabled = on;
    if (!on) this.padState = null;
  }

  setFocusKind(kind: FocusKind): void {
    this.focusKind = kind;
  }

  setViewport(viewport: TouchViewport): void {
    this.touch.setLayout(viewport, this.touchOptions);
  }

  setTouchOptions(options: Partial<InputRouterOptions>): void {
    this.touchOptions = {
      handedness: options.touchHandedness ?? this.touchOptions.handedness,
      aim: options.touchAim ?? this.touchOptions.aim,
      largeControls: options.largeControls ?? this.touchOptions.largeControls,
    };
  }

  setAimWorld(aim: Vec2 | null): void {
    this.pointerAim = aim;
  }

  setLockTarget(id: Id | null): void {
    this.lockContactId = id;
  }

  touchLayout(): TouchLayout {
    return this.touch.layoutSnapshot();
  }

  // --- keyboard ------------------------------------------------------------------------------

  /** Returns true when the key was consumed, so the DOM adapter can preventDefault. */
  keyDown(code: string, repeat = false): boolean {
    if (this.focusKind === 'text') return false;
    const action = this.actionFor(code);
    if (!action) return false;
    // A focused button owns Space/Enter: pressing it must not also fire the weapon.
    if (this.focusKind === 'control' && (code === 'Space' || code === 'Enter')) return true;
    if (repeat || this.keys.has(code)) return true;
    this.keys.add(code);
    const kind = ACTION_KINDS[action];
    if (kind === 'edge') this.callbacks.onAction?.(action, 'press');
    else if (action === 'scoreboard') this.callbacks.onAction?.(action, 'press');
    return true;
  }

  keyUp(code: string): void {
    const action = this.actionFor(code);
    if (!action) return;
    if (!this.keys.delete(code)) return;
    if (action === 'scoreboard') this.callbacks.onAction?.(action, 'release');
  }

  /** Mouse buttons are fire, not move; 0 primary, 2 secondary. */
  pointerButton(button: number, down: boolean): boolean {
    const bit = button === 0 ? FIRE_BITS.firePrimary : button === 2 ? FIRE_BITS.fireSecondary : 0;
    if (bit === 0) return false;
    this.mouseFireMask = down ? this.mouseFireMask | bit : this.mouseFireMask & ~bit;
    return true;
  }

  // --- touch / pointer -----------------------------------------------------------------------

  pointerDown(sample: PointerSample): boolean {
    return this.touch.pointerDown(sample);
  }

  pointerMove(sample: PointerSample): void {
    this.touch.pointerMove(sample);
  }

  pointerUp(pointerId: number): void {
    this.touch.pointerUp(pointerId);
  }

  pointerCancel(pointerId: number): void {
    this.touch.pointerCancel(pointerId);
  }

  /**
   * The browser or a system layer took the pointer stream (pointercancel on the play surface).
   * Nothing captured before that can still be trusted, so this is a full release; the reason maps
   * to `overlay` because a layer outside the flight view now owns the gesture.
   */
  handlePointerCancel(): void {
    this.releaseAll('overlay');
  }

  // --- gamepad -------------------------------------------------------------------------------

  private readGamepads(): (Gamepad | null)[] | null {
    if (typeof navigator === 'undefined') return null;
    const getGamepads = (navigator as Navigator).getGamepads;
    if (typeof getGamepads !== 'function') return null;
    try {
      return getGamepads.call(navigator) ?? [];
    } catch {
      return null;
    }
  }

  /** Feature-detected and optional: a missing API or no pad leaves keyboard/touch untouched. */
  pollGamepad(): boolean {
    if (!this.gamepadEnabled) {
      this.padState = null;
      return false;
    }
    const pads = this.readGamepads();
    if (!pads) {
      this.padState = null;
      return false;
    }
    const pad = pads.find((entry) => entry !== null && entry.connected) ?? null;
    this.padState = pad ? readPad(pad, this.deadzoneValue) : null;
    return this.padState !== null;
  }

  // --- intent --------------------------------------------------------------------------------

  private held(action: ActionId): boolean {
    for (const code of this.bindings[action]) if (this.keys.has(code)) return true;
    return false;
  }

  private actionFor(code: string): ActionId | null {
    for (const id of Object.keys(this.bindings) as ActionId[]) {
      if (this.bindings[id].includes(code)) return id;
    }
    return null;
  }

  intent(): FlightIntent {
    const touch = this.touch.snapshot();
    const pad = this.padState ?? EMPTY_PAD;
    const keyboard = {
      thrust: (this.held('thrust') ? 1 : 0) - (this.held('reverse') ? 1 : 0),
      turn: (this.held('turnLeft') ? 1 : 0) - (this.held('turnRight') ? 1 : 0),
      strafe: (this.held('strafeRight') ? 1 : 0) - (this.held('strafeLeft') ? 1 : 0),
    };
    return {
      thrust: clampAxis(keyboard.thrust + touch.thrust + pad.thrust),
      turn: clampAxis(keyboard.turn + touch.turn + pad.turn),
      strafe: clampAxis(keyboard.strafe + touch.strafe + pad.strafe),
      brake: this.held('brake') || touch.brake || pad.brake,
      boost: this.held('boost') || touch.boost || pad.boost,
      angularAssist: this.assist,
      fireMask:
        (this.held('firePrimary') ? FIRE_BITS.firePrimary : 0) |
        (this.held('fireSecondary') ? FIRE_BITS.fireSecondary : 0) |
        this.mouseFireMask |
        touch.fireMask |
        pad.fireMask,
      aimWorld: this.pointerAim ?? touch.aim ?? pad.aim,
      lockContactId: this.lockContactId,
    };
  }

  // --- release -------------------------------------------------------------------------------

  /** Every captured input is dropped; the reason is forwarded for `session.releaseControls`. */
  releaseAll(reason: ReleaseReason): void {
    this.keys.clear();
    this.touch.releaseAll();
    this.padState = null;
    this.pointerAim = null;
    this.mouseFireMask = 0;
    this.lockContactId = null;
    this.callbacks.onRelease?.(reason);
  }

  handleBlur(): void {
    this.releaseAll('blur');
  }

  handleVisibility(hidden: boolean): void {
    if (hidden) this.releaseAll('hidden');
  }

  /** Overlay opened (menu/settings/map): release, keep navigation keys to the UI. */
  handleOverlay(open: boolean): void {
    if (open) this.releaseAll('overlay');
  }

  handleLifeChange(): void {
    this.releaseAll('life-change');
  }
}

export function createInputRouter(options: InputRouterOptions = {}): InputRouter {
  return new InputRouter(options);
}

// ---------------------------------------------------------------------------------------------
// DOM adapter. The only part of this module that touches the document; tests drive the router
// with synthetic samples and never load it.
// ---------------------------------------------------------------------------------------------

function focusKindOf(element: Element | null): FocusKind {
  if (!element) return 'none';
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'text';
  if ((element as HTMLElement).isContentEditable === true) return 'text';
  if (tag === 'BUTTON' || element.closest('button,[role="button"],a[href],summary') !== null) return 'control';
  return 'none';
}

export interface AttachInputOptions {
  readonly window?: Window;
  readonly element?: HTMLElement;
  readonly safeInsets?: Partial<TouchViewport>;
  /** Screen point (CSS px within the play element) -> world aim; null leaves aim unchanged. */
  readonly mapAim?: (point: { x: number; y: number; width: number; height: number }) => Vec2 | null;
}

export function attachInput(router: InputRouter, options: AttachInputOptions = {}): () => void {
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window);
  if (!win) return () => undefined;
  const doc = win.document;
  const element = options.element ?? doc.body;

  const sampleOf = (event: PointerEvent): PointerSample => {
    const rect = element.getBoundingClientRect();
    return {
      id: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      button: event.button,
      pointerType: event.pointerType,
    };
  };

  const updateViewport = (): void => {
    const rect = element.getBoundingClientRect();
    router.setViewport({ width: rect.width || element.clientWidth, height: rect.height || element.clientHeight, ...options.safeInsets });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    router.setFocusKind(focusKindOf((event.target as Element | null) ?? doc.activeElement));
    if (router.keyDown(event.code, event.repeat)) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => router.keyUp(event.code);
  const onFocusIn = (event: FocusEvent): void => router.setFocusKind(focusKindOf(event.target as Element | null));
  const onBlur = (): void => router.handleBlur();
  const onVisibility = (): void => router.handleVisibility(doc.hidden);

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') {
      router.pointerButton(event.button, true);
      return;
    }
    if (router.pointerDown(sampleOf(event))) {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        /* Capture is best-effort; ownership above already isolates the pointer. */
      }
      event.preventDefault();
    }
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') {
      if (!options.mapAim) return;
      const rect = element.getBoundingClientRect();
      const aim = options.mapAim({ x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height });
      if (aim) router.setAimWorld(aim);
      return;
    }
    router.pointerMove(sampleOf(event));
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') {
      router.pointerButton(event.button, false);
      return;
    }
    router.pointerUp(event.pointerId);
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released. */
    }
  };
  const onPointerCancel = (): void => router.handlePointerCancel();

  updateViewport();
  win.addEventListener('resize', updateViewport);
  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('visibilitychange', onVisibility);
  element.addEventListener('pointerdown', onPointerDown, { passive: false });
  element.addEventListener('pointermove', onPointerMove, { passive: true });
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);

  return () => {
    win.removeEventListener('resize', updateViewport);
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('visibilitychange', onVisibility);
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerCancel);
  };
}

/** Exposed for the layout tests: a viewport plus options in, hit-testable rects out. */
export { computeTouchLayout } from './touch.ts';
