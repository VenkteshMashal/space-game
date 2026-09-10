/**
 * Collision shapes and the B5 impulse solver for the 120 Hz authority kernel.
 *
 * Everything here is authority-side: the client predicts flight, never damage or inventory. Mass
 * properties come from the frozen `CollisionShape` so one proxy drives CCD, debug draw and the
 * hangar. Angles are radians; angle zero faces +Y and local +X is the hull's right.
 */

import { CONTACT } from '../shared/balance.ts';
import type { CollisionShape } from '../shared/contracts.ts';
import { LAYER } from './types.ts';
import type { Contact, RigidBody, StepContacts, SweepHit } from './types.ts';
import { SpatialHash, aabbFromShape, expandedAabb, sweptAabb } from './spatial.ts';

export { aabbFromShape };

/** 15° half step: a 12-gon for circles, six segments per capsule cap. */
const ARC_STEP_RAD = Math.PI / 12;
/**
 * Circle and capsule polygons are circumscribed (vertices at r / cos(step)), so the polygon always
 * contains the true shape. Conservative advancement can then only stop early, never tunnel.
 */
const CIRCUMSCRIBE = 1 / Math.cos(ARC_STEP_RAD);

/** Farthest surface point from the body centre; bounds both the rotational sweep and broadphase. */
export function shapeRadiusM(shape: CollisionShape): number {
  if (shape.kind === 'circle') return shape.radiusM;
  if (shape.kind === 'capsule') return shape.halfSegmentM + shape.radiusM;
  let radius = 0;
  for (const v of shape.vertices) {
    const d = Math.hypot(v.x, v.y);
    if (d > radius) radius = d;
  }
  return radius;
}

/**
 * Inverse mass and inverse inertia. The hull approximation `m·(length² + beam²) / 12` is the B5
 * starting point (slot offsets are not counted here); circles use the solid disc `m·r² / 2`.
 * A non-positive mass or degenerate extent is immovable: both inverses are zero.
 */
export function massProperties(shape: CollisionShape, massKg: number): { invMass: number; invInertia: number } {
  if (!(massKg > 0)) return { invMass: 0, invInertia: 0 };
  let inertia: number;
  if (shape.kind === 'circle') {
    inertia = 0.5 * massKg * shape.radiusM * shape.radiusM;
  } else if (shape.kind === 'capsule') {
    // Length is along the hull axis (local +Y), beam across it.
    const length = 2 * (shape.halfSegmentM + shape.radiusM);
    const beam = 2 * shape.radiusM;
    inertia = (massKg * (length * length + beam * beam)) / 12;
  } else {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const v of shape.vertices) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    const length = maxY - minY;
    const beam = maxX - minX;
    inertia = (massKg * (length * length + beam * beam)) / 12;
  }
  if (!(inertia > 0)) return { invMass: 0, invInertia: 0 };
  return { invMass: 1 / massKg, invInertia: 1 / inertia };
}

/** Semi-implicit integration for one body; the angle is folded back into (-π, π]. */
export function integrateBody(body: RigidBody, dt: number): void {
  body.position = {
    x: body.position.x + body.velocity.x * dt,
    y: body.position.y + body.velocity.y * dt,
  };
  body.angle = Math.atan2(Math.sin(body.angle + body.angularVelocity * dt), Math.cos(body.angle + body.angularVelocity * dt));
}

// --- convex polygons ---------------------------------------------------------------------------
// Round pairs are solved analytically (`roundRound`); these polygons only meet convex hulls, which
// are used exactly as authored: vertices must be convex and counterclockwise, since the face
// normals they produce are the only axes SAT can separate on.

const polygons = new WeakMap<CollisionShape, readonly number[]>();

/** Cap segments per capsule end; 6 keeps the circumscribed slack under 4% of the radius. */
const CAP_SEGMENTS = 6;

