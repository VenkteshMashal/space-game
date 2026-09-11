import { clamp, createShip, length, SHIPS, stepShip } from './physics';
import { wrapAngle } from './combat';
import type { FlightInput, ShipState, Vec2 } from './physics';

export type AllyObstacle = { x: number; y: number; radius: number; hp?: number };

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
  // stepShip's forward vector is (-sin(angle), cos(angle)); use its inverse so the first burn
  // actually points down the route.
  state.angle = Math.atan2(at.x - first.x, first.y - at.y);
  return { id, name, state, route: route.length ? route : [{ ...at }], waypoint: 0, maxHull: hull, lost: false, damaged: false };
}

/**
 * A barge, not a fighter: point at the next waypoint, burn for it, and brake into each waypoint.
 * The third argument remains the cruise-speed cap; an obstacle list can be supplied as the third
 * argument or as a fourth argument for callers that already pass a custom cruise speed.
 */
export function stepAlly(
  ally: Ally,
  dt: number,
  cruiseOrObstacles: number | readonly AllyObstacle[] = 120,
  obstacleList: readonly AllyObstacle[] = [],
) {
  if (ally.lost) return;
  const cruise = typeof cruiseOrObstacles === 'number' ? cruiseOrObstacles : 120;
  const obstacles = typeof cruiseOrObstacles === 'number' ? obstacleList : cruiseOrObstacles;
  let target = ally.route[Math.min(ally.waypoint, ally.route.length - 1)];
  let toTarget = { x: target.x - ally.state.position.x, y: target.y - ally.state.position.y };
  const range = Math.hypot(toTarget.x, toTarget.y);
  if (range < 320 && ally.waypoint < ally.route.length - 1) {
    ally.waypoint++;
    target = ally.route[ally.waypoint];
    toTarget = { x: target.x - ally.state.position.x, y: target.y - ally.state.position.y };
  }
  const last = ally.waypoint >= ally.route.length - 1;
  const updatedRange = Math.hypot(toTarget.x, toTarget.y);
  const direction = updatedRange > 0.001
    ? { x: toTarget.x / updatedRange, y: toTarget.y / updatedRange }
    : { x: 0, y: 1 };
  const perpendicular = { x: -direction.y, y: direction.x };

  // Steer around nearby rocks by bending the desired bearing away from the first overlapping
  // corridor. Destroyed rocks remain in the nearby grid, so an optional hp field is respected.
  let avoidLateral = 0;
  const lookAhead = Math.max(520, Math.min(1500, updatedRange + length(ally.state.velocity) * 2));
  const hullRadius = Math.max(ally.state.collider.halfLength, ally.state.collider.halfWidth);
  for (const obstacle of obstacles) {
    if (obstacle.hp !== undefined && obstacle.hp <= 0) continue;
    const relative = { x: obstacle.x - ally.state.position.x, y: obstacle.y - ally.state.position.y };
    const along = relative.x * direction.x + relative.y * direction.y;
    const lateral = relative.x * perpendicular.x + relative.y * perpendicular.y;
    const clearance = obstacle.radius + hullRadius + 90;
    if (along < -clearance || along > lookAhead || Math.abs(lateral) >= clearance) continue;
    const urgency = clamp(1 - Math.max(0, along) / lookAhead, 0.15, 1);
    const strength = (clearance - Math.abs(lateral)) / clearance * urgency;
    avoidLateral += (lateral >= 0 ? -1 : 1) * strength;
  }
  const desired = {
    x: direction.x + perpendicular.x * avoidLateral * 1.6,
    y: direction.y + perpendicular.y * avoidLateral * 1.6,
  };
  const desiredLength = Math.hypot(desired.x, desired.y) || 1;
  desired.x /= desiredLength;
  desired.y /= desiredLength;

  const wantBearing = Math.atan2(desired.y, desired.x);
  // stepShip's hull axis is angle + PI/2, the same convention the hostiles steer by.
  const error = wrapAngle(wantBearing - (ally.state.angle + Math.PI / 2));
  const input: FlightInput = { thrust: 0, turn: 0, strafe: 0, brake: false, boost: false };
  input.turn = clamp(error * 2.2 - ally.state.angularVelocity * 0.8, -1, 1);

  // Project velocity onto the route, rather than treating total speed as closing speed.
  const closing = ally.state.velocity.x * desired.x + ally.state.velocity.y * desired.y;
  const acceleration = ally.state.spec.thrust / Math.max(1, ally.state.spec.mass + ally.state.fuel);
  const brakingAcceleration = Math.max(0.01, acceleration * 0.65);
  const stopDistance = (Math.max(0, closing) ** 2) / (2 * brakingAcceleration) + (last ? 150 : 260);
  // The cap is scaled by available acceleration over a fixed cruise horizon, so mass and thrust
  // affect both how fast the barge travels and how early it begins its counterburn.
  const cruiseSpeed = Math.min(Math.max(1, cruise), Math.sqrt(2 * Math.max(0.01, acceleration) * 1800));
  const canAccelerate = updatedRange > stopDistance && Math.abs(error) < 1.2 && closing < cruiseSpeed;
  input.thrust = canAccelerate ? clamp((cruiseSpeed - closing) / cruiseSpeed, 0.12, 1) : 0;
  input.brake = closing > 0 && (closing > cruiseSpeed || updatedRange <= stopDistance);
  // stepShip's right vector is opposite this perpendicular when the hull points at desired.
  input.strafe = clamp(-avoidLateral, -1, 1);

  stepShip(ally.state, input, dt);
  if (ally.state.hull <= 0) ally.lost = true;
  else if (ally.state.hull < ally.maxHull * 0.6) ally.damaged = true;
}
