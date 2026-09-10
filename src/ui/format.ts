/**
 * Shared number and unit formatting (Plan A2/A3). Every screen reads its telemetry through these
 * functions so no screen invents its own arithmetic, rounding or unit string. Ship figures are
 * never computed here: `deriveFit` owns the maths and this module only prints its output.
 *
 * Output is locale-independent on purpose. `toLocaleString` would change separators, digits and
 * unit order with the host locale, and the LAN host and every guest must see the same string.
 */

import type { DerivedFit, Vec2 } from '../shared/contracts.ts';

/** ASCII digits, non-breaking thin space groups — tabular display is the `.num` CSS rule. */
const GROUP = /\B(?=(\d{3})+(?!\d))/g;

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Rounds half away from zero so 2.5 and -2.5 never disagree between browsers. */
export function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  const scaled = finite(value) * scale;
  return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / scale;
}

export function fixed(value: number, digits: number): string {
  return round(value, digits).toFixed(digits);
}

export function int(value: number): string {
  const safe = Math.round(finite(value));
  return (safe < 0 ? '-' : '') + String(Math.abs(safe)).replace(GROUP, '\u2009');
}

/** One decimal below 10, none above: the reading should not jitter between 9.9 and 10. */
export function scaled(value: number, unit: string, digitsBelowTen = 1): string {
  const size = Math.abs(finite(value));
  return `${fixed(value, size < 10 ? digitsBelowTen : 0)}\u2009${unit}`;
}

export function metres(m: number): string {
  return `${fixed(m, Math.abs(m) < 100 ? 1 : 0)}\u2009m`;
}

/** Tactical distances: metres up close, kilometres once the reading stops being readable. */
export function distance(m: number): string {
  const size = Math.abs(finite(m));
  if (size >= 1000) return `${fixed(m / 1000, size >= 10_000 ? 0 : 1)}\u2009km`;
  return metres(m);
}

export function speed(mps: number): string {
  return `${fixed(mps, Math.abs(mps) < 100 ? 1 : 0)}\u2009m/s`;
}

export function massKg(kg: number): string {
  const size = Math.abs(finite(kg));
  if (size >= 1000) return `${fixed(kg / 1000, 2)}\u2009t`;
  return `${fixed(kg, size < 100 ? 1 : 0)}\u2009kg`;
}

export function powerMW(mw: number): string {
  return `${fixed(mw, 2)}\u2009MW`;
}

export function energyMJ(mj: number): string {
  return `${fixed(mj, 1)}\u2009MJ`;
}

export function thrustN(n: number): string {
  const size = Math.abs(finite(n));
  if (size >= 1000) return `${fixed(n / 1000, size >= 100_000 ? 0 : 1)}\u2009kN`;
  return `${fixed(n, 0)}\u2009N`;
}

/** Fractions of a limit become whole percent; the underlying value never changes unit twice. */
export function percent(fraction: number, digits = 0): string {
  return `${fixed(clamp01(fraction) * 100, digits)}%`;
}

export function ratio(part: number, whole: number, digits = 0): string {
  if (!Number.isFinite(whole) || whole <= 0) return '--';
  return `${fixed((finite(part) / whole) * 100, digits)}%`;
}

/** Clock-style duration for countdowns and return timers. */
export function seconds(total: number): string {
  const safe = Math.max(0, Math.ceil(finite(total)));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

export function credits(count: number): string {
  return `${int(count)}\u2009cr`;
}

/** Sensor uncertainty: a contact is a region, not a point (Plan A3). */
export function uncertainty(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return 'exact';
  return `\u00b1${distance(m)}`;
}

/** Age of a contact in whole seconds; stale contacts are labelled rather than hidden. */
export function age(ageTicks: number, hz: number): string {
  if (!Number.isFinite(ageTicks) || ageTicks <= 0) return 'live';
  return `${fixed(ageTicks / hz, ageTicks / hz < 10 ? 1 : 0)}\u2009s ago`;
}

export function signed(value: number, digits: number, unit: string): string {
  const safe = round(value, digits);
  const sign = safe > 0 ? '+' : '';
  return `${sign}${fixed(safe, digits)}\u2009${unit}`;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : finite(value);
}

/** Angle zero faces +Y (contract); the instrument prints compass degrees. */
export function headingDeg(angleRad: number): string {
  const degrees = ((((finite(angleRad) * 180) / Math.PI) % 360) + 360) % 360;
  return `${fixed(degrees, 0).padStart(3, '0')}\u00b0`;
}

export function vectorSpeed(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

// ---------------------------------------------------------------------------------------------
// Fit comparison. Both sides come from `deriveFit`; this only subtracts what the shared module
// already derived, so a hull maximum can never be recomputed differently in the hangar.
// ---------------------------------------------------------------------------------------------

export interface FitDelta {
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly delta: string;
  readonly direction: 'up' | 'down' | 'same';
  /** True when the change is bad for the pilot (heavier, hotter, less power). */
  readonly worse: boolean;
}

function deltaRow(
  label: string,
  before: number,
  after: number,
  print: (value: number) => string,
  /** +1 when a bigger number is better, -1 when a bigger number is worse. */
  polarity: 1 | -1,
  digits: number,
  unit: string,
): FitDelta {
  const change = round(after - before, digits);
  return {
    label,
    before: print(before),
    after: print(after),
    delta: change === 0 ? '\u00b10\u2009' + unit : signed(change, digits, unit),
    direction: change === 0 ? 'same' : change > 0 ? 'up' : 'down',
    worse: change !== 0 && Math.sign(change) !== polarity,
  };
}

/** Full-fuel acceleration is a derived figure, not a stored one: F / m. */
export function accelerationMS2(derived: DerivedFit): number {
  return derived.thrustN / Math.max(1, derived.dryMassKg + derived.fuelCapacityKg);
}

export function fitComparison(current: DerivedFit, proposed: DerivedFit): readonly FitDelta[] {
  return [
    deltaRow('Mass', current.dryMassKg, proposed.dryMassKg, massKg, -1, 1, 'kg'),
    deltaRow('Acceleration', accelerationMS2(current), accelerationMS2(proposed), value => `${fixed(value, 2)}\u2009m/s\u00b2`, 1, 2, 'm/s\u00b2'),
    deltaRow('Power supply', current.powerSupplyMW, proposed.powerSupplyMW, powerMW, 1, 2, 'MW'),
    deltaRow('Idle demand', current.idleDemandMW, proposed.idleDemandMW, powerMW, -1, 2, 'MW'),
    deltaRow('Cooling', current.coolingMW, proposed.coolingMW, powerMW, 1, 2, 'MW'),
    deltaRow('Heat capacity', current.heatCapacityMJ, proposed.heatCapacityMJ, energyMJ, 1, 1, 'MJ'),
    deltaRow('Hull', current.hullMax, proposed.hullMax, value => int(value), 1, 0, 'hp'),
    deltaRow('Build cost', current.buildCost, proposed.buildCost, value => int(value), -1, 0, 'pt'),
  ];
}