/** Local vertex pairs, ordered counterclockwise. */
function localPolygon(shape: CollisionShape): readonly number[] {
  const cached = polygons.get(shape);
  if (cached !== undefined) return cached;
  const vertices: number[] = [];
  if (shape.kind === 'circle') {
    const r = shape.radiusM * CIRCUMSCRIBE;
    for (let i = 0; i < CAP_SEGMENTS * 2; i++) {
      const a = i * ARC_STEP_RAD * 2;
      vertices.push(r * Math.cos(a), r * Math.sin(a));
    }
  } else if (shape.kind === 'capsule') {
    // Two half-arcs joined by the straight sides: counterclockwise hull of the segment plus radius.
    const r = shape.radiusM * CIRCUMSCRIBE;
    const h = shape.halfSegmentM;
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const a = (i * Math.PI) / CAP_SEGMENTS;
      vertices.push(r * Math.cos(a), h + r * Math.sin(a));
    }
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const a = Math.PI + (i * Math.PI) / CAP_SEGMENTS;
      vertices.push(r * Math.cos(a), -h + r * Math.sin(a));
    }
  } else {
    for (const v of shape.vertices) vertices.push(v.x, v.y);
  }
  polygons.set(shape, vertices);
  return vertices;
}

/** World vertices into `out`; returns the vertex count. Scratch buffers avoid per-sweep garbage. */
function transformInto(poly: readonly number[], px: number, py: number, angle: number, out: number[]): number {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i];
    const y = poly[i + 1];
    out[i] = px + x * cos - y * sin;
    out[i + 1] = py + x * sin + y * cos;
  }
  return poly.length / 2;
}

const scratchA: number[] = [];
const scratchB: number[] = [];

/** Exact geometry for round pairs, polygon SAT for anything involving a convex hull. */
function narrowphase(a: RigidBody, b: RigidBody, ax: number, ay: number, aa: number, bx: number, by: number, ab: number): SatResult {
  if (a.shape.kind !== 'convex' && b.shape.kind !== 'convex') {
    return roundRound(a.shape, ax, ay, aa, b.shape, bx, by, ab);
  }
  const polyA = localPolygon(a.shape);
  const polyB = localPolygon(b.shape);
  const countA = transformInto(polyA, ax, ay, aa, scratchA);
  const countB = transformInto(polyB, bx, by, ab, scratchB);
  return satPair(ax, ay, scratchA, countA, bx, by, scratchB, countB);
}

/** Narrowphase at the bodies' current poses. */
function satAt(a: RigidBody, b: RigidBody): SatResult {
  return narrowphase(a, b, a.position.x, a.position.y, a.angle, b.position.x, b.position.y, b.angle);
}

interface SatResult {
  overlap: boolean;
  /** Separation distance along the best separating axis; 0 when overlapping. */
  gap: number;
  /** Penetration depth along the minimum-overlap axis; 0 when separated. */
  depth: number;
  nx: number;
  ny: number;
  /** Midpoint of the two support points along the normal. */
  px: number;
  py: number;
}

const sat: SatResult = { overlap: false, gap: 0, depth: 0, nx: 0, ny: 0, px: 0, py: 0 };

/** Sub-micron axis margins are geometry noise, not a real separation or a real penetration. */
const AXIS_EPS = 1e-6;

/** Closest-point parameters on two segments; a degenerate segment collapses to its endpoint. */
const closest = { s: 0, t: 0 };

