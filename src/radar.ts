import type { Vec2 } from './physics';

export type RadarKind = 'cargo' | 'station' | 'beacon' | 'derelict';
export type RadarContact = {
  id: string;
  kind: RadarKind;
  position: Vec2;
  known: boolean;      // false = unresolved contact, drawn dimmed
  collected?: boolean; // recovered archive: stop drawing it
  selected: boolean;
};
export type RadarRock = { x: number; y: number; radius: number };
export type RadarFrame = {
  time: number;                       // seconds, for pulsing lamps
  ship: Vec2;
  angle: number;                      // radians, ship rotation (visual only)
  velocity: Vec2;
  contacts: RadarContact[];
  rocks: RadarRock[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  view: { halfWidth: number; halfHeight: number };  // world units currently visible in the main viewport
  zoom: number;                       // 1 = whole sector fits, >1 = zoomed in on the ship
};

const TAU = Math.PI * 2;
const MARGIN = 4;
const GRID_STEP = 500;
const GRID_MAJOR_STEP = 1000;
const MAX_ROCK_DOTS = 220;
const MIN_ROCK_RADIUS = 0.6;
const MAX_ROCK_RADIUS = 3;
const ROCK_NOISE_LIMIT = 4;      // metres; culled while the whole sector is in view
const VELOCITY_FLOOR = 0.5;      // m/s

const PLATE = '#0b141d';
const PLATE_EDGE = '#22333f';
const GRID_MINOR = 'rgba(90,120,140,.16)';
const GRID_MAJOR = 'rgba(90,120,140,.3)';
const ROCK_STYLE = 'rgba(140,155,165,.42)';
const IVORY = '#dce6e8';
const AMBER = '#efb879';
const SEA_GLASS = '#83b9b5';
const VIEW_BOX = 'rgba(131,185,181,.35)';
const VIEW_VELOCITY = 'rgba(239,184,121,.75)';
const BRACKET = 'rgba(131,185,181,.9)';
const LEADER = 'rgba(131,185,181,.35)';
const LABEL = '#7b93a1';
const CARDINAL = '#54697a';

const FONT_LABEL = "9px 'Barlow Condensed', sans-serif";
const FONT_TICK = "8px 'Barlow Condensed', sans-serif";

const DASH_VIEW = [4, 4];
const DASH_NONE: number[] = [];

type ScaleStep = { meters: number; label: string };
const SCALE_STEPS: ScaleStep[] = [];
for (let decade = 2; decade <= 6; decade++) {
  const unit = 10 ** (decade - 2);
  for (const multiplier of [1, 2.5, 5]) {
    const meters = Math.round(multiplier * unit * 10) / 10;
    SCALE_STEPS.push({ meters, label: `${meters} m` });
  }
}

function clampValue(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

function roundedPlate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Top-down sector map for the flight HUD and the tactical overlay. */
export class Radar {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 0;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private clipLeft = 0;
  private clipTop = 0;
  private clipRight = 0;
  private clipBottom = 0;
  private shipX = 0;
  private shipY = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Radar requires a 2D canvas context');
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
    this.clipLeft = 1;
    this.clipTop = 1;
    this.clipRight = Math.max(1, width - 1);
    this.clipBottom = Math.max(1, height - 1);
    return true;
  }

  /** Fit the requested world window into the plate, clamped to the sector bounds. */
  private project(frame: RadarFrame): void {
    const bounds = frame.bounds;
    const boundsWidth = Math.max(1e-3, bounds.maxX - bounds.minX);
    const boundsHeight = Math.max(1e-3, bounds.maxY - bounds.minY);
    const zoom = Number.isFinite(frame.zoom) ? clampValue(frame.zoom, 0.25, 200) : 1;
    const halfWidth = boundsWidth / (2 * zoom);
    const halfHeight = boundsHeight / (2 * zoom);
    const centerX = halfWidth * 2 >= boundsWidth
      ? (bounds.minX + bounds.maxX) / 2
      : clampValue(frame.ship.x, bounds.minX + halfWidth, bounds.maxX - halfWidth);
    const centerY = halfHeight * 2 >= boundsHeight
      ? (bounds.minY + bounds.maxY) / 2
      : clampValue(frame.ship.y, bounds.minY + halfHeight, bounds.maxY - halfHeight);
    const availableWidth = Math.max(1, this.cssWidth - MARGIN * 2);
    const availableHeight = Math.max(1, this.cssHeight - MARGIN * 2);
    this.scale = Math.min(availableWidth / (2 * halfWidth), availableHeight / (2 * halfHeight));
    this.ox = this.cssWidth / 2 - centerX * this.scale;
    this.oy = this.cssHeight / 2 + centerY * this.scale;
  }

  private sx(worldX: number) {
    return this.ox + worldX * this.scale;
  }

  private sy(worldY: number) {
    return this.oy - worldY * this.scale;
  }

  /** Ship marker position, pinned inside the plate when the vessel leaves the sector. */
  private placeShip(frame: RadarFrame): void {
    const inset = 6;
    const left = this.clipLeft + inset;
    const right = this.clipRight - inset;
    const top = this.clipTop + inset;
    const bottom = this.clipBottom - inset;
    this.shipX = clampValue(this.sx(frame.ship.x), left, right);
    this.shipY = clampValue(this.sy(frame.ship.y), top, bottom);
  }

  draw(frame: RadarFrame): void {
    if (this.disposed) return;
    if (!this.resize()) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.project(frame);
    this.placeShip(frame);
    this.drawPlate();
    ctx.save();
    ctx.beginPath();
    roundedPlate(ctx, 1, 1, Math.max(1, this.cssWidth - 2), Math.max(1, this.cssHeight - 2), 2.5);
    ctx.clip();
    this.drawGrid(frame);
    this.drawRocks(frame);
    this.drawContacts(frame);
    this.drawShip(frame);
    ctx.restore();
    this.drawScaleBar();
    this.drawCardinals();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  private drawPlate(): void {
    const ctx = this.ctx;
    ctx.fillStyle = PLATE;
    ctx.beginPath();
    roundedPlate(ctx, 0.5, 0.5, this.cssWidth - 1, this.cssHeight - 1, 3);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = PLATE_EDGE;
    ctx.stroke();
  }

  private drawGrid(frame: RadarFrame): void {
    const ctx = this.ctx;
    const bounds = frame.bounds;
    const left = this.clipLeft;
    const right = this.clipRight;
    const top = this.clipTop;
    const bottom = this.clipBottom;

    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(bounds.minX / GRID_STEP) * GRID_STEP; x <= bounds.maxX; x += GRID_STEP) {
      if (x % GRID_MAJOR_STEP === 0) continue;
      const sx = this.sx(x);
      if (sx < left || sx > right) continue;
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, bottom);
    }
    for (let y = Math.ceil(bounds.minY / GRID_STEP) * GRID_STEP; y <= bounds.maxY; y += GRID_STEP) {
      if (y % GRID_MAJOR_STEP === 0) continue;
      const sy = this.sy(y);
      if (sy < top || sy > bottom) continue;
      ctx.moveTo(left, sy);
      ctx.lineTo(right, sy);
    }
    ctx.strokeStyle = GRID_MINOR;
    ctx.stroke();

    ctx.beginPath();
    for (let x = Math.ceil(bounds.minX / GRID_MAJOR_STEP) * GRID_MAJOR_STEP; x <= bounds.maxX; x += GRID_MAJOR_STEP) {
      const sx = this.sx(x);
      if (sx < left || sx > right) continue;
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, bottom);
    }
    for (let y = Math.ceil(bounds.minY / GRID_MAJOR_STEP) * GRID_MAJOR_STEP; y <= bounds.maxY; y += GRID_MAJOR_STEP) {
      const sy = this.sy(y);
      if (sy < top || sy > bottom) continue;
      ctx.moveTo(left, sy);
      ctx.lineTo(right, sy);
    }
    ctx.strokeStyle = GRID_MAJOR;
    ctx.stroke();
  }

  private drawRocks(frame: RadarFrame): void {
    const rocks = frame.rocks;
    const total = rocks.length;
    if (total === 0) return;
    const ctx = this.ctx;
    const dense = total > MAX_ROCK_DOTS;
    const count = dense ? MAX_ROCK_DOTS : total;
    const stride = dense ? total / MAX_ROCK_DOTS : 1;
    const cullNoise = frame.zoom <= 1.0001;
    const left = this.clipLeft - 4;
    const right = this.clipRight + 4;
    const top = this.clipTop - 4;
    const bottom = this.clipBottom + 4;
    ctx.fillStyle = ROCK_STYLE;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const rock = rocks[dense ? Math.floor(i * stride) : i];
      if (cullNoise && rock.radius < ROCK_NOISE_LIMIT) continue;
      const sx = this.sx(rock.x);
      if (sx < left || sx > right) continue;
      const sy = this.sy(rock.y);
      if (sy < top || sy > bottom) continue;
      const radius = clampValue(rock.radius * this.scale, MIN_ROCK_RADIUS, MAX_ROCK_RADIUS);
      ctx.moveTo(sx + radius, sy);
      ctx.arc(sx, sy, radius, 0, TAU);
    }
    ctx.fill();
  }

  private drawContacts(frame: RadarFrame): void {
    const contacts = frame.contacts;
    if (contacts.length === 0) return;
    const ctx = this.ctx;
    const time = frame.time;
    const left = this.clipLeft - 10;
    const right = this.clipRight + 10;
    const top = this.clipTop - 10;
    const bottom = this.clipBottom + 10;

    ctx.globalAlpha = 1;
    ctx.strokeStyle = LEADER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      if (!contact.selected || contact.collected) continue;
      ctx.moveTo(this.shipX, this.shipY);
      ctx.lineTo(this.sx(contact.position.x), this.sy(contact.position.y));
    }
    ctx.stroke();

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      if (contact.collected) continue;
      const x = this.sx(contact.position.x);
      if (x < left || x > right) continue;
      const y = this.sy(contact.position.y);
      if (y < top || y > bottom) continue;
      const alpha = contact.known ? 1 : 0.35;
      switch (contact.kind) {
        case 'cargo': {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = AMBER;
          ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
          break;
        }
        case 'derelict': {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = IVORY;
          ctx.beginPath();
          ctx.moveTo(x, y - 3.5);
          ctx.lineTo(x + 3.5, y);
          ctx.lineTo(x, y + 3.5);
          ctx.lineTo(x - 3.5, y);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'beacon': {
          const pulse = (Math.sin(time * 3) + 1) * 0.5;
          ctx.strokeStyle = SEA_GLASS;
          ctx.lineWidth = 1;
          ctx.globalAlpha = alpha * (0.5 - pulse * 0.4);
          ctx.beginPath();
          ctx.arc(x, y, 4 + pulse * 5, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = SEA_GLASS;
          ctx.beginPath();
          ctx.moveTo(x, y - 2.8);
          ctx.lineTo(x + 2.8, y);
          ctx.lineTo(x, y + 2.8);
          ctx.lineTo(x - 2.8, y);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'station': {
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = SEA_GLASS;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 3.8, 0, TAU);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 1.6, 0, TAU);
          ctx.stroke();
          break;
        }
      }
      if (contact.selected) {
        ctx.globalAlpha = 1;
        this.drawBracket(x, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawBracket(x: number, y: number): void {
    const ctx = this.ctx;
    const half = 5;
    const tick = 3;
    ctx.strokeStyle = BRACKET;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - half, y - half + tick);
    ctx.lineTo(x - half, y - half);
    ctx.lineTo(x - half + tick, y - half);
    ctx.moveTo(x + half - tick, y - half);
    ctx.lineTo(x + half, y - half);
    ctx.lineTo(x + half, y - half + tick);
    ctx.moveTo(x + half, y + half - tick);
    ctx.lineTo(x + half, y + half);
    ctx.lineTo(x + half - tick, y + half);
    ctx.moveTo(x - half + tick, y + half);
    ctx.lineTo(x - half, y + half);
    ctx.lineTo(x - half, y + half - tick);
    ctx.stroke();
  }

  private drawShip(frame: RadarFrame): void {
    const ctx = this.ctx;
    const x = this.shipX;
    const y = this.shipY;
    const halfWidth = frame.view.halfWidth * this.scale;
    const halfHeight = frame.view.halfHeight * this.scale;

    if (halfWidth > 1 && halfHeight > 1) {
      ctx.strokeStyle = VIEW_BOX;
      ctx.lineWidth = 1;
      ctx.setLineDash(DASH_VIEW);
      ctx.strokeRect(x - halfWidth, y - halfHeight, halfWidth * 2, halfHeight * 2);
      ctx.setLineDash(DASH_NONE);
    }

    const velocityX = frame.velocity.x;
    const velocityY = frame.velocity.y;
    const speed = Math.hypot(velocityX, velocityY);
    if (speed > VELOCITY_FLOOR) {
      const length = Math.min(26, 6 + speed * 0.8);
      const ux = velocityX / speed;
      const uy = -velocityY / speed;
      ctx.strokeStyle = VIEW_VELOCITY;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + ux * length, y + uy * length);
      ctx.stroke();
    }

    const dirX = -Math.sin(frame.angle);
    const dirY = -Math.cos(frame.angle);
    const nose = 6;
    const tail = 3.5;
    const wing = 4;
    ctx.fillStyle = IVORY;
    ctx.beginPath();
    ctx.moveTo(x + dirX * nose, y + dirY * nose);
    ctx.lineTo(x - dirX * tail - dirY * wing, y - dirY * tail + dirX * wing);
    ctx.lineTo(x - dirX * tail + dirY * wing, y - dirY * tail - dirX * wing);
    ctx.closePath();
    ctx.fill();
  }

  private drawScaleBar(): void {
    const ctx = this.ctx;
    const width = this.cssWidth - MARGIN * 2;
    let chosen = SCALE_STEPS[0];
    let bestGap = Infinity;
    for (let i = 0; i < SCALE_STEPS.length; i++) {
      const step = SCALE_STEPS[i];
      const ratio = step.meters * this.scale / width;
      if (ratio >= 0.25 && ratio <= 0.45) {
        chosen = step;
        break;
      }
      const gap = ratio < 0.25 ? 0.25 - ratio : ratio - 0.45;
      if (gap < bestGap) {
        bestGap = gap;
        chosen = step;
      }
    }
    const x0 = MARGIN + 4;
    const x1 = x0 + Math.min(chosen.meters * this.scale, width - 8);
    const y = this.cssHeight - MARGIN - 8;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y - 3);
    ctx.lineTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.lineTo(x1, y - 3);
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.font = FONT_LABEL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(chosen.label, x0, y - 5);
  }

  private drawCardinals(): void {
    const ctx = this.ctx;
    const left = MARGIN + 2;
    const right = this.cssWidth - MARGIN - 2;
    const top = MARGIN + 2;
    const bottom = this.cssHeight - MARGIN - 2;
    ctx.fillStyle = CARDINAL;
    ctx.font = FONT_TICK;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('N', left, top);
    ctx.textAlign = 'right';
    ctx.fillText('E', right, top);
    ctx.textBaseline = 'bottom';
    ctx.fillText('S', right, bottom);
    ctx.textAlign = 'left';
    ctx.fillText('W', left, bottom);
  }
}
