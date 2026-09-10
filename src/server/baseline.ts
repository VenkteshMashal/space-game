/**
 * Baseline transfer payload (Plan B3). The codec interns strings per frame and caps one frame's
 * table delta at 64 entries, so a cold connection cannot receive eight fully-fitted ships in a
 * single snapshot frame. A baseline is therefore a short ordered sequence of snapshot frames that
 * the receiver decodes with the same `StringTable` in the same order: after the transfer both sides
 * hold identical interning state, which is what keeps later snapshot deltas small.
 *
 * Each frame is sent as one binary message between `baseline-header` and `baseline-end`, which is
 * exactly how the client adapter collects and installs them.
 *
 * Order matters: the owner's self and first ship come first, then the remaining ships, then
 * objectives and contacts, then rock bodies, then projectiles (whose owner life ids were interned
 * with the ships).
 */

import { decodeSnapshot, encodeSnapshot, HEADER_BYTES, StringTable } from '../shared/codec.ts';
import type {
  BodyView, ContactView, Id, MapDescriptor, ObjectiveView, ProjectileView, SelfAuthority, ShipView, Snapshot,
} from '../shared/contracts.ts';
import { hash32, hex8 } from '../shared/ids.ts';
import { fail, ok } from '../shared/validate.ts';
import type { Result } from '../shared/validate.ts';

/** Entities per frame, chosen so no frame can exceed the codec's 64-entry table delta. */
const SHIPS_PER_FRAME = 1;
const OBJECTIVES_PER_FRAME = 24;
const CONTACTS_PER_FRAME = 48;
const BODIES_PER_FRAME = 48;
const PROJECTILES_PER_FRAME = 48;
const MAX_BASELINE_FRAMES = 32;
const MAX_BASELINE_BYTES = 1024 * 1024;

export interface BaselineInstall {
  epoch: Id;
  tick: number;
  eventWatermark: number;
  baselineId: Id;
  frameCount: number;
  self: SelfAuthority | null;
  ships: readonly ShipView[];
  bodies: readonly BodyView[];
  projectiles: readonly ProjectileView[];
  contacts: readonly ContactView[];
  objectives: readonly ObjectiveView[];
  teamScores: Readonly<Record<Id, number>>;
}

interface BatchPlan {
  self: SelfAuthority | null;
  ships: readonly ShipView[];
  bodies: readonly BodyView[];
  projectiles: readonly ProjectileView[];
  contacts: readonly ContactView[];
  objectives: readonly ObjectiveView[];
}

function planBatches(snapshot: Snapshot): BatchPlan[] {
  const batches: BatchPlan[] = [];
  const push = (part: Partial<BatchPlan>): void => {
    batches.push({
      self: part.self ?? null,
      ships: part.ships ?? [],
      bodies: part.bodies ?? [],
      projectiles: part.projectiles ?? [],
      contacts: part.contacts ?? [],
      objectives: part.objectives ?? [],
    });
  };
  let shipIndex = 0;
  if (snapshot.self !== null) {
    push({ self: snapshot.self, ships: snapshot.ships.slice(0, 1) });
    shipIndex = 1;
  }
  for (; shipIndex < snapshot.ships.length; shipIndex += SHIPS_PER_FRAME) {
    push({ ships: snapshot.ships.slice(shipIndex, shipIndex + SHIPS_PER_FRAME) });
  }
  for (let index = 0; index < snapshot.objectives.length; index += OBJECTIVES_PER_FRAME) {
    push({ objectives: snapshot.objectives.slice(index, index + OBJECTIVES_PER_FRAME) });
  }
  for (let index = 0; index < snapshot.contacts.length; index += CONTACTS_PER_FRAME) {
    push({ contacts: snapshot.contacts.slice(index, index + CONTACTS_PER_FRAME) });
  }
  for (let index = 0; index < snapshot.bodies.length; index += BODIES_PER_FRAME) {
    push({ bodies: snapshot.bodies.slice(index, index + BODIES_PER_FRAME) });
  }
  for (let index = 0; index < snapshot.projectiles.length; index += PROJECTILES_PER_FRAME) {
    push({ projectiles: snapshot.projectiles.slice(index, index + PROJECTILES_PER_FRAME) });
  }
  return batches;
}