function closestParams(a1x: number, a1y: number, a2x: number, a2y: number, b1x: number, b1y: number, b2x: number, b2y: number): void {
  const d1x = a2x - a1x;
  const d1y = a2y - a1y;
  const d2x = b2x - b1x;
  const d2y = b2y - b1y;
  const rx = a1x - b1x;
  const ry = a1y - b1y;
  const a11 = d1x * d1x + d1y * d1y;
  const a22 = d2x * d2x + d2y * d2y;
  const a12 = d1x * d2x + d1y * d2y;
  const b1 = d1x * rx + d1y * ry;
  const b2 = d2x * rx + d2y * ry;
  let s = 0;
  let t = 0;
  if (a22 <= AXIS_EPS) {
    // B is a point: project it onto A.
    if (a11 > AXIS_EPS) s = Math.min(1, Math.max(0, -b1 / a11));
  } else {
    if (a11 > AXIS_EPS) {
      const denom = a11 * a22 - a12 * a12;
      if (Math.abs(denom) > AXIS_EPS) s = Math.min(1, Math.max(0, (a12 * b2 - a22 * b1) / denom));
    }
    t = (a12 * s + b2) / a22;
    if (t < 0) {
      t = 0;
      if (a11 > AXIS_EPS) s = Math.min(1, Math.max(0, -b1 / a11));
    } else if (t > 1) {
      t = 1;
      if (a11 > AXIS_EPS) s = Math.min(1, Math.max(0, (a12 - b1) / a11));
    }
  }
  closest.s = s;
  closest.t = t;
}

/**
 * Exact narrowphase for two round shapes (circle = point core, capsule = segment core). Polygons
 * are only used against convex hulls, where their circumscribed caps would inflate a measured
 * penetration; here the separation is the core distance minus both radii.
 */
function roundRound(sha: CollisionShape, pax: number, pay: number, aa: number, shb: CollisionShape, pbx: number, pby: number, ab: number): SatResult {
  let a1x = pax;
  let a1y = pay;
  let a2x = pax;
  let a2y = pay;
  let radiusA = 0;
  if (sha.kind === 'capsule') {
    const h = sha.halfSegmentM;
    const sin = Math.sin(aa);
    const cos = Math.cos(aa);
    a1x = pax + h * sin;
    a1y = pay - h * cos;
    a2x = pax - h * sin;
    a2y = pay + h * cos;
    radiusA = sha.radiusM;
  } else if (sha.kind === 'circle') {
    radiusA = sha.radiusM;
  }
  let b1x = pbx;
  let b1y = pby;
  let b2x = pbx;
  let b2y = pby;
  let radiusB = 0;
  if (shb.kind === 'capsule') {
    const h = shb.halfSegmentM;
    const sin = Math.sin(ab);
    const cos = Math.cos(ab);
    b1x = pbx + h * sin;
    b1y = pby - h * cos;
    b2x = pbx - h * sin;
    b2y = pby + h * cos;
    radiusB = shb.radiusM;
  } else if (shb.kind === 'circle') {
    radiusB = shb.radiusM;
  }

  closestParams(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y);
  const px = a1x + (a2x - a1x) * closest.s;
  const py = a1y + (a2y - a1y) * closest.s;
  const qx = b1x + (b2x - b1x) * closest.t;
  const qy = b1y + (b2y - b1y) * closest.t;
  const dx = qx - px;
  const dy = qy - py;
  const distance = Math.hypot(dx, dy);
  const sum = radiusA + radiusB;
  let nx: number;
  let ny: number;
  if (distance > AXIS_EPS) {
    nx = dx / distance;
    ny = dy / distance;
  } else {
    // Coincident cores: fall back to the body centre line, then to +X.
    nx = pbx - pax;
    ny = pby - pay;
    const length = Math.hypot(nx, ny);
    if (length > AXIS_EPS) {
      nx /= length;
      ny /= length;
    } else {
      nx = 1;
      ny = 0;
    }
  }
  const gap = distance - sum;
  sat.overlap = gap <= AXIS_EPS;
  sat.gap = sat.overlap ? 0 : gap;
  sat.depth = sat.overlap ? Math.max(0, -gap) : 0;
  sat.nx = nx;
  sat.ny = ny;
  sat.px = (px + nx * radiusA + qx - nx * radiusB) / 2;
  sat.py = (py + ny * radiusA + qy - ny * radiusB) / 2;
  return sat;
}

