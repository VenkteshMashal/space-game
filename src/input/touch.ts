/**
 * Touch flight controls (Plan A3). Pure geometry and pointer bookkeeping: no DOM, no globals, so
 * the router can be driven by synthetic pointer samples in tests. One pointer owns exactly one
 * control from pointer-down to its own pointer-up/cancel, which is what lets a left thumb steer
 * while a right thumb fires and releases independently. Phone input obeys the same server rules as
 * keyboard input; nothing here grants extra range, damage or aim.
 */

import type { Vec2 } from '../shared/contracts.ts';

export type Handedness = 'right' | 'left';
export type TouchAim = 'pad' | 'target';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TouchViewport {
  readonly width: number;
  readonly height: number;
  readonly insetTop?: number;
  readonly insetRight?: number;
  readonly insetBottom?: number;
  readonly insetLeft?: number;
}

export type TouchControlId = 'move' | 'turn' | 'aim' | 'firePrimary' | 'fireSecondary' | 'brake' | 'interact' | 'boost';
export type TouchLayout = Readonly<Record<TouchControlId, Rect>>;

export interface TouchLayoutOptions {
  readonly handedness: Handedness;
  readonly aim: TouchAim;
  readonly largeControls?: boolean;
}

export interface PointerSample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly pointerType?: string;
}

export interface TouchSnapshot {
  readonly thrust: number;
  readonly strafe: number;
  readonly turn: number;
  readonly brake: boolean;
  readonly boost: boolean;
  readonly fireMask: number;
  readonly aim: Vec2 | null;
}

export interface TouchHooks {
  /** Interact is edge-triggered: one press per touch-down, never on key repeat or drag. */
  readonly onInteract?: () => void;
  /** Aim pad in lock-to-visible-target mode cycles the lock instead of pointing freely. */
  readonly onCycleLock?: (direction: -1 | 1) => void;
}

const GAP = 8;
const MARGIN = GAP + 4;
const MIN_TARGET = 44;
const PAD_FACTOR = 0.36;
const MOVE_DEADZONE = 0.15;
const AIM_DEADZONE = 0.12;
const TURN_DEADZONE = 0.08;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** Landscape-first layout; every interactive target stays at or above 44 px. */
export function computeTouchLayout(viewport: TouchViewport, options: TouchLayoutOptions): TouchLayout {
  const insetLeft = viewport.insetLeft ?? 0;
  const insetRight = viewport.insetRight ?? 0;
  const insetBottom = viewport.insetBottom ?? 0;
  const scale = options.largeControls ? 1.15 : 1;
  const short = Math.min(viewport.width, viewport.height);
  let pad = clamp(short * PAD_FACTOR, 108, 180) * scale;
  let small = clamp(pad * 0.34, 48, 64);
  let fire = clamp(pad * 0.44, 52, 76);
  const turnHeight = clamp(pad * 0.3, MIN_TARGET, 58) * scale;
  // Two pads, one centre utility column and the gaps must always fit between the safe insets.
  pad = Math.max(96, Math.min(pad, (viewport.width - 2 * MARGIN - small - 2 * GAP) / 2));
  small = Math.min(small, pad * 0.5);
  fire = Math.min(fire, pad * 0.55);

  const left = insetLeft + MARGIN;
  const right = viewport.width - insetRight - MARGIN;
  const bottom = viewport.height - insetBottom - MARGIN;
  const center = viewport.width / 2;

  const rects: Record<TouchControlId, Rect> = {
    move: { x: left, y: bottom - pad, width: pad, height: pad },
    turn: { x: left, y: bottom - pad - GAP - turnHeight, width: pad, height: turnHeight },
    boost: { x: center - small / 2, y: bottom - small, width: small, height: small },
    brake: { x: center - small / 2, y: bottom - small * 2 - GAP, width: small, height: small },
    interact: { x: center - small / 2, y: bottom - small * 3 - GAP * 2, width: small, height: small },
    aim: { x: right - pad, y: bottom - pad, width: pad, height: pad },
    firePrimary: { x: right - fire, y: bottom - pad - GAP - fire, width: fire, height: fire },
    fireSecondary: { x: right - fire * 2 - GAP, y: bottom - pad - GAP - fire, width: fire, height: fire },
  };

  if (options.handedness === 'left') {
    for (const id of Object.keys(rects) as TouchControlId[]) {
      const rect = rects[id];
      rects[id] = { ...rect, x: viewport.width - rect.x - rect.width };
    }
  }
  return rects;
}

/** Fire group bits mirror `FIRE_BITS`; touch uses the same mask as the keyboard. */
const TOUCH_FIRE_PRIMARY = 1 << 0;
const TOUCH_FIRE_SECONDARY = 1 << 1;

/**
 * Pointer bookkeeping for the layout above. Absolute pads (origin = pad centre) because a pilot
 * re-finds a fixed pad by feel; the aim pad points, or cycles a lock when lock-to-target is on.
 */
export class TouchControls {
  private layout: TouchLayout;
  private options: TouchLayoutOptions;
  private readonly hooks: TouchHooks;
  private readonly owners = new Map<number, TouchControlId>();
  private readonly move = { x: 0, y: 0 };
  private turnValue = 0;
  private aimValue: Vec2 | null = null;
  private readonly held: Record<'firePrimary' | 'fireSecondary' | 'brake' | 'boost', boolean> = {
    firePrimary: false,
    fireSecondary: false,
    brake: false,
    boost: false,
  };
  /** Last lock-cycle direction emitted by the aim pad, so one drag cycles once. */
  private lockDirection = 0;

