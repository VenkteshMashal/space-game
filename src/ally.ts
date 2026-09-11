import { clamp, createShip, length, SHIPS, stepShip } from './physics';
import { wrapAngle } from './combat';
import type { FlightInput, ShipState, Vec2 } from './physics';

/** An NPC the player is paid to keep alive. It flies a route and takes hostile fire. */
export type Ally = {
  id: string;
  name: string;
  state: ShipState;
  route: Vec2[];
  waypoint: number;
  maxHull: number;
  /** True once the hull is gone: the escort is over, whichever contract was running. */
  lost: boolean;
  damaged: boolean;
};

const HAULER_THRUST = 640000;

export function createAlly(id: string, name: string, at: Vec2, route: Vec2[], hull: number): Ally {
  const spec = { ...SHIPS.mule, name, role: 'Ore barge', thrust: HAULER_THRUST, torque: 0.42, hull };
  const state = createShip('mule', spec);
  state.position = { x: at.x, y: at.y };
  state.velocity = { x: 0, y: 0 };
  const first = route[0] ?? at;
  state.angle = Math.atan2(first.x - at.x, first.y - at.y);
  return { id, name, state, route: route.length ? route : [{ ...at }], waypoint: 0, maxHull: hull, lost: false, damaged: false };
}

const input: FlightInput = { thrust: 0, turn: 0, strafe: 0, brake: false, boost: false };

/**
 * A barge, not a fighter: point at the next waypoint, burn for it, brake into the last one. It does
 * not dodge, which is exactly why the contract pays.
 */
export function stepAlly(ally: Ally, dt: number, cruise = 120) {
  if (ally.lost) return;
  const last = ally.waypoint >= ally.route.length - 1;
  const target = ally.route[Math.min(ally.waypoint, ally.route.length - 1)];
  const toTarget = { x: target.x - ally.state.position.x, y: target.y - ally.state.position.y };
  const range = Math.hypot(toTarget.x, toTarget.y);
  if (range < 320 && !last) ally.waypoint++;

  const wantBearing = Math.atan2(toTarget.y, toTarget.x);
  // stepShip's hull axis is angle + PI/2, the same convention the hostiles steer by.
  const error = wrapAngle(wantBearing - (ally.state.angle + Math.PI / 2));
  input.turn = clamp(error * 2.2 - ally.state.angularVelocity * 0.8, -1, 1);

  const speed = length(ally.state.velocity);
  const closing = speed * Math.cos(error);
  // Braking distance for the 0.45 g it can pull, plus a stop inside the arrival radius.
  const stopDistance = (closing * closing) / (2 * 4.4) + (last ? 150 : 260);
  input.thrust = range > stopDistance && Math.abs(error) < 1.2 ? clamp((range - stopDistance) / 300, 0, 1) : 0;
  input.brake = last && range < 640 && closing > 1;
  input.strafe = 0;
  input.boost = false;

  stepShip(ally.state, input, dt);
  if (ally.state.hull <= 0) ally.lost = true;
  else if (ally.state.hull < ally.maxHull * 0.6) ally.damaged = true;
}