/**
 * Separating-axis test on two convex polygons. `gap` is a lower bound of the true distance, which
 * is exactly what conservative advancement needs. The normal is oriented from A to B.
 */
function satPair(cax: number, cay: number, av: number[], an: number, cbx: number, cby: number, bv: number[], bn: number): SatResult {
  sat.overlap = false;
  sat.gap = 0;
  sat.depth = 0;
  sat.nx = 0;
  sat.ny = 0;
  sat.px = 0;
  sat.py = 0;
  if (an < 3 || bn < 3) {
    sat.gap = Infinity;
    return sat;
  }
  let separated = false;
  let gap = 0;
  let depth = Infinity;
  let nx = 0;
  let ny = 0;
  // The center line and the closest vertex pair come first: rounded hulls have no face normal
  // along the contact line, so a tip-to-tip hit would otherwise pick a cap facet 15-45° off.
  let closestDx = cbx - cax;
  let closestDy = cby - cay;
  let closestVertex = Infinity;
  for (let i = 0; i < an; i++) {
    for (let j = 0; j < bn; j++) {
      const dx = bv[j * 2] - av[i * 2];
      const dy = bv[j * 2 + 1] - av[i * 2 + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < closestVertex) {
        closestVertex = d2;
        closestDx = dx;
        closestDy = dy;
      }
    }
  }
  const axisCount = 2 + an + bn;
  for (let index = 0; index < axisCount; index++) {
    let rawX: number;
    let rawY: number;
    if (index === 0) {
      rawX = cbx - cax;
      rawY = cby - cay;
    } else if (index === 1) {
      rawX = closestDx;
      rawY = closestDy;
    } else {
      const edge = index - 2;
      const fromA = edge < an;
      const verts = fromA ? av : bv;
      const count = fromA ? an : bn;
      const i = fromA ? edge : edge - an;
      const j = (i + 1) % count;
      rawX = verts[j * 2 + 1] - verts[i * 2 + 1];
      rawY = verts[i * 2] - verts[j * 2];
    }
    const len = Math.hypot(rawX, rawY);
    if (len < 1e-12) continue;
    const ax = rawX / len;
    const ay = rawY / len;
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let k = 0; k < an; k++) {
      const d = av[k * 2] * ax + av[k * 2 + 1] * ay;
      if (d < minA) minA = d;
      if (d > maxA) maxA = d;
    }
    for (let k = 0; k < bn; k++) {
      const d = bv[k * 2] * ax + bv[k * 2 + 1] * ay;
      if (d < minB) minB = d;
      if (d > maxB) maxB = d;
    }
    const axisGap = Math.max(minB - maxA, minA - maxB);
    if (axisGap > AXIS_EPS) {
      // Only a meaningfully wider gap replaces the record: near a touch every axis sits within
      // float noise of zero, and the feature axes tested first are the ones that stay sane.
      if (!separated || axisGap > gap + AXIS_EPS) {
        gap = axisGap;
        nx = ax;
        ny = ay;
      }
      separated = true;
      continue;
    }
    // Sub-micron gaps are contact, not clearance: keep the first axis, which is the contact line.
    const overlap = axisGap > 0 ? 0 : -axisGap;
    if (overlap < depth - AXIS_EPS) {
      depth = overlap;
      nx = ax;
      ny = ay;
    }
  }
  if (nx * (cbx - cax) + ny * (cby - cay) < 0) {
    nx = -nx;
    ny = -ny;
  }
  let aix = 0;
  let aiy = 0;
  let adot = -Infinity;
  for (let k = 0; k < an; k++) {
    const d = av[k * 2] * nx + av[k * 2 + 1] * ny;
    if (d > adot) {
      adot = d;
      aix = av[k * 2];
      aiy = av[k * 2 + 1];
    }
  }
  let bix = 0;
  let biy = 0;
  let bdot = Infinity;
  for (let k = 0; k < bn; k++) {
    const d = bv[k * 2] * nx + bv[k * 2 + 1] * ny;
    if (d < bdot) {
      bdot = d;
      bix = bv[k * 2];
      biy = bv[k * 2 + 1];
    }
  }
  sat.overlap = !separated;
  sat.gap = separated ? gap : 0;
  sat.depth = separated ? 0 : depth;
  sat.nx = nx;
  sat.ny = ny;
  sat.px = (aix + bix) / 2;
  sat.py = (aiy + biy) / 2;
  return sat;
}

