/**
 * Flight camera (Plan A4). Orthographic XY framing with a mild elevation, so the field reads as a
 * lit plane rather than a top-down schematic. The camera never rotates and never rolls by default:
 * the ship turns, the frame does not.
 *
 * `update` returns the frame it produced and guarantees one invariant — the local hull's bounding
 * circle stays inside the frame with margin, at maximum zoom, maximum look-ahead and full shake.
 * That guarantee is what keeps a fast hull on screen when the pilot cannot afford to lose it.
 */

import * as THREE from 'three';
import type { Vec2 } from '../shared/contracts.ts';

export const FLIGHT_HALF_HEIGHT_M = 365;
export const TACTICAL_HALF_HEIGHT_M = 1060;
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 2;
export const TACTICAL_ZOOM_MIN = 0.35;
export const TACTICAL_ZOOM_MAX = 1.25;
/** Clearance between the hull and the frame edge, as a fraction of the smaller half extent. */
export const FRAME_MARGIN = 0.8;
/** Look-ahead in seconds of velocity, then capped by the frame so the hull cannot leave it. */
export const LEAD_SECONDS = 0.45;
export const MAX_LEAD_FRACTION = 0.45;
export const SHAKE_LIMIT_M = 14;
/** Smoothing rate of the followed point, per second. */
export const FOLLOW_RATE = 4;
/** Camera stand-off: 410 m of elevation over 1100 m of distance is a ~20° tilt. */
export const CAMERA_ELEVATION_M = 410;
export const CAMERA_DISTANCE_M = 1100;
export const NEAR_M = 1;
export const FAR_M = 4500;

export interface CameraFrame {
  /** World point the frame is centred on, after look-ahead and shake. */
  readonly center: Vec2;
  readonly halfWidthM: number;
  readonly halfHeightM: number;
  /** Frame centre minus the followed hull position: look-ahead plus shake. */
  readonly offset: Vec2;
  readonly zoom: number;
  readonly tactical: boolean;
}

export interface CameraInput {
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly hullRadiusM: number;
  readonly dt: number;
  readonly reducedMotion?: boolean;
}

const WIND = { distance: CAMERA_DISTANCE_M, elevation: CAMERA_ELEVATION_M };
/**
 * Screen-up foreshortening of world +Y caused by the elevation: a world offset of `y` metres lands
 * `y * ELEVATION_Y_SCALE` up the frame. Exported because framing budgets are stated in world metres
 * while the frame edge is a screen distance.
 */
export const ELEVATION_Y_SCALE = WIND.distance / Math.hypot(WIND.distance, WIND.elevation);

