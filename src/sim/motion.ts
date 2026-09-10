/**
 * Flight motion and power allocation (Plan B5/B6). This is the *one* implementation of ship motion:
 * the authority calls it inside its 120 Hz step, and the client calls it again to replay predicted
 * inputs (B4.6). A second copy on the client would silently drift from the server, so there isn't
 * one.
 *
 * Everything is in-place and allocation-free: the 120 Hz loop and the replay loop both run this
 * thousands of times per second.
 */

import { CLAMPS, RCS_FUEL_KG_S } from '../shared/balance.ts';
import type { FitDerivation, FlightIntent, SlotKind, Vec2 } from '../shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT } from '../shared/contracts.ts';

export interface MotionBody {
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
}

export interface MotionResources {
  fuelKg: number;
  heatMJ: number;
  capacitorMJ: number;
}

export interface PowerDemand {
  engineMW: number;
  weaponMW: number;
  utilityMW: number;
  sensorMW: number;
}

export interface PowerAllocation extends PowerDemand {
  /** False when a lower-priority group was browned out this tick (B6). */
  powered: boolean;
}

/** Fixed priority allocation: life support and flight first, then groups, utilities and charging. */
export function allocatePower(derived: FitDerivation, priority: readonly SlotKind[], demand: PowerDemand, supplyScale = 1): PowerAllocation {
  const budget = Math.max(0, derived.powerSupplyMW * supplyScale - derived.idleDemandMW);
  const allocation: PowerAllocation = { engineMW: 0, weaponMW: 0, utilityMW: 0, sensorMW: 0, powered: true };
  let spent = 0;
  for (const kind of priority) {
    const need = demandFor(demand, kind);
    const granted = Math.min(need, Math.max(0, budget - spent));
    spent += granted;
    switch (kind) {
      case 'engine': allocation.engineMW = granted; break;
      case 'weapon': allocation.weaponMW = granted; break;
      case 'utility': allocation.utilityMW = granted; break;
      case 'sensor': allocation.sensorMW = granted; break;
      default: break;
    }
    if (granted < need) {
      // A brownout is visible to the player; it never silently rewrites the fitted ship.
      if (kind === 'weapon') allocation.powered = false;
      break;
    }
  }
  return allocation;
}

function demandFor(demand: PowerDemand, kind: SlotKind): number {
  switch (kind) {
    case 'engine': return demand.engineMW;
    case 'weapon': return demand.weaponMW;
    case 'utility': return demand.utilityMW;
    case 'sensor': return demand.sensorMW;
    default: return 0;
  }
}

export interface MotionInput {
  body: MotionBody;
  resources: MotionResources;
  derived: FitDerivation;
  priority: readonly SlotKind[];
  intent: FlightIntent;
  dt: number;
  scanning: boolean;
  /** Electrical draw of the groups the pilot is holding the trigger on. */
  weaponDemandMW: number;
  /** Engine module output, 0..1; a damaged drive pushes less, a destroyed one not at all (B6). */
  thrustScale?: number;
  /** Reactor module output, 0..1; it multiplies electrical supply, not torch thrust (B6). */
  supplyScale?: number;
  /** Recovered cargo: part of wet mass, so a loaded ship accelerates and stops differently (B5). */
  cargoMassKg?: number;
}

const FORWARD_X = (angle: number) => -Math.sin(angle);
const FORWARD_Y = (angle: number) => Math.cos(angle);

/**
 * One fixed step of powered flight: velocity, rotation rate and resources. Position integration is
 * deliberately *not* here — the contact step advances every body to the end of the tick with
 * time-of-impact accuracy, and a second integrator would move ships and rocks twice per tick.
 * Returns the power allocation so the caller gates weapons on the same decision it just made.
 */