// --- conservative advancement ------------------------------------------------------------------

/**
 * Enough iterations to close the 15°-polygon slack; a tangential sweep needs more than a head-on
 * approach because the separation shrinks slowly near the contact point.
 */
const CA_ITERATIONS = 24;
const CA_TOLERANCE_M = 1e-3;

/**
 * Earliest time of impact for a pair within `maxToi`, or null when they never meet. Conservative
 * advancement: every step moves by the known separation divided by an upper bound on the closing
 * rate, so a rotating hull that sweeps into a target laterally is handled the same as a fast
 * head-on approach. Overlap at t=0 reports toi 0.
 */
export function sweepPair(a: RigidBody, b: RigidBody, maxToi: number): SweepHit | null {
  const closing =
    Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y) +
    Math.abs(a.angularVelocity) * shapeRadiusM(a.shape) +
    Math.abs(b.angularVelocity) * shapeRadiusM(b.shape);
  let t = 0;
  for (let iter = 0; iter < CA_ITERATIONS; iter++) {
    const ax = a.position.x + a.velocity.x * t;
    const ay = a.position.y + a.velocity.y * t;
    const bx = b.position.x + b.velocity.x * t;
    const by = b.position.y + b.velocity.y * t;
    const hit = narrowphase(a, b, ax, ay, a.angle + a.angularVelocity * t, bx, by, b.angle + b.angularVelocity * t);
    if (hit.overlap || hit.gap <= CA_TOLERANCE_M) {
      return { toi: t, normal: { x: hit.nx, y: hit.ny }, point: { x: hit.px, y: hit.py } };
    }
    if (closing <= 1e-9) return null;
    t += hit.gap / closing;
    if (t > maxToi) return null;
  }
  return null;
}

// --- impulse solver ----------------------------------------------------------------------------

function kineticEnergy(body: RigidBody): number {
  const mass = body.invMass > 0 ? 1 / body.invMass : 0;
  const inertia = body.invInertia > 0 ? 1 / body.invInertia : 0;
  const speed = body.velocity.x * body.velocity.x + body.velocity.y * body.velocity.y;
  return 0.5 * mass * speed + 0.5 * inertia * body.angularVelocity * body.angularVelocity;
}

/**
 * B5 damage curve: `k·sqrt(lost − threshold)`, capped at the hull maximum. The threshold means a
 * rest or a graze deals nothing; the square root keeps a heavy hit from deleting a ship outright.
 * `CONTACT` carries no damage constant yet, so both numbers are kernel hypotheses for the C2
 * playtest. Not an extra impulse: the energy was already removed by the solver.
 */
export const DAMAGE_THRESHOLD_J = 200;
const DAMAGE_ENERGY_K = 0.02;

export function damageFromEnergy(lostEnergyJ: number, hullMax: number): number {
  if (!(lostEnergyJ > DAMAGE_THRESHOLD_J)) return 0;
  const scaled = Math.sqrt(lostEnergyJ - DAMAGE_THRESHOLD_J) * DAMAGE_ENERGY_K;
  return scaled < hullMax ? scaled : hullMax;
}

/**
 * Impulse response for one contact, normal pointing from `a` to `b`. Bounces with the bouncier of
 * the two restitutions (a rock keeps its 0.25 when a 0.15 ship hits it), applies bounded friction,
 * and separates the pair by everything past `CONTACT.slopM` so a spawned overlap relaxes instead of
 * pushing forever. Returns the contact with its normal impulse and the energy the pair lost.
 */