export class FlightCamera {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, NEAR_M, FAR_M);

  zoom = 1;
  tactical = false;
  /** 0 disables shake entirely, which is the default; settings may raise it or set it back to 0. */
  shake = 0;

  private readonly followed = new THREE.Vector2();
  private ready = false;
  private elapsed = 0;
  private viewWidth = 1;
  private viewHeight = 1;
  private lastFrame: CameraFrame = { center: { x: 0, y: 0 }, halfWidthM: 1, halfHeightM: 1, offset: { x: 0, y: 0 }, zoom: 1, tactical: false };

  constructor(options: { position?: Vec2; zoom?: number; tactical?: boolean } = {}) {
    if (options.position) {
      this.followed.set(options.position.x, options.position.y);
      this.ready = true;
    }
    this.zoom = this.clampZoom(options.zoom ?? 1);
    this.tactical = options.tactical ?? false;
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -CAMERA_ELEVATION_M, CAMERA_DISTANCE_M);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  get frame(): CameraFrame {
    return this.lastFrame;
  }

  get halfHeightM(): number {
    return (this.tactical ? TACTICAL_HALF_HEIGHT_M : FLIGHT_HALF_HEIGHT_M) / this.zoom;
  }

  setViewport(width: number, height: number): void {
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
  }

  get viewportWidth(): number {
    return this.viewWidth;
  }

  get viewportHeight(): number {
    return this.viewHeight;
  }

  /** Absolute zoom, clamped so target and hazard contrast stay legible at both extremes. */
  setZoom(value: number): number {
    this.zoom = this.clampZoom(value);
    return this.zoom;
  }

  nudgeZoom(delta: number): number {
    return this.setZoom(this.zoom + delta);
  }

  setTactical(value: boolean): void {
    this.tactical = value;
    this.zoom = this.clampZoom(this.zoom);
  }

  /** Adjustable to zero: any non-finite or out-of-range request collapses to "no shake". */
  setShake(value: number): number {
    this.shake = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    return this.shake;
  }

  /** The next update jumps instead of easing: used after a respawn, teleport or baseline install. */
  snap(): void {
    this.ready = false;
  }

  update(input: CameraInput): CameraFrame {
    const halfHeightM = this.halfHeightM;
    const halfWidthM = halfHeightM * (this.viewWidth / this.viewHeight);
    this.elapsed += input.dt;

    if (!this.ready) {
      this.followed.set(input.position.x, input.position.y);
      this.ready = true;
    } else {
      const rate = input.reducedMotion ? 1 : 1 - Math.exp(-input.dt * FOLLOW_RATE);
      this.followed.x += (input.position.x - this.followed.x) * rate;
      this.followed.y += (input.position.y - this.followed.y) * rate;
    }

    // Visible extent in world units: x is 1:1, y is foreshortened by the elevation.
    const visibleHalfX = halfWidthM;
    const visibleHalfY = halfHeightM / ELEVATION_Y_SCALE;
    const budget = Math.max(0, FRAME_MARGIN * Math.min(visibleHalfX, visibleHalfY) - input.hullRadiusM);

    // Keep the smoothing lag inside half the budget, so look-ahead and shake still fit.
    const lagX = input.position.x - this.followed.x;
    const lagY = input.position.y - this.followed.y;
    const lag = Math.hypot(lagX, lagY);
    const lagCap = budget * 0.5;
    if (lag > lagCap && lag > 0) {
      const k = lagCap / lag;
      this.followed.x = input.position.x - lagX * k;
      this.followed.y = input.position.y - lagY * k;
    }

    const leadCap = MAX_LEAD_FRACTION * Math.min(visibleHalfX, visibleHalfY);
    const lead = clampVector(input.velocity.x * LEAD_SECONDS, input.velocity.y * LEAD_SECONDS, Math.min(leadCap, budget));
    let offsetX = lead.x;
    let offsetY = lead.y;
    if (this.shake > 0) {
      const shakeX = Math.sin(this.elapsed * 57.3) * SHAKE_LIMIT_M * this.shake;
      const shakeY = Math.cos(this.elapsed * 41.7) * SHAKE_LIMIT_M * this.shake;
      const shaken = clampVector(offsetX + shakeX, offsetY + shakeY, budget);
      offsetX = shaken.x;
      offsetY = shaken.y;
    }

    // Final guard: whatever the lead and shake asked for, the hull's circle stays inside `budget`.
    const hullX = input.position.x - this.followed.x - offsetX;
    const hullY = input.position.y - this.followed.y - offsetY;
    const hullDistance = Math.hypot(hullX, hullY);
    if (hullDistance > budget && hullDistance > 0) {
      const clamped = clampVector(hullX, hullY, budget);
      offsetX = input.position.x - this.followed.x - clamped.x;
      offsetY = input.position.y - this.followed.y - clamped.y;
    }

    const centerX = this.followed.x + offsetX;
    const centerY = this.followed.y + offsetY;
    this.camera.left = -halfWidthM;
    this.camera.right = halfWidthM;
    this.camera.top = halfHeightM;
    this.camera.bottom = -halfHeightM;
    this.camera.position.set(centerX, centerY - CAMERA_ELEVATION_M, CAMERA_DISTANCE_M);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(centerX, centerY, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    this.lastFrame = {
      center: { x: centerX, y: centerY },
      halfWidthM,
      halfHeightM,
      offset: { x: offsetX, y: offsetY },
      zoom: this.zoom,
      tactical: this.tactical,
    };
    return this.lastFrame;
  }

  /** Analytic form of the projection invariant, without touching the camera matrices. */
  containsHull(center: Vec2, radiusM: number): boolean {
    const frame = this.lastFrame;
    const dx = Math.abs(center.x - frame.center.x);
    const dy = Math.abs(center.y - frame.center.y) * ELEVATION_Y_SCALE;
    return dx + radiusM <= frame.halfWidthM && dy + radiusM * ELEVATION_Y_SCALE <= frame.halfHeightM;
  }

  /** Camera roll about the view axis; zero by construction, asserted so a filter cannot add one. */
  roll(): number {
    const elements = this.camera.matrixWorld.elements;
    return Math.atan2(elements[1]!, elements[0]!);
  }

  /** World point -> viewport pixels, for HUD markers and offscreen arrows. */
  project(point: Vec2, z = 0): { x: number; y: number; visible: boolean } {
    const projected = new THREE.Vector3(point.x, point.y, z).project(this.camera);
    return {
      x: ((projected.x + 1) / 2) * this.viewWidth,
      y: ((1 - projected.y) / 2) * this.viewHeight,
      visible: Math.abs(projected.x) < 0.98 && Math.abs(projected.y) < 0.94 && projected.z < 1,
    };
  }

  private clampZoom(value: number): number {
    const min = this.tactical ? TACTICAL_ZOOM_MIN : ZOOM_MIN;
    const max = this.tactical ? TACTICAL_ZOOM_MAX : ZOOM_MAX;
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  }
}

function clampVector(x: number, y: number, max: number): Vec2 {
  const length = Math.hypot(x, y);
  if (length <= max || length === 0) return { x, y };
  const k = max / length;
  return { x: x * k, y: y * k };
}
