/**
 * Sensors and contacts (Plan B6). Enemy information is governed by detection, not by hiding fields
 * the client already received: an occluded contact ages to an uncertain last-known position and then
 * expires, and an uncertain contact cannot be locked or shot at with guided weapons.
 */

import { SENSOR } from '../shared/balance.ts';
import type { ContactView, Id, Vec2 } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import { lineOfSightBlocked } from '../shared/geometry.ts';
import type { Rng } from '../shared/rng.ts';
import { createRng } from '../shared/rng.ts';

export interface ContactState {
  id: Id;
  kind: ContactView['kind'];
  teamId: Id;
  position: Vec2;
  velocity: Vec2;
  /** True while the contact is directly observed; false once it is an aged last-known position. */
  observed: boolean;
  lastSeenTick: number;
  /** Fitted passive range of the contact's own sensor, for its signature when it scans. */
  scanning: boolean;
  signature: number;
}

export interface SensorInput {
  tick: number;
  observerTeamId: Id;
  observerPosition: Vec2;
  observerBonuses: { passiveRangeM: number; activeRangeM: number; scanMultiplier: number };
  /** Drives both the reachable set and the signature multiplier. */
  targets: readonly { id: Id; teamId: Id; position: Vec2; velocity: Vec2; boosting: boolean; coasting: boolean; signatureMultiplier: number; radiusM: number }[];
  /** Solids that block line of sight; circles are enough for rocks and rib sections. */
  occluders: readonly { position: Vec2; radiusM: number }[];
  arenaRadiusM: number;
}

export interface SensorOutput {
  contacts: ContactView[];
  /** Contacts that may be locked or engaged by guided weapons right now. */
  targetable: readonly Id[];
}

/** Contacts closer than this are public because the pilot can simply see the hull. */
export function isPublicSilhouette(distanceM: number): boolean {
  return distanceM <= SENSOR.publicSilhouetteRangeM;
}

export function signatureFor(target: SensorInput['targets'][number], scanning: boolean): number {
  const drive = target.coasting ? SENSOR.signatureCoast : target.boosting ? SENSOR.signatureBoost : SENSOR.signatureNormal;
  const radiator = target.signatureMultiplier;
  const raw = drive * radiator * (scanning ? 1.5 : 1);
  const [low, high] = SENSOR.passiveRangeClamp;
  return Math.min(high, Math.max(low, raw));
}

export function updateSensors(input: SensorInput, previous: readonly ContactView[]): SensorOutput {
  const byId = new Map(previous.map(contact => [contact.id, contact]));
  const contacts: ContactView[] = [];
  const targetable: Id[] = [];
  for (const target of input.targets) {
    if (target.teamId === input.observerTeamId) {
      contacts.push({
        id: target.id,
        kind: 'crew',
        position: { x: target.position.x, y: target.position.y },
        uncertaintyM: 0,
        ageTicks: 0,
        targetable: false,
      });
      continue;
    }
    const distance = Math.hypot(target.position.x - input.observerPosition.x, target.position.y - input.observerPosition.y);
    const blocked = lineOfSightBlocked(input.observerPosition, target.position, input.occluders);
    const publicBubble = isPublicSilhouette(distance) && !blocked;
    const passiveReach = input.observerBonuses.passiveRangeM * signatureFor(target, false);
    const withinPassive = !blocked && distance <= passiveReach;
    const withinActive = !blocked && distance <= input.observerBonuses.activeRangeM;
    const seen = publicBubble || withinPassive || withinActive;
    if (seen) {
      contacts.push({
        id: target.id,
        kind: 'hostile',
        position: { x: target.position.x, y: target.position.y },
        uncertaintyM: 0,
        ageTicks: 0,
        targetable: true,
      });
      targetable.push(target.id);
      continue;
    }
    const stale = byId.get(target.id);
    if (!stale) continue;
    const ageTicks = stale.ageTicks + 1;
    if (ageTicks > SENSOR.uncertainSeconds * RELEASE.physicsHz) continue;
    contacts.push({ id: target.id, kind: 'unknown', position: stale.position, uncertaintyM: Math.min(400, stale.uncertaintyM + 6), ageTicks, targetable: false });
  }
  return { contacts, targetable };
}

export interface LockTracker {
  /** Continuous line-of-sight time per contact, in ticks. */
  progress: Map<Id, number>;
  /** Ticks since the last valid sighting, used to break an existing lock. */
  gap: Map<Id, number>;
}

export function createLockTracker(): LockTracker {
  return { progress: new Map(), gap: new Map() };
}

/** Guided weapons need one second of continuous detection, broken after a quarter-second gap. */
export function updateLock(tracker: LockTracker, targetable: readonly Id[]): void {
  const seen = new Set(targetable);
  for (const [id, ticks] of tracker.progress) {
    if (seen.has(id)) {
      tracker.gap.set(id, 0);
      tracker.progress.set(id, ticks + 1);
    } else {
      const gap = (tracker.gap.get(id) ?? 0) + 1;
      tracker.gap.set(id, gap);
      if (gap > SENSOR.lockGapSeconds * RELEASE.physicsHz) tracker.progress.set(id, 0);
    }
  }
  for (const id of targetable) if (!tracker.progress.has(id)) tracker.progress.set(id, 1);
}

export function lockEstablished(tracker: LockTracker, contactId: Id): boolean {
  return (tracker.progress.get(contactId) ?? 0) >= SENSOR.lockSeconds * RELEASE.physicsHz;
}

/** ECM resolves as one sampled contest per activation, never a per-tick reroll. */
export function ecmContest(rng: Rng, hasSurveySupport: boolean): boolean {
  return rng.chance(hasSurveySupport ? SENSOR.ecmSupportedChance : SENSOR.ecmStandardChance);
}

export function seekerRng(seed: number, projectileId: number): Rng {
  return createRng(seed, 'sensor', projectileId);
}