export function resolveContact(a: RigidBody, b: RigidBody, contact: Contact): Contact {
  const nx = contact.normal.x;
  const ny = contact.normal.y;
  const rax = contact.point.x - a.position.x;
  const ray = contact.point.y - a.position.y;
  const rbx = contact.point.x - b.position.x;
  const rby = contact.point.y - b.position.y;

  const correction = contact.penetrationM - CONTACT.slopM;
  const totalInvMass = a.invMass + b.invMass;
  if (correction > 0 && totalInvMass > 0) {
    const shareA = (correction * a.invMass) / totalInvMass;
    const shareB = (correction * b.invMass) / totalInvMass;
    a.position = { x: a.position.x - nx * shareA, y: a.position.y - ny * shareA };
    b.position = { x: b.position.x + nx * shareB, y: b.position.y + ny * shareB };
  }

  const before = kineticEnergy(a) + kineticEnergy(b);
  const restitution = a.restitution > b.restitution ? a.restitution : b.restitution;
  let impulseN = 0;

  const normalDenom =
    totalInvMass + a.invInertia * (rax * ny - ray * nx) * (rax * ny - ray * nx) + b.invInertia * (rbx * ny - rby * nx) * (rbx * ny - rby * nx);
  if (normalDenom > 0) {
    const vn = pointVelocity(b, rbx, rby, nx, ny) - pointVelocity(a, rax, ray, nx, ny);
    if (vn < 0) {
      impulseN = (-(1 + restitution) * vn) / normalDenom;
      applyImpulse(a, rax, ray, -nx * impulseN, -ny * impulseN);
      applyImpulse(b, rbx, rby, nx * impulseN, ny * impulseN);
    }
    const tx = -ny;
    const ty = nx;
    const tangentDenom =
      totalInvMass + a.invInertia * (rax * ty - ray * tx) * (rax * ty - ray * tx) + b.invInertia * (rbx * ty - rby * tx) * (rbx * ty - rby * tx);
    if (tangentDenom > 0) {
      const vt = pointVelocity(b, rbx, rby, tx, ty) - pointVelocity(a, rax, ray, tx, ty);
      const limit = CONTACT.friction * impulseN;
      let friction = -vt / tangentDenom;
      if (friction > limit) friction = limit;
      else if (friction < -limit) friction = -limit;
      applyImpulse(a, rax, ray, -tx * friction, -ty * friction);
      applyImpulse(b, rbx, rby, tx * friction, ty * friction);
    }
  }

  const lost = before - (kineticEnergy(a) + kineticEnergy(b));
  return { ...contact, impulseN, lostEnergyJ: lost > 0 ? lost : 0 };
}

/** Velocity of the material point at the lever arm along a unit axis. */
function pointVelocity(body: RigidBody, rx: number, ry: number, ax: number, ay: number): number {
  return (body.velocity.x - body.angularVelocity * ry) * ax + (body.velocity.y + body.angularVelocity * rx) * ay;
}

/** Impulse `(ix, iy)` applied at lever arm `(rx, ry)`, linear and angular parts. */
function applyImpulse(body: RigidBody, rx: number, ry: number, ix: number, iy: number): void {
  body.velocity = { x: body.velocity.x + ix * body.invMass, y: body.velocity.y + iy * body.invMass };
  body.angularVelocity += body.invInertia * (rx * iy - ry * ix);
}

// --- the tick ----------------------------------------------------------------------------------

interface SteppedBody {
  body: RigidBody;
  /** Time already integrated this tick; a contact never rewinds a body. */
  travelled: number;
  /** Exhausted movement: the body stops here instead of being pushed through geometry. */
  blocked: boolean;
}