/** Ordered snapshot frames sharing one `StringTable`; send each one as its own binary message. */
export function encodeBaselineFrames(snapshot: Snapshot, table: StringTable): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let bytes = 0;
  for (const batch of planBatches(snapshot)) {
    const frame = encodeSnapshot(
      {
        header: snapshot.header,
        self: batch.self,
        ships: batch.ships,
        bodies: batch.bodies,
        projectiles: batch.projectiles,
        contacts: batch.contacts,
        objectives: batch.objectives,
        teamScores: snapshot.teamScores,
        inventoryRevision: snapshot.inventoryRevision,
      },
      table,
    );
    frames.push(frame);
    bytes += frame.length;
    // The caps bound one transfer; a world that needs more cannot be sent in one baseline and the
    // client waits for the next attempt rather than receiving a partial transfer.
    if (bytes > MAX_BASELINE_BYTES || frames.length >= MAX_BASELINE_FRAMES) break;
  }
  return frames;
}

/** Walks received frames in order, rebuilding the same table and the same entity set. */
export function decodeBaselineFrames(frames: readonly Uint8Array[], table: StringTable): Result<BaselineInstall> {
  const ships = new Map<Id, ShipView>();
  const bodies = new Map<Id, BodyView>();
  const projectiles = new Map<Id, ProjectileView>();
  const contacts = new Map<Id, ContactView>();
  const objectives: ObjectiveView[] = [];
  let teamScores: Record<Id, number> = {};
  let self: SelfAuthority | null = null;
  let frameCount = 0;
  let tick = 0;
  let epoch = '';
  let watermark = 0;
  let baselineId = '';
  for (const frame of frames) {
    if (frame.length < HEADER_BYTES) return fail('out-of-range', 'truncated baseline frame');
    const decoded = decodeSnapshot(frame, table);
    if (!decoded.ok) return fail(decoded.code, `baseline frame ${frameCount}: ${decoded.detail}`);
    const snapshot = decoded.value;
    if (frameCount === 0) {
      tick = snapshot.header.tick;
      epoch = snapshot.header.epoch;
      watermark = snapshot.header.eventWatermark;
      baselineId = snapshot.header.baselineId;
    } else if (snapshot.header.tick !== tick || snapshot.header.epoch !== epoch) {
      return fail('bad-enum', `baseline frame ${frameCount} changed tick or epoch`);
    }
    if (snapshot.self !== null) self = snapshot.self;
    for (const ship of snapshot.ships) ships.set(ship.id, ship);
    for (const body of snapshot.bodies) bodies.set(body.id, body);
    for (const projectile of snapshot.projectiles) projectiles.set(projectile.id, projectile);
    for (const contact of snapshot.contacts) contacts.set(contact.id, contact);
    for (const objective of snapshot.objectives) objectives.push(objective);
    teamScores = { ...teamScores, ...snapshot.teamScores };
    frameCount += 1;
  }
  if (frameCount === 0) return fail('out-of-range', 'empty baseline');
  return ok({
    epoch,
    tick,
    eventWatermark: watermark,
    baselineId,
    frameCount,
    self,
    ships: [...ships.values()],
    bodies: [...bodies.values()],
    projectiles: [...projectiles.values()],
    contacts: [...contacts.values()],
    objectives,
    teamScores,
  });
}

/** FNV-1a over the payload bytes, widened to 64 bits with a reverse pass. Not security. */
export function payloadHash(frames: readonly Uint8Array[]): Id {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let total = 0;
  for (const frame of frames) {
    for (let index = 0; index < frame.length; index++) {
      first ^= frame[index]!;
      first = Math.imul(first, 0x01000193) >>> 0;
    }
    for (let index = frame.length - 1; index >= 0; index--) {
      second ^= frame[index]!;
      second = Math.imul(second, 0x85ebca6b) >>> 0;
    }
    total += frame.length;
  }
  return `${hex8(first)}${hex8(second)}${hex8(total)}`;
}

/** Stable map identity carried in the baseline header and re-checked before install. */
export function mapHashOf(map: MapDescriptor): Id {
  return hex8(hash32(`${map.id}:${map.schemaVersion}:${map.generatorVersion}:${map.seed}:${Math.round(map.boundsRadiusM)}`));
}