export function stepMotion(input: MotionInput): PowerAllocation {
  const { body, resources, derived, intent, dt } = input;
  const intentOrIdle = intent ?? EMPTY_FLIGHT_INTENT;
  const thrustScale = input.thrustScale ?? 1;
  const supplyScale = input.supplyScale ?? 1;
  const thrusting = Math.abs(intentOrIdle.thrust) > 0 || intentOrIdle.brake;
  const allocation = allocatePower(derived, input.priority, {
    engineMW: thrusting ? 1.2 : 0,
    weaponMW: input.weaponDemandMW,
    utilityMW: 0,
    sensorMW: input.scanning ? derived.activeScanMW : 0,
  }, supplyScale);

  const hasFuel = resources.fuelKg > 0;
  const mass = Math.max(1, derived.wetMassKg + (input.cargoMassKg ?? 0));
  const forwardX = FORWARD_X(body.angle);
  const forwardY = FORWARD_Y(body.angle);
  const rightX = Math.cos(body.angle);
  const rightY = Math.sin(body.angle);
  const axial = clampAxis(intentOrIdle.thrust);
  const strafe = clampAxis(intentOrIdle.strafe);
  const boost = intentOrIdle.boost && axial > 0;
  const driveFactor = axial >= 0 ? 1 : derived.reverseFactor;
  const thrustAuthority = hasFuel ? derived.thrustN * thrustScale * (boost ? derived.boostFactor : 1) : 0;

  let forceX = forwardX * axial * driveFactor * thrustAuthority + rightX * strafe * derived.lateralFactor * (hasFuel ? derived.thrustN : 0);
  let forceY = forwardY * axial * driveFactor * thrustAuthority + rightY * strafe * derived.lateralFactor * (hasFuel ? derived.thrustN : 0);
  let fuelDraw = (Math.abs(axial) * derived.fuelKgS + Math.abs(strafe) * RCS_FUEL_KG_S.lateral) * dt;

  if (intentOrIdle.brake && hasFuel) {
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > 1e-3) {
      // Braking deliberately cancels velocity, spending the RCS budget to do it (B5).
      const stopForce = (speed / dt) * mass;
      const available = derived.thrustN * (derived.brakeFactor + derived.lateralFactor);
      const decel = Math.min(stopForce, available);
      forceX -= (body.velocity.x / speed) * decel;
      forceY -= (body.velocity.y / speed) * decel;
      fuelDraw += RCS_FUEL_KG_S.brake * dt * Math.min(1, speed);
    }
  }

  if (hasFuel) resources.fuelKg = Math.max(0, resources.fuelKg - fuelDraw);
  body.velocity = { x: body.velocity.x + (forceX / mass) * dt, y: body.velocity.y + (forceY / mass) * dt };

  // Rotation: RCS torque, with assist cancelling residual spin when the pilot is not turning.
  // Position and angle are integrated by the contact step, which advances every body to the end of
  // the tick with time-of-impact accuracy; integrating them here as well would move ships twice.
  const turn = clampAxis(intentOrIdle.turn);
  const torqueAuthority = hasFuel ? derived.rcsTorqueMNm * 1e6 * thrustScale : 0;
  const inertia = Math.max(1, derived.inertiaKgM2);
  if (Math.abs(turn) > 1e-3) {
    body.angularVelocity += (turn * torqueAuthority / inertia) * dt;
    resources.fuelKg = Math.max(0, resources.fuelKg - RCS_FUEL_KG_S.turn * dt);
  } else if (intentOrIdle.angularAssist && hasFuel && body.angularVelocity !== 0) {
    const damped = body.angularVelocity * Math.max(0, 1 - (torqueAuthority / inertia) * dt / Math.max(1e-3, Math.abs(body.angularVelocity)));
    body.angularVelocity = Math.abs(damped) < 1e-4 ? 0 : damped;
  }

  // Heat: reactor and drive load minus cooling, floored at ambient zero (B6).
  const driveHeat = Math.abs(axial) * (boost ? 1.6 : 0.8) + input.weaponDemandMW * 0.35;
  const heat = resources.heatMJ + (derived.heatMW * 0.5 + driveHeat - derived.coolingMW) * dt;
  resources.heatMJ = Math.max(0, Math.min(derived.heatCapacityMJ, heat));

  // Capacitor charges from whatever supply nothing else is using (B6).
  const surplus = Math.max(0, derived.powerSupplyMW - derived.idleDemandMW - allocation.weaponMW - allocation.utilityMW - allocation.sensorMW);
  const chargeMW = Math.min(surplus, CLAMPS.capacitorBaseMW + derived.capacitorChargeLimitMW);
  resources.capacitorMJ = Math.min(derived.capacitorMJ, resources.capacitorMJ + chargeMW * dt);

  return allocation;
}

export function clampAxis(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Angles stay in (-π, π] so interpolation and hashing never see a 2π wrap as a huge turn. */
export function normalizeAngle(angle: number): number {
  const wrapped = angle % (Math.PI * 2);
  if (wrapped > Math.PI) return wrapped - Math.PI * 2;
  if (wrapped <= -Math.PI) return wrapped + Math.PI * 2;
  return wrapped;
}

export function speedOf(velocity: Vec2): number {
  return Math.hypot(velocity.x, velocity.y);
}