/**
 * One contact step: broadphase on swept AABBs, sweep every candidate pair, resolve in ascending
 * time-of-impact order, then finish the integration. Bodies are integrated here (not by the
 * caller) so a contact can stop a body at the moment it actually happens. A body that reaches the
 * per-body TOI cap stops at its last safe position and is reported in `exhausted`; B5 forbids
 * silently tunnelling or deleting it.
 */
export function stepContacts(bodies: readonly RigidBody[], dt: number, maxToiPerBody: number): StepContacts {
  const byId = new Map<number, RigidBody>();
  const state = new Map<number, SteppedBody>();
  for (const body of bodies) {
    byId.set(body.id, body);
    state.set(body.id, { body, travelled: 0, blocked: false });
  }

  const hash = new SpatialHash();
  for (const body of bodies) {
    if (!body.collidable) continue;
    const box = aabbFromShape(body.shape, body.position, body.angle);
    const spin = Math.abs(body.angularVelocity) * dt * shapeRadiusM(body.shape);
    hash.insert(body.id, expandedAabb(sweptAabb(box, body.velocity, dt), spin));
  }

  const candidates: number[] = [];
  hash.pairs(candidates);
  const hits: Array<{ a: RigidBody; b: RigidBody; hit: SweepHit }> = [];
  for (let i = 0; i < candidates.length; i += 2) {
    const a = byId.get(candidates[i]);
    const b = byId.get(candidates[i + 1]);
    if (a === undefined || b === undefined) continue;
    // Layer bits name physical categories and the authority picks index membership (`world.ts`
    // filters the solid pass to ship|rock). Scenery is the one category B5 declares never physical,
    // so a pair touching it is skipped; everything else in the index is tested.
    if ((a.layer & LAYER.scenery) !== 0 || (b.layer & LAYER.scenery) !== 0) continue;
    const hit = sweepPair(a, b, dt);
    if (hit !== null) hits.push({ a, b, hit });
  }
  hits.sort((p, q) => p.hit.toi - q.hit.toi || p.a.id - q.a.id || p.b.id - q.b.id);

  const advance = (step: SteppedBody, toi: number): void => {
    if (toi <= step.travelled) return;
    integrateBody(step.body, toi - step.travelled);
    step.travelled = toi;
  };

  const contacts: Contact[] = [];
  const toiCount = new Map<number, number>();
  const exhausted = new Set<number>();
  for (const { a, b, hit } of hits) {
    const stepA = state.get(a.id);
    const stepB = state.get(b.id);
    if (stepA === undefined || stepB === undefined) continue;
    const countA = toiCount.get(a.id) ?? 0;
    const countB = toiCount.get(b.id) ?? 0;
    if (countA >= maxToiPerBody || countB >= maxToiPerBody) {
      if (countA >= maxToiPerBody) exhausted.add(a.id);
      if (countB >= maxToiPerBody) exhausted.add(b.id);
      stepA.blocked = true;
      stepB.blocked = true;
      continue;
    }
    toiCount.set(a.id, countA + 1);
    toiCount.set(b.id, countB + 1);
    advance(stepA, hit.toi);
    advance(stepB, hit.toi);
    let normal = hit.normal;
    let point = hit.point;
    let penetrationM = 0;
    if (hit.toi <= 0) {
      // Overlap at the start of the tick: recompute the real depth and direction at the pose.
      const overlap = satAt(a, b);
      if (overlap.overlap) {
        normal = { x: overlap.nx, y: overlap.ny };
        point = { x: overlap.px, y: overlap.py };
        penetrationM = overlap.depth;
      }
    }
    contacts.push(resolveContact(a, b, { a: a.id, b: b.id, normal, penetrationM, point, toi: hit.toi, lostEnergyJ: 0, impulseN: 0 }));
  }

  for (const step of state.values()) {
    if (!step.blocked) advance(step, dt);
  }

  return { contacts, exhausted: [...exhausted].sort((x, y) => x - y) };
}