  constructor(viewport: TouchViewport, options: TouchLayoutOptions, hooks: TouchHooks = {}) {
    this.options = options;
    this.hooks = hooks;
    this.layout = computeTouchLayout(viewport, options);
  }

  setLayout(viewport: TouchViewport, options: TouchLayoutOptions = this.options): void {
    this.options = options;
    this.layout = computeTouchLayout(viewport, options);
    this.releaseAll();
  }

  layoutSnapshot(): TouchLayout {
    return this.layout;
  }

  /** Hit-test order puts the small time-critical buttons above the pads. */
  private controlAt(x: number, y: number): TouchControlId | null {
    const order: readonly TouchControlId[] = ['firePrimary', 'fireSecondary', 'interact', 'brake', 'boost', 'aim', 'turn', 'move'];
    for (const id of order) if (contains(this.layout[id], x, y)) return id;
    return null;
  }

  pointerDown(sample: PointerSample): boolean {
    const control = this.controlAt(sample.x, sample.y);
    if (!control) return false;
    if (this.owners.has(sample.id)) return false;
    // One pointer per control: a second finger on the same pad is ignored, never merged.
    for (const owned of this.owners.values()) if (owned === control) return false;
    this.owners.set(sample.id, control);
    switch (control) {
      case 'move':
        this.setPadVector(sample, MOVE_DEADZONE);
        break;
      case 'aim':
        this.lockDirection = 0;
        if (this.options.aim === 'target') this.updateLockDrag(sample);
        else this.setAimVector(sample);
        break;
      case 'turn':
        this.setTurn(sample);
        break;
      case 'interact':
        this.hooks.onInteract?.();
        break;
      case 'firePrimary':
      case 'fireSecondary':
      case 'brake':
      case 'boost':
        this.held[control] = true;
        break;
    }
    return true;
  }

  pointerMove(sample: PointerSample): void {
    const control = this.owners.get(sample.id);
    if (!control) return;
    switch (control) {
      case 'move':
        this.setPadVector(sample, MOVE_DEADZONE);
        break;
      case 'aim':
        if (this.options.aim === 'target') this.updateLockDrag(sample);
        else this.setAimVector(sample);
        break;
      case 'turn':
        this.setTurn(sample);
        break;
      default:
        break;
    }
  }

  /** Release only the control this pointer owned. Other pointers keep flying. */
  pointerUp(pointerId: number): void {
    const control = this.owners.get(pointerId);
    if (!control) return;
    this.owners.delete(pointerId);
    switch (control) {
      case 'move':
        this.move.x = 0;
        this.move.y = 0;
        break;
      case 'aim':
        this.aimValue = null;
        this.lockDirection = 0;
        break;
      case 'turn':
        this.turnValue = 0;
        break;
      case 'firePrimary':
      case 'fireSecondary':
      case 'brake':
      case 'boost':
        this.held[control] = false;
        break;
    }
  }

  pointerCancel(pointerId: number): void {
    this.pointerUp(pointerId);
  }

  releaseAll(): void {
    this.owners.clear();
    this.move.x = 0;
    this.move.y = 0;
    this.turnValue = 0;
    this.aimValue = null;
    this.lockDirection = 0;
    this.held.firePrimary = false;
    this.held.fireSecondary = false;
    this.held.brake = false;
    this.held.boost = false;
  }

  snapshot(): TouchSnapshot {
    return {
      thrust: this.move.y,
      strafe: this.move.x,
      turn: this.turnValue,
      brake: this.held.brake,
      boost: this.held.boost,
      fireMask: (this.held.firePrimary ? TOUCH_FIRE_PRIMARY : 0) | (this.held.fireSecondary ? TOUCH_FIRE_SECONDARY : 0),
      aim: this.options.aim === 'target' ? null : this.aimValue,
    };
  }

  private setPadVector(sample: PointerSample, deadzone: number): void {
    const rect = this.layout.move;
    const dx = (sample.x - (rect.x + rect.width / 2)) / (rect.width / 2);
    const dy = (sample.y - (rect.y + rect.height / 2)) / (rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len < deadzone) {
      this.move.x = 0;
      this.move.y = 0;
      return;
    }
    const scale = Math.min(1, len) / len;
    // Screen-up is forward: thrust positive, strafe right positive (matches E in the legacy loop).
    this.move.x = clamp(dx * scale, -1, 1);
    this.move.y = clamp(-dy * scale, -1, 1);
  }

  private setAimVector(sample: PointerSample): void {
    const rect = this.layout.aim;
    const dx = (sample.x - (rect.x + rect.width / 2)) / (rect.width / 2);
    const dy = (sample.y - (rect.y + rect.height / 2)) / (rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len < AIM_DEADZONE) {
      this.aimValue = null;
      return;
    }
    const scale = Math.min(1, len) / len;
    // World: angle zero faces +Y, so screen-up is +Y.
    this.aimValue = { x: clamp(dx * scale, -1, 1), y: clamp(-dy * scale, -1, 1) };
  }

  private setTurn(sample: PointerSample): void {
    const rect = this.layout.turn;
    const value = clamp((sample.x - (rect.x + rect.width / 2)) / (rect.width / 2), -1, 1);
    this.turnValue = Math.abs(value) < TURN_DEADZONE ? 0 : value;
  }

  private updateLockDrag(sample: PointerSample): void {
    const rect = this.layout.aim;
    const value = clamp((sample.x - (rect.x + rect.width / 2)) / (rect.width / 2), -1, 1);
    const direction = value > 0.4 ? 1 : value < -0.4 ? -1 : 0;
    if (direction !== 0 && direction !== this.lockDirection) this.hooks.onCycleLock?.(direction as -1 | 1);
    this.lockDirection = direction;
  }
}
