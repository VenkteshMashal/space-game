/**
 * The collar — plan-hud.md H2.
 *
 * A hairline bearing ring around the ship's screen position, with the marks that
 * hang off it: velocity notch, target caret and range numeral, hostile ticks,
 * contact and ore dots, and the bottom drive arc. Immediate-mode canvas in the
 * same shape as `radar.ts`.
 *
 * `--void #070d15` is deliberately never painted: the element is a transparent
 * overlay above `#space-canvas`, and a mark is drawn only where data exists.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// Palette — plan-hud.md tokens, verbatim.
const ETCH = '#dce6e8';
const ETCH_DIM = '#8195a2';
const NAV = '#83b9b5';
const DRIVE = '#efb879';
const THREAT = '#df8277';

const TOP = -Math.PI / 2;
const BOTTOM = Math.PI / 2;
const RING_WIDTH = 1;
const RING_ALPHA = 0.4;
const GAP_HALF = 20 * DEG;          // 40° of bare glass centred on the top
const ARC_HALF = 70 * DEG;          // the bottom 140°
const ARC_WIDTH = 3;
const ARC_ALPHA = 0.16;             // dormant extent of the throttle scale
const THRUST_MAX = 1.65;            // frame.thrust full range
const RETRO_MAX = 0.28;
const OVERHEAT = 0.92;
const PULSE_RATE = TAU / 1.6;       // matches the CSS `caution` beat
const PULSE_FLOOR = 0.55;

const VELOCITY_HALF = 4.5;
const VELOCITY_WIDTH = 2;
const TARGET_OUT = 3.5;
const TARGET_ARM = 4.5;
const TARGET_WIDTH = 1.6;
const HOSTILE_MIN = 4;
const HOSTILE_SPAN = 11;
const HOSTILE_WIDTH = 1.6;
const CONTACT_RADIUS = 2;
const ORE_RADIUS = 1.3;

const FAR_RANGE = 2000;             // metres; beyond this a mark is context
const FAR_ALPHA = 0.35;
const LABEL_RADIUS = 15;            // numeral distance outside the ring
const LABEL_ALIGN_COS = 0.25;       // past this the numeral hangs off its own arc
const FONT_NUMERAL = "12px 'Barlow Condensed', sans-serif";

const HEAT_STEPS = 32;
const HEAT_STOPS: string[] = [];

function channels(hex: string): number[] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const DRIVE_CHANNELS = channels(DRIVE);
const THREAT_CHANNELS = channels(THREAT);
for (let step = 0; step <= HEAT_STEPS; step++) {
  const t = step / HEAT_STEPS;
  const r = Math.round(DRIVE_CHANNELS[0] + (THREAT_CHANNELS[0] - DRIVE_CHANNELS[0]) * t);
  const g = Math.round(DRIVE_CHANNELS[1] + (THREAT_CHANNELS[1] - DRIVE_CHANNELS[1]) * t);
  const b = Math.round(DRIVE_CHANNELS[2] + (THREAT_CHANNELS[2] - DRIVE_CHANNELS[2]) * t);
  HEAT_STOPS.push(`rgb(${r}, ${g}, ${b})`);
}

const RANGE_CACHE_SIZE = 16;
const rangeKeys = new Int32Array(RANGE_CACHE_SIZE).fill(-1);
const rangeTexts: string[] = new Array(RANGE_CACHE_SIZE).fill('');
let rangeCursor = 0;

/** Whole metres, memoised in a fixed ring so a settled target allocates nothing. */
function rangeNumeral(metres: number): string {
  const safe = Number.isFinite(metres) ? metres : 0;
  const value = Math.min(99999, Math.max(0, Math.round(safe)));
  for (let i = 0; i < RANGE_CACHE_SIZE; i++) {
    if (rangeKeys[i] === value) return rangeTexts[i];
  }
  const text = `${value} m`;
  rangeKeys[rangeCursor] = value;
  rangeTexts[rangeCursor] = text;
  rangeCursor = (rangeCursor + 1) % RANGE_CACHE_SIZE;
  return text;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export type CollarMark = {
  bearing: number;   // radians, world frame
  range: number;     // metres
  kind: 'velocity' | 'target' | 'hostile' | 'contact' | 'ore';
  strength: number;  // 0..1, drives tick length and opacity
};

export type CollarFrame = {
  marks: CollarMark[];
  thrust: number;    // signed, -0.28..1.65
  heat: number;      // 0..1
  radius: number;    // screen px
  reducedMotion: boolean;
  time: number;      // seconds, for the overheat pulse only
};

/** Bearing ring, marks and drive arc for the flight HUD. */
export class Collar {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Collar requires a 2D canvas context');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  /** Match the backing store to the CSS box and keep a cached dpr transform. */
  private resize(): boolean {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const backingWidth = Math.round(width * dpr);
    const backingHeight = Math.round(height * dpr);
    const changed = this.canvas.width !== backingWidth || this.canvas.height !== backingHeight || this.dpr !== dpr;
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    if (changed) {
      this.dpr = dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.cssWidth = width;
    this.cssHeight = height;
    return true;
  }

  draw(frame: CollarFrame): void {
    if (this.disposed) return;
    if (!this.resize()) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    const cx = this.cssWidth / 2;
    const cy = this.cssHeight / 2;
    const halfMin = Math.min(this.cssWidth, this.cssHeight) / 2;
    const limit = halfMin - LABEL_RADIUS - 4;
    if (limit < 12) return;
    let radius = Number.isFinite(frame.radius) ? frame.radius : limit;
    if (radius > limit) radius = limit;
    if (radius < 12) radius = 12;

    this.drawRing(cx, cy, radius);
    this.drawDriveArc(cx, cy, radius, frame);
    this.drawMarks(frame, cx, cy, radius);
    ctx.globalAlpha = 1;
  }

  /** The lead owns the canvas; the collar only stops answering. */
  dispose(): void {
    this.disposed = true;
  }

  /** Full circle less the deliberate 40° gap at the top. */
  private drawRing(cx: number, cy: number, radius: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = RING_ALPHA;
    ctx.strokeStyle = ETCH_DIM;
    ctx.lineWidth = RING_WIDTH;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, TOP + GAP_HALF, TOP - GAP_HALF + TAU, false);
    ctx.stroke();
  }

  /** Dormant 140° scale, then the thrust fill clockwise and retro fill counter-clockwise. */
  private drawDriveArc(cx: number, cy: number, radius: number, frame: CollarFrame): void {
    const ctx = this.ctx;
    const heat = clamp01(Number.isFinite(frame.heat) ? frame.heat : 0);
    const thrust = Number.isFinite(frame.thrust) ? frame.thrust : 0;
    const forward = clamp01(thrust / THRUST_MAX);
    const retro = clamp01(-thrust / RETRO_MAX);

    ctx.lineWidth = ARC_WIDTH;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = ARC_ALPHA;
    ctx.strokeStyle = ETCH_DIM;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, BOTTOM - ARC_HALF, BOTTOM + ARC_HALF, false);
    ctx.stroke();

    if (forward <= 0 && retro <= 0) return;

    const time = Number.isFinite(frame.time) ? frame.time : 0;
    ctx.globalAlpha = heat > OVERHEAT && !frame.reducedMotion
      ? PULSE_FLOOR + (1 - PULSE_FLOOR) * (0.5 + 0.5 * Math.sin(time * PULSE_RATE))
      : 1;
    ctx.strokeStyle = HEAT_STOPS[Math.round(heat * HEAT_STEPS)];

    if (forward > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, BOTTOM, BOTTOM + forward * ARC_HALF, false);
      ctx.stroke();
    }
    if (retro > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, BOTTOM, BOTTOM - retro * ARC_HALF, true);
      ctx.stroke();
    }
  }

  private drawMarks(frame: CollarFrame, cx: number, cy: number, radius: number): void {
    const marks = frame.marks;
    if (marks.length === 0) return;
    const ctx = this.ctx;
    ctx.lineCap = 'butt';

    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      if (!Number.isFinite(mark.bearing)) continue;
      // World is +x right / +y up, canvas is y-down: a bearing b is canvas angle -b.
      const ux = Math.cos(-mark.bearing);
      const uy = Math.sin(-mark.bearing);
      const strength = Number.isFinite(mark.strength) ? clamp01(mark.strength) : 1;
      const far = Number.isFinite(mark.range) && mark.range > FAR_RANGE ? FAR_ALPHA : 1;

      switch (mark.kind) {
        case 'velocity': {
          ctx.globalAlpha = (0.55 + 0.45 * strength) * far;
          ctx.strokeStyle = ETCH;
          ctx.lineWidth = VELOCITY_WIDTH;
          ctx.beginPath();
          ctx.moveTo(cx + ux * (radius - VELOCITY_HALF), cy + uy * (radius - VELOCITY_HALF));
          ctx.lineTo(cx + ux * (radius + VELOCITY_HALF), cy + uy * (radius + VELOCITY_HALF));
          ctx.stroke();
          break;
        }
        case 'target': {
          // Amber caret pointing outward, numeral hanging off its own arc.
          const tx = -uy;
          const ty = ux;
          const tipX = cx + ux * (radius + TARGET_OUT);
          const tipY = cy + uy * (radius + TARGET_OUT);
          const baseX = cx + ux * (radius - TARGET_OUT);
          const baseY = cy + uy * (radius - TARGET_OUT);
          ctx.globalAlpha = 0.7 + 0.3 * strength;
          ctx.strokeStyle = DRIVE;
          ctx.lineWidth = TARGET_WIDTH;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(baseX + tx * TARGET_ARM, baseY + ty * TARGET_ARM);
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(baseX - tx * TARGET_ARM, baseY - ty * TARGET_ARM);
          ctx.stroke();
          ctx.globalAlpha = far;
          ctx.fillStyle = ETCH;
          ctx.font = FONT_NUMERAL;
          ctx.textAlign = ux > LABEL_ALIGN_COS ? 'left' : ux < -LABEL_ALIGN_COS ? 'right' : 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(rangeNumeral(mark.range), cx + ux * (radius + LABEL_RADIUS), cy + uy * (radius + LABEL_RADIUS));
          break;
        }
        case 'hostile': {
          const length = HOSTILE_MIN + HOSTILE_SPAN * strength;
          ctx.globalAlpha = (0.45 + 0.55 * strength) * far;
          ctx.strokeStyle = THREAT;
          ctx.lineWidth = HOSTILE_WIDTH;
          ctx.beginPath();
          ctx.moveTo(cx + ux * radius, cy + uy * radius);
          ctx.lineTo(cx + ux * (radius + length), cy + uy * (radius + length));
          ctx.stroke();
          break;
        }
        case 'contact': {
          ctx.globalAlpha = (0.4 + 0.55 * strength) * far;
          ctx.fillStyle = NAV;
          ctx.beginPath();
          ctx.arc(cx + ux * radius, cy + uy * radius, CONTACT_RADIUS, 0, TAU);
          ctx.fill();
          break;
        }
        case 'ore': {
          ctx.globalAlpha = 0.4 * far;
          ctx.fillStyle = NAV;
          ctx.beginPath();
          ctx.arc(cx + ux * radius, cy + uy * radius, ORE_RADIUS, 0, TAU);
          ctx.fill();
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
