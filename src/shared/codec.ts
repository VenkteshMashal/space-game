/**
 * Versioned compact binary frames (Plan B3). One codec, one layout: the authority encodes, every
 * client decodes, and no other module re-derives these bytes.
 *
 * Frame = 40-byte little-endian header, then the string-table delta, then the body:
 *
 *   0  u32 magic           0x44524654
 *   4  u16 version         RELEASE.protocol
 *   6  u8  frameType       1 snapshot, 2 baseline header, 3 baseline chunk, 4 events
 *   7  u8  flags
 *   8  u32 length          bytes after the header (delta + body)
 *  12  u32 epochTableId    string-table revision this frame was encoded against
 *  16  u32 primaryId       interned id: snapshot baseline id, baseline transfer id, 0 for events
 *  20  u32 stateSeq        24 u32 tick        28 u32 eventWatermark
 *  32  u16 ships           34 u16 bodies      36 u16 projectiles    38 u16 contacts
 *
 * Entities are keyed `u32 id + u16 generation + u16 field mask` (8 bytes). Mask bits: 1 transform,
 * 2 velocity, 4 hull, 8 life, 16 fit, 32 team. Each section accepts exactly its own mask, so a
 * partial entity is rejected rather than defaulted: merging a delta onto cached state needs that
 * cached state, which a stateless codec does not have.
 *
 * Numbers: positions, velocities and angular state are float32 on the wire, angular values sharing
 * that precision budget; every other magnitude is float64; ticks and sequences are uint32. Health
 * is quantized to a declared 0.1 hull resolution — `round(hull * 10)` as uint16 — so the authority
 * rounds once here and the predictor compares the number it can actually reproduce instead of a
 * full-double reading it never sees.
 *
 * Ids are interned. `StringTable` maps string -> uint32 with 0 reserved for null; a frame carries
 * the entries it added (at most 64 entries, at most 64 bytes each, NFC text) and the resulting
 * revision in `epochTableId`, so a decoder notices a table that drifted before it resolves
 * anything. An unknown id is invalid, never a silent empty string.
 *
 * Decoding is total: every read is bounds-checked, a malformed frame returns `Invalid`, and the
 * decoder never throws nor reads past the end. Counts are unsigned on the wire, so a negative
 * count cannot exist; every count is instead checked against its cap before it can drive a loop.
 * Encoding trusts authority state and throws `RangeError` only when the frame would break a
 * decoder cap — a producer bug must fail at its source, not arrive as bytes the peer rejects. One
 * consequence is deliberate: a cold table cannot carry a full eight-ship snapshot with per-pilot
 * fits, so the baseline warms the table with that static metadata before snapshots start (B3).
 */

import type {
  BaselineChunk,
  BaselineHeader,
  BodyView,
  CollisionShape,
  ContactView,
  DerivedFit,
  EventPayloadByKind,
  Fit,
  FlightIntent,
  Id,
  Life,
  NoticeCode,
  ObjectiveView,
  PredictionState,
  ProjectileView,
  ScheduledInput,
  SelfAuthority,
  SessionEvent,
  SessionEventKind,
  ShipView,
  SlotKind,
  Snapshot,
  Vec2,
  WeaponView,
} from './contracts.ts';
import { RELEASE } from './contracts.ts';
import { boundedString, fail, ok } from './validate.ts';
import type { Invalid, InvalidCode, Result } from './validate.ts';

const MAGIC = 0x44524654;
const LE = true;

/** Fixed header size; every frame starts with exactly this many bytes. */
export const HEADER_BYTES = 40;
/** Entity key: uint32 id, uint16 generation, uint16 field mask. */
export const ENTITY_KEY_BYTES = 8;

export const FRAME = {
  snapshot: 1,
  baselineHeader: 2,
  baselineChunk: 3,
  events: 4,
} as const;
type FrameType = (typeof FRAME)[keyof typeof FRAME];

const TRANSFORM = 1;
const VELOCITY = 2;
const HULL = 4;
const LIFE = 8;
const FIT = 16;
const TEAM = 32;

const SHIP_MASK = TRANSFORM | VELOCITY | HULL | LIFE | FIT | TEAM;
const BODY_MASK = TRANSFORM | VELOCITY | HULL;
const PROJECTILE_MASK = TRANSFORM | VELOCITY | TEAM;
const CONTACT_MASK = TRANSFORM;

const CAP = {
  ships: 8,
  bodies: 256,
  projectiles: 512,
  contacts: 64,
  objectives: 32,
  teamScores: 8,
  tableEntries: 64,
  tableEntryBytes: 64,
  weapons: 32,
  scheduledInputs: 16,
  fitSlots: 64,
  fireGroups: 8,
  groupSlots: 16,
  derivedErrors: 8,
  convexVertices: 32,
  events: 32,
  chunks: 32,
} as const;

const MAX_TEXT_BYTES = 512;
const MAX_TITLE_BYTES = 128;
const MAX_REASON_BYTES = 256;
const MAX_HASH_BYTES = 16;
const MAX_MAP_HASH_BYTES = 64;
/**
 * Structural ceiling only. The B3 per-direction limits (16 KiB client frames, 6 KiB snapshots) are
 * transport policy; a 512-projectile snapshot is legal here and bigger than a client frame.
 */
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024;
const MAX_TABLE_DELTA_BYTES = 2 + CAP.tableEntries * (2 + CAP.tableEntryBytes);
const MAX_CHUNK_FRAME_BYTES = MAX_CHUNK_BYTES + MAX_TABLE_DELTA_BYTES + 64;
const MAX_BASELINE_BYTES = 1024 * 1024;

/** Health resolution on the wire; see the quantization note in the module header. */
const HEALTH_SCALE = 10;
const HEALTH_MAX = 0xffff;

/** 0.1 hull resolution as uint16: `round(hull * 10)`, clamped to the field width. */
function quantizeHealth(value: number): number {
  const scaled = Math.round(value * HEALTH_SCALE);
  return scaled < 0 ? 0 : scaled > HEALTH_MAX ? HEALTH_MAX : scaled;
}

const SHAPE_CIRCLE = 1;
const SHAPE_CAPSULE = 2;
const SHAPE_CONVEX = 3;

const LIFE_CODES: readonly Life[] = ['staged', 'alive', 'disabled', 'destroyed', 'respawning', 'spectating'];
const SLOT_KIND_CODES: readonly SlotKind[] = ['weapon', 'engine', 'reactor', 'armor', 'sensor', 'utility'];
const CONTACT_KIND_CODES: readonly ContactView['kind'][] = ['crew', 'hostile', 'unknown', 'objective', 'hazard'];
const PROJECTILE_STATE_CODES: readonly ProjectileView['state'][] = ['unarmed', 'armed', 'burning', 'coasting'];
const OBJECTIVE_STATE_CODES: readonly ObjectiveView['state'][] = ['locked', 'active', 'complete', 'failed'];
const EVENT_KIND_CODES: readonly SessionEventKind[] = ['shot', 'impact', 'life', 'roster', 'objective', 'result', 'save', 'notice'];
const HIT_KIND_CODES = ['ship', 'rock', 'station', 'projectile'] as const;
const ROSTER_REASON_CODES = ['join', 'leave', 'reconnect', 'captain', 'seat', 'ready'] as const;
const OUTCOME_CODES = ['victory', 'defeat', 'draw', 'no-contest', 'mission-complete', 'mission-failed'] as const;
const SAVE_STATE_CODES = ['pending', 'saved', 'failed'] as const;
const NOTICE_CODES: readonly NoticeCode[] = [
  'weapon-traffic-limit',
  'insufficient-power',
  'thermal-limit',
  'no-ammo',
  'reloading',
  'invalid-target',
  'out-of-range',
  'not-docked',
  'hostile-nearby',
  'cargo-full',
  'insufficient-credits',
  'already-recovered',
  'tow-dispatched',
  'checkpoint-restored',
  'vote-started',
  'vote-resolved',
  'disconnect-grace',
];

const EMPTY_BYTES = new Uint8Array(0);
const UTF8 = new TextEncoder();
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

function frameCap(value: number, max: number, what: string): number {
  if (value > max) throw new RangeError(`${what} ${value} exceeds ${max}`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// String interning
// ---------------------------------------------------------------------------------------------

/**
 * Wire string table. Both peers append in the same order, so an index is stable for the life of a
 * connection and a repeated id costs four bytes instead of its text.
 */
export class StringTable {
  private readonly byText: Record<string, number | undefined> = Object.create(null);
  private readonly byIndex: string[] = [];
  private tableRevision = 0;

  /** Index of `value`; 0 is reserved for null, so entries start at 1. */
  intern(value: string): number {
    const existing = this.byText[value];
    return existing === undefined ? this.append(value) : existing;
  }

  internId(value: Id | null): number {
    return value === null ? 0 : this.intern(value);
  }

  /** 0 is the null id, a string is known text, `undefined` is an id this table never saw. */
  get(index: number): string | null | undefined {
    return index === 0 ? null : this.byIndex[index - 1];
  }

  get revision(): number {
    return this.tableRevision;
  }

  get size(): number {
    return this.byIndex.length;
  }

  /** Append one decoded delta entry. Re-adding known text keeps the newest index resolvable. */
  append(value: string): number {
    const index = this.byIndex.length + 1;
    this.byIndex.push(value);
    this.byText[value] = index;
    this.tableRevision += 1;
    return index;
  }

  /** Drop everything added past `size`; a frame that fails to assemble must not poison the table. */
  truncate(size: number): void {
    while (this.byIndex.length > size) {
      const value = this.byIndex.pop();
      if (value !== undefined) delete this.byText[value];
      this.tableRevision -= 1;
    }
  }
}

function resolveId(table: StringTable, index: number, label: string): Result<Id> {
  const text = table.get(index);
  return typeof text === 'string' ? ok(text) : fail('bad-id', `${label}: unknown table id ${index}`);
}

// ---------------------------------------------------------------------------------------------
// Byte access
// ---------------------------------------------------------------------------------------------

/** Growable little-endian writer. Integer writes wrap to the field width, per DataView. */
class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(capacity);
    this.view = new DataView(this.buffer.buffer);
  }

  get length(): number {
    return this.offset;
  }

  /** Bytes written so far, as a view of the backing buffer. */
  raw(): Uint8Array {
    return this.buffer.subarray(0, this.offset);
  }

  u8(value: number): void {
    const at = this.reserve(1);
    this.view.setUint8(at, value);
  }

  u16(value: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, value, LE);
  }

  u32(value: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, value, LE);
  }

  f32(value: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, value, LE);
  }

  f64(value: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, value, LE);
  }

  /** `reserve` may replace the buffer, so it must run before `this.buffer` is read. */
  bytes(source: Uint8Array): void {
    const at = this.reserve(source.length);
    this.buffer.set(source, at);
  }

  private reserve(count: number): number {
    const at = this.offset;
    const needed = at + count;
    if (needed > this.buffer.length) {
      let capacity = this.buffer.length < 16 ? 16 : this.buffer.length * 2;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer);
      this.buffer = grown;
      this.view = new DataView(grown.buffer);
    }
    this.offset = needed;
    return at;
  }
}

/** Bounds-checked reader with a sticky failure: once a frame is bad, later reads are no-ops. */
class ByteReader {
  private readonly view: DataView;
  private offset: number;
  private failure: Invalid | null = null;

  constructor(private readonly bytes: Uint8Array, offset: number) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get ok(): boolean {
    return this.failure === null;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  invalid<T>(): Result<T> {
    const failure = this.failure;
    return failure === null ? fail('out-of-range', 'no failure recorded') : failure;
  }

  reject(code: InvalidCode, detail: string): void {
    if (this.failure === null) this.failure = { ok: false, code, detail };
  }

  u8(): number {
    const at = this.take(1);
    return this.failure === null ? this.view.getUint8(at) : 0;
  }

  u16(): number {
    const at = this.take(2);
    return this.failure === null ? this.view.getUint16(at, LE) : 0;
  }

  u32(): number {
    const at = this.take(4);
    return this.failure === null ? this.view.getUint32(at, LE) : 0;
  }

  f32(): number {
    const at = this.take(4);
    if (this.failure !== null) return 0;
    const value = this.view.getFloat32(at, LE);
    if (Number.isFinite(value)) return value;
    this.reject('not-finite', `float32 at byte ${at}`);
    return 0;
  }

  f64(): number {
    const at = this.take(8);
    if (this.failure !== null) return 0;
    const value = this.view.getFloat64(at, LE);
    if (Number.isFinite(value)) return value;
    this.reject('not-finite', `float64 at byte ${at}`);
    return 0;
  }

  /** Wire presence flag: 0 or 1, never a third value. */
  presence(): boolean {
    const flag = this.u8();
    if (flag > 1) this.reject('out-of-range', `presence flag ${flag}`);
    return flag === 1;
  }

  /** Required id: index 0 is the reserved null slot and is not a valid id here. */
  id(table: StringTable, label: string): Id {
    const index = this.u32();
    if (this.failure !== null) return '';
    if (index === 0) {
      this.reject('bad-id', `${label}: null id`);
      return '';
    }
    const result = resolveId(table, index, label);
    if (!result.ok) {
      this.reject(result.code, result.detail);
      return '';
    }
    return result.value;
  }

  optionalId(table: StringTable, label: string): Id | null {
    const index = this.u32();
    if (this.failure !== null || index === 0) return null;
    const result = resolveId(table, index, label);
    if (!result.ok) {
      this.reject(result.code, result.detail);
      return null;
    }
    return result.value;
  }

  enumCode<T>(codes: readonly T[], label: string): T {
    const code = this.u8();
    if (this.failure !== null) return codes[0];
    if (code >= codes.length) {
      this.reject('bad-enum', `${label} ${code}`);
      return codes[0];
    }
    return codes[code];
  }

  /** Length-prefixed UTF-8 text, bounded and NFC-normalized like every other client string. */
  text(maxBytes: number, maxChars: number, label: string): string {
    const length = this.u16();
    if (this.failure !== null) return '';
    if (length > maxBytes) {
      this.reject('too-long', `${label}: ${length} bytes`);
      return '';
    }
    const at = this.take(length);
    if (this.failure !== null) return '';
    let decoded: string;
    try {
      decoded = UTF8_STRICT.decode(this.bytes.subarray(at, at + length));
    } catch {
      this.reject('bad-name', `${label}: invalid UTF-8`);
      return '';
    }
    const bounded = boundedString(decoded, maxBytes, maxChars);
    if (!bounded.ok) {
      this.reject(bounded.code, `${label}: ${bounded.detail}`);
      return '';
    }
    return bounded.value;
  }

  /** Copy of the next `count` raw bytes; empty when the frame is short. */
  slice(count: number): Uint8Array {
    const at = this.take(count);
    return this.failure === null ? this.bytes.slice(at, at + count) : EMPTY_BYTES;
  }

  private take(count: number): number {
    const at = this.offset;
    if (this.failure !== null) return at;
    if (at + count > this.bytes.length) {
      this.reject('out-of-range', `truncated at byte ${at}, wanted ${count}`);
      return at;
    }
    this.offset = at + count;
    return at;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared field codecs
// ---------------------------------------------------------------------------------------------

function writeText(w: ByteWriter, value: string | null, maxBytes: number, maxChars: number): void {
  if (value === null) {
    w.u8(0);
    return;
  }
  const bounded = boundedString(value, maxBytes, maxChars);
  if (!bounded.ok) throw new RangeError(`text ${bounded.code}: ${bounded.detail}`);
  const encoded = UTF8.encode(bounded.value);
  w.u8(1);
  w.u16(encoded.length);
  w.bytes(encoded);
}

function readText(r: ByteReader, maxBytes: number, maxChars: number, label: string): string | null {
  return r.presence() ? r.text(maxBytes, maxChars, label) : null;
}

/** Text the contract marks as always present; an absent flag is a malformed frame, not a default. */
function readRequiredText(r: ByteReader, maxBytes: number, maxChars: number, label: string): string {
  if (!r.presence()) r.reject('missing-field', `${label}: absent`);
  return r.text(maxBytes, maxChars, label);
}

function writeVec2(w: ByteWriter, value: Vec2): void {
  w.f32(value.x);
  w.f32(value.y);
}

function readVec2(r: ByteReader): Vec2 {
  const x = r.f32();
  const y = r.f32();
  return { x, y };
}

function writeShape(w: ByteWriter, shape: CollisionShape): void {
  if (shape.kind === 'circle') {
    w.u8(SHAPE_CIRCLE);
    w.f64(shape.radiusM);
    return;
  }
  if (shape.kind === 'capsule') {
    w.u8(SHAPE_CAPSULE);
    w.f64(shape.radiusM);
    w.f64(shape.halfSegmentM);
    return;
  }
  frameCap(shape.vertices.length, CAP.convexVertices, 'convex vertices');
  w.u8(SHAPE_CONVEX);
  w.u8(shape.vertices.length);
  for (const vertex of shape.vertices) {
    w.f64(vertex.x);
    w.f64(vertex.y);
  }
}

function readShape(r: ByteReader): CollisionShape {
  const kind = r.u8();
  if (kind === SHAPE_CIRCLE) return { kind: 'circle', radiusM: r.f64() };
  if (kind === SHAPE_CAPSULE) return { kind: 'capsule', radiusM: r.f64(), halfSegmentM: r.f64() };
  if (kind !== SHAPE_CONVEX) {
    r.reject('bad-enum', `collision shape ${kind}`);
    return { kind: 'circle', radiusM: 0 };
  }
  const count = r.u8();
  if (count > CAP.convexVertices) r.reject('too-many', `convex vertices ${count}`);
  const vertices: Vec2[] = [];
  for (let index = 0; index < count && r.ok; index++) vertices.push({ x: r.f64(), y: r.f64() });
  return { kind: 'convex', vertices };
}

function writeKey(w: ByteWriter, table: StringTable, id: Id, generation: number, mask: number): void {
  w.u32(table.intern(id));
  w.u16(generation);
  w.u16(mask);
}

function readKey(r: ByteReader, table: StringTable, expectedMask: number, label: string): { id: Id; generation: number } {
  const id = r.id(table, `${label} id`);
  const generation = r.u16();
  const mask = r.u16();
  if (mask !== expectedMask) {
    r.reject('unknown-field', `${label} mask 0x${mask.toString(16)}, expected 0x${expectedMask.toString(16)}`);
  }
  return { id, generation };
}

function writeFit(w: ByteWriter, fit: Fit, table: StringTable): void {
  w.u32(table.intern(fit.chassisId));
  w.u32(table.intern(fit.paintId));
  const slots = Object.entries(fit.slots);
  frameCap(slots.length, CAP.fitSlots, 'fit slots');
  w.u8(slots.length);
  for (const [slotId, partId] of slots) {
    w.u32(table.intern(slotId));
    w.u32(table.intern(partId));
  }
  frameCap(fit.fireGroups.length, CAP.fireGroups, 'fire groups');
  w.u8(fit.fireGroups.length);
  for (const group of fit.fireGroups) {
    frameCap(group.length, CAP.groupSlots, 'fire group slots');
    w.u8(group.length);
    for (const partId of group) w.u32(table.intern(partId));
  }
  frameCap(fit.powerPriority.length, SLOT_KIND_CODES.length, 'power priority');
  w.u8(fit.powerPriority.length);
  for (const kind of fit.powerPriority) w.u8(SLOT_KIND_CODES.indexOf(kind));
}

function readFit(r: ByteReader, table: StringTable): Fit {
  const chassisId = r.id(table, 'fit chassisId');
  const paintId = r.id(table, 'fit paintId');
  const slotCount = r.u8();
  if (slotCount > CAP.fitSlots) r.reject('too-many', `fit slots ${slotCount}`);
  const slots: Record<Id, Id> = {};
  for (let index = 0; index < slotCount && r.ok; index++) {
    const slotId = r.id(table, 'fit slot');
    slots[slotId] = r.id(table, 'fit part');
  }
  const groupCount = r.u8();
  if (groupCount > CAP.fireGroups) r.reject('too-many', `fire groups ${groupCount}`);
  const fireGroups: Id[][] = [];
  for (let index = 0; index < groupCount && r.ok; index++) {
    const groupLength = r.u8();
    if (groupLength > CAP.groupSlots) r.reject('too-many', `fire group slots ${groupLength}`);
    const group: Id[] = [];
    for (let slot = 0; slot < groupLength && r.ok; slot++) group.push(r.id(table, 'fire group part'));
    fireGroups.push(group);
  }
  const priorityCount = r.u8();
  if (priorityCount > SLOT_KIND_CODES.length) r.reject('too-many', `power priority ${priorityCount}`);
  const powerPriority: SlotKind[] = [];
  for (let index = 0; index < priorityCount && r.ok; index++) powerPriority.push(r.enumCode(SLOT_KIND_CODES, 'slot kind'));
  return { chassisId, paintId, slots, fireGroups, powerPriority };
}

function writeShip(w: ByteWriter, ship: ShipView, table: StringTable): void {
  writeKey(w, table, ship.id, 0, SHIP_MASK);
  w.u32(table.internId(ship.pilotId));
  w.u32(table.intern(ship.lifeId));
  writeVec2(w, ship.position);
  w.f32(ship.angle);
  writeVec2(w, ship.velocity);
  w.f32(ship.angularVelocity);
  w.u16(quantizeHealth(ship.hull));
  w.u16(quantizeHealth(ship.hullMax));
  w.u8(LIFE_CODES.indexOf(ship.life));
  writeFit(w, ship.fit, table);
  w.u32(table.intern(ship.teamId));
  w.f64(ship.fuelKg);
  w.f64(ship.fuelMaxKg);
  w.f64(ship.heatMJ);
  w.f64(ship.heatMaxMJ);
  w.f64(ship.capacitorMJ);
}

function readShip(r: ByteReader, table: StringTable): ShipView {
  const { id } = readKey(r, table, SHIP_MASK, 'ship');
  const pilotId = r.optionalId(table, 'ship pilotId');
  const lifeId = r.id(table, 'ship lifeId');
  const position = readVec2(r);
  const angle = r.f32();
  const velocity = readVec2(r);
  const angularVelocity = r.f32();
  const hull = r.u16() / HEALTH_SCALE;
  const hullMax = r.u16() / HEALTH_SCALE;
  const life = r.enumCode(LIFE_CODES, 'ship life');
  const fit = readFit(r, table);
  const teamId = r.id(table, 'ship teamId');
  const fuelKg = r.f64();
  const fuelMaxKg = r.f64();
  const heatMJ = r.f64();
  const heatMaxMJ = r.f64();
  const capacitorMJ = r.f64();
  return {
    id,
    pilotId,
    lifeId,
    teamId,
    position,
    velocity,
    angle,
    angularVelocity,
    fit,
    hull,
    hullMax,
    fuelKg,
    fuelMaxKg,
    heatMJ,
    heatMaxMJ,
    capacitorMJ,
    life,
  };
}

function writeBody(w: ByteWriter, body: BodyView, table: StringTable): void {
  writeKey(w, table, body.id, body.generation, BODY_MASK);
  writeVec2(w, body.position);
  w.f32(body.angle);
  writeVec2(w, body.velocity);
  w.f32(body.angularVelocity);
  w.u16(quantizeHealth(body.hull));
  w.u16(quantizeHealth(body.hullMax));
  w.u32(table.intern(body.visualId));
  w.u32(body.renderSeed);
  writeShape(w, body.shape);
  w.u8(body.collidable ? 1 : 0);
}

function readBody(r: ByteReader, table: StringTable): BodyView {
  const { id, generation } = readKey(r, table, BODY_MASK, 'body');
  const position = readVec2(r);
  const angle = r.f32();
  const velocity = readVec2(r);
  const angularVelocity = r.f32();
  const hull = r.u16() / HEALTH_SCALE;
  const hullMax = r.u16() / HEALTH_SCALE;
  const visualId = r.id(table, 'body visualId');
  const renderSeed = r.u32();
  const shape = readShape(r);
  const collidable = r.presence();
  return { id, generation, visualId, renderSeed, position, velocity, angle, angularVelocity, shape, collidable, hull, hullMax };
}

function writeProjectile(w: ByteWriter, projectile: ProjectileView, table: StringTable): void {
  writeKey(w, table, projectile.id, projectile.generation, PROJECTILE_MASK);
  w.u32(table.intern(projectile.weaponId));
  w.u32(table.intern(projectile.ownerLifeId));
  w.u32(table.intern(projectile.teamId));
  writeVec2(w, projectile.position);
  w.f32(projectile.angle);
  writeVec2(w, projectile.velocity);
  w.u8(PROJECTILE_STATE_CODES.indexOf(projectile.state));
  w.u32(projectile.expiresAtTick);
}

function readProjectile(r: ByteReader, table: StringTable): ProjectileView {
  const { id, generation } = readKey(r, table, PROJECTILE_MASK, 'projectile');
  const weaponId = r.id(table, 'projectile weaponId');
  const ownerLifeId = r.id(table, 'projectile ownerLifeId');
  const teamId = r.id(table, 'projectile teamId');
  const position = readVec2(r);
  const angle = r.f32();
  const velocity = readVec2(r);
  const state = r.enumCode(PROJECTILE_STATE_CODES, 'projectile state');
  const expiresAtTick = r.u32();
  return { id, generation, weaponId, ownerLifeId, teamId, position, velocity, angle, state, expiresAtTick };
}

function writeContact(w: ByteWriter, contact: ContactView, table: StringTable): void {
  writeKey(w, table, contact.id, 0, CONTACT_MASK);
  w.u8(CONTACT_KIND_CODES.indexOf(contact.kind));
  writeVec2(w, contact.position);
  w.f32(contact.uncertaintyM);
  w.u32(contact.ageTicks);
  w.u8(contact.targetable ? 1 : 0);
}

function readContact(r: ByteReader, table: StringTable): ContactView {
  const { id } = readKey(r, table, CONTACT_MASK, 'contact');
  const kind = r.enumCode(CONTACT_KIND_CODES, 'contact kind');
  const position = readVec2(r);
  const uncertaintyM = r.f32();
  const ageTicks = r.u32();
  const targetable = r.presence();
  return { id, kind, position, uncertaintyM, ageTicks, targetable };
}

function writeFlightIntent(w: ByteWriter, intent: FlightIntent, table: StringTable): void {
  w.f64(intent.thrust);
  w.f64(intent.turn);
  w.f64(intent.strafe);
  w.u8((intent.brake ? 1 : 0) | (intent.boost ? 2 : 0) | (intent.angularAssist ? 4 : 0));
  w.u8(intent.fireMask);
  if (intent.aimWorld === null) w.u8(0);
  else {
    w.u8(1);
    writeVec2(w, intent.aimWorld);
  }
  w.u32(table.internId(intent.lockContactId));
}

function readFlightIntent(r: ByteReader, table: StringTable): FlightIntent {
  const thrust = r.f64();
  const turn = r.f64();
  const strafe = r.f64();
  const flags = r.u8();
  const fireMask = r.u8();
  const aimWorld = r.presence() ? readVec2(r) : null;
  const lockContactId = r.optionalId(table, 'intent lockContactId');
  return {
    thrust,
    turn,
    strafe,
    brake: (flags & 1) !== 0,
    boost: (flags & 2) !== 0,
    angularAssist: (flags & 4) !== 0,
    fireMask,
    aimWorld,
    lockContactId,
  };
}

function writeScheduledInput(w: ByteWriter, input: ScheduledInput, table: StringTable): void {
  w.u32(input.seq);
  w.u32(input.applyAtTick);
  writeFlightIntent(w, input.intent, table);
}

function readScheduledInput(r: ByteReader, table: StringTable): ScheduledInput {
  const seq = r.u32();
  const applyAtTick = r.u32();
  return { seq, applyAtTick, intent: readFlightIntent(r, table) };
}

function writeWeapon(w: ByteWriter, weapon: WeaponView, table: StringTable): void {
  w.u32(table.intern(weapon.slotId));
  w.u32(table.intern(weapon.partId));
  if (weapon.group === null) w.u8(0);
  else {
    w.u8(1);
    w.u8(weapon.group);
  }
  w.u8(weapon.autoDefense ? 1 : 0);
  w.u8(weapon.magazine === null ? 0 : 1);
  if (weapon.magazine !== null) w.u32(weapon.magazine);
  w.u8(weapon.reserve === null ? 0 : 1);
  if (weapon.reserve !== null) w.u32(weapon.reserve);
  w.u8(weapon.reloadEndsAtTick === null ? 0 : 1);
  if (weapon.reloadEndsAtTick !== null) w.u32(weapon.reloadEndsAtTick);
  w.f32(weapon.chargeFraction);
  w.u32(weapon.readyAtTick);
  writeText(w, weapon.blockedReason, MAX_REASON_BYTES, MAX_REASON_BYTES);
}

function readWeapon(r: ByteReader, table: StringTable): WeaponView {
  const slotId = r.id(table, 'weapon slotId');
  const partId = r.id(table, 'weapon partId');
  const group = r.presence() ? r.u8() : null;
  const autoDefense = r.presence();
  const magazine = r.presence() ? r.u32() : null;
  const reserve = r.presence() ? r.u32() : null;
  const reloadEndsAtTick = r.presence() ? r.u32() : null;
  const chargeFraction = r.f32();
  const readyAtTick = r.u32();
  const blockedReason = readText(r, MAX_REASON_BYTES, MAX_REASON_BYTES, 'weapon blockedReason');
  return { slotId, partId, group, autoDefense, magazine, reserve, reloadEndsAtTick, chargeFraction, readyAtTick, blockedReason };
}

function writePrediction(w: ByteWriter, prediction: PredictionState): void {
  w.u32(prediction.tick);
  writeVec2(w, prediction.position);
  writeVec2(w, prediction.velocity);
  w.f32(prediction.angle);
  w.f32(prediction.angularVelocity);
  w.f64(prediction.fuelKg);
  w.f64(prediction.heatMJ);
  w.f64(prediction.capacitorMJ);
  w.u8(prediction.angularAssist ? 1 : 0);
}

function readPrediction(r: ByteReader): PredictionState {
  const tick = r.u32();
  const position = readVec2(r);
  const velocity = readVec2(r);
  const angle = r.f32();
  const angularVelocity = r.f32();
  const fuelKg = r.f64();
  const heatMJ = r.f64();
  const capacitorMJ = r.f64();
  const angularAssist = r.presence();
  return { tick, position, velocity, angle, angularVelocity, fuelKg, heatMJ, capacitorMJ, angularAssist };
}

function writeDerived(w: ByteWriter, derived: DerivedFit): void {
  writeText(w, derived.hash, MAX_HASH_BYTES, MAX_HASH_BYTES);
  w.u8(derived.valid ? 1 : 0);
  frameCap(derived.errors.length, CAP.derivedErrors, 'derived errors');
  w.u8(derived.errors.length);
  for (const error of derived.errors) writeText(w, error, MAX_REASON_BYTES, MAX_REASON_BYTES);
  w.f64(derived.dryMassKg);
  w.f64(derived.fuelCapacityKg);
  w.f64(derived.hullMax);
  w.f64(derived.thrustN);
  w.f64(derived.inertiaKgM2);
  w.f64(derived.powerSupplyMW);
  w.f64(derived.idleDemandMW);
  w.f64(derived.coolingMW);
  w.f64(derived.heatCapacityMJ);
  w.f64(derived.capacitorMJ);
  w.f64(derived.buildCost);
}

function readDerived(r: ByteReader): DerivedFit {
  const hash = readRequiredText(r, MAX_HASH_BYTES, MAX_HASH_BYTES, 'derived hash');
  const valid = r.presence();
  const errorCount = r.u8();
  if (errorCount > CAP.derivedErrors) r.reject('too-many', `derived errors ${errorCount}`);
  const errors: string[] = [];
  for (let index = 0; index < errorCount && r.ok; index++) {
    errors.push(readRequiredText(r, MAX_REASON_BYTES, MAX_REASON_BYTES, 'derived error'));
  }
  return {
    hash,
    valid,
    errors,
    dryMassKg: r.f64(),
    fuelCapacityKg: r.f64(),
    hullMax: r.f64(),
    thrustN: r.f64(),
    inertiaKgM2: r.f64(),
    powerSupplyMW: r.f64(),
    idleDemandMW: r.f64(),
    coolingMW: r.f64(),
    heatCapacityMJ: r.f64(),
    capacitorMJ: r.f64(),
    buildCost: r.f64(),
  };
}

function writeSelf(w: ByteWriter, self: SelfAuthority | null, table: StringTable): void {
  if (self === null) {
    w.u8(0);
    return;
  }
  w.u8(1);
  w.u32(self.tick);
  writeShip(w, self.ship, table);
  writeDerived(w, self.derived);
  w.u8(self.activeInput === null ? 0 : 1);
  if (self.activeInput !== null) writeScheduledInput(w, self.activeInput, table);
  frameCap(self.scheduledInputs.length, CAP.scheduledInputs, 'scheduled inputs');
  w.u8(self.scheduledInputs.length);
  for (const input of self.scheduledInputs) writeScheduledInput(w, input, table);
  w.u32(self.receivedSeq);
  w.u32(self.appliedSeq);
  writePrediction(w, self.predictionState);
  frameCap(self.weapons.length, CAP.weapons, 'weapons');
  w.u8(self.weapons.length);
  for (const weapon of self.weapons) writeWeapon(w, weapon, table);
}

function readSelf(r: ByteReader, table: StringTable): SelfAuthority | null {
  if (!r.presence()) return null;
  const tick = r.u32();
  const ship = readShip(r, table);
  const derived = readDerived(r);
  const activeInput = r.presence() ? readScheduledInput(r, table) : null;
  const scheduledCount = r.u8();
  if (scheduledCount > CAP.scheduledInputs) r.reject('too-many', `scheduled inputs ${scheduledCount}`);
  const scheduledInputs: ScheduledInput[] = [];
  for (let index = 0; index < scheduledCount && r.ok; index++) scheduledInputs.push(readScheduledInput(r, table));
  const receivedSeq = r.u32();
  const appliedSeq = r.u32();
  const predictionState = readPrediction(r);
  const weaponCount = r.u8();
  if (weaponCount > CAP.weapons) r.reject('too-many', `weapons ${weaponCount}`);
  const weapons: WeaponView[] = [];
  for (let index = 0; index < weaponCount && r.ok; index++) weapons.push(readWeapon(r, table));
  return { tick, ship, derived, activeInput, scheduledInputs, receivedSeq, appliedSeq, predictionState, weapons };
}

function writeObjective(w: ByteWriter, objective: ObjectiveView, table: StringTable): void {
  w.u32(table.intern(objective.id));
  writeText(w, objective.title, MAX_TITLE_BYTES, MAX_TITLE_BYTES);
  w.u8(OBJECTIVE_STATE_CODES.indexOf(objective.state));
  w.u32(objective.completed);
  w.u32(objective.required);
  if (objective.marker === null) w.u8(0);
  else {
    w.u8(1);
    writeVec2(w, objective.marker);
  }
}

function readObjective(r: ByteReader, table: StringTable): ObjectiveView {
  const id = r.id(table, 'objective id');
  const title = readRequiredText(r, MAX_TITLE_BYTES, MAX_TITLE_BYTES, 'objective title');
  const state = r.enumCode(OBJECTIVE_STATE_CODES, 'objective state');
  const completed = r.u32();
  const required = r.u32();
  const marker = r.presence() ? readVec2(r) : null;
  return { id, title, state, completed, required, marker };
}

// ---------------------------------------------------------------------------------------------
// Frame assembly and framing
// ---------------------------------------------------------------------------------------------

interface FrameMeta {
  flags: number;
  stateSeq: number;
  tick: number;
  eventWatermark: number;
  ships: number;
  bodies: number;
  projectiles: number;
  contacts: number;
}

interface OpenedFrame {
  reader: ByteReader;
  version: number;
  primary: number;
  meta: FrameMeta;
}

const NO_ENTITIES = { stateSeq: 0, tick: 0, eventWatermark: 0, ships: 0, bodies: 0, projectiles: 0, contacts: 0 } as const;

/**
 * Header, then the delta this frame added. The delta is only known once the body has interned its
 * ids, so the assembled buffer is the one place header and delta meet. A frame that breaks a cap
 * throws and leaves the table as it was, so one bad frame cannot desynchronise every later one.
 */
function encodeFrame(type: FrameType, table: StringTable, primary: string | null, meta: FrameMeta, write: (body: ByteWriter) => void): Uint8Array {
  const firstNew = table.size;
  try {
    const body = new ByteWriter(1024);
    write(body);
    return assemble(type, table, firstNew, primary === null ? 0 : table.intern(primary), meta, body.raw());
  } catch (error) {
    table.truncate(firstNew);
    throw error;
  }
}

function assemble(type: FrameType, table: StringTable, firstNew: number, primary: number, meta: FrameMeta, body: Uint8Array): Uint8Array {
  const added = table.size - firstNew;
  frameCap(added, CAP.tableEntries, 'string table delta');
  const delta = new ByteWriter(added * 8 + 2);
  delta.u16(added);
  for (let index = firstNew; index < table.size; index++) {
    const text = table.get(index + 1);
    const encoded = UTF8.encode(typeof text === 'string' ? text : '');
    frameCap(encoded.length, CAP.tableEntryBytes, 'string table entry bytes');
    delta.u16(encoded.length);
    delta.bytes(encoded);
  }
  const length = delta.length + body.length;
  frameCap(
    HEADER_BYTES + length,
    type === FRAME.baselineChunk ? MAX_CHUNK_FRAME_BYTES : MAX_FRAME_BYTES,
    'frame bytes',
  );
  const out = new ByteWriter(HEADER_BYTES + length);
  out.u32(MAGIC);
  out.u16(RELEASE.protocol);
  out.u8(type);
  out.u8(meta.flags);
  out.u32(length);
  out.u32(table.revision);
  out.u32(primary);
  out.u32(meta.stateSeq);
  out.u32(meta.tick);
  out.u32(meta.eventWatermark);
  out.u16(meta.ships);
  out.u16(meta.bodies);
  out.u16(meta.projectiles);
  out.u16(meta.contacts);
  out.bytes(delta.raw());
  out.bytes(body);
  return out.raw();
}

function openFrame(bytes: Uint8Array, type: FrameType, table: StringTable): Result<OpenedFrame> {
  if (bytes.length < HEADER_BYTES) return fail('out-of-range', `frame ${bytes.length} bytes, header needs ${HEADER_BYTES}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, LE);
  if (magic !== MAGIC) return fail('bad-enum', `magic 0x${magic.toString(16).padStart(8, '0')}`);
  const version = view.getUint16(4, LE);
  if (version !== RELEASE.protocol) return fail('bad-enum', `protocol ${version}, expected ${RELEASE.protocol}`);
  const frameType = view.getUint8(6);
  if (frameType !== type) return fail('bad-enum', `frame type ${frameType}, expected ${type}`);
  const length = view.getUint32(8, LE);
  const bodyBytes = bytes.length - HEADER_BYTES;
  if (length > (type === FRAME.baselineChunk ? MAX_CHUNK_FRAME_BYTES : MAX_FRAME_BYTES)) {
    return fail('too-large', `frame ${length} bytes`);
  }
  if (length !== bodyBytes) return fail('out-of-range', `length ${length}, ${bodyBytes} bytes follow the header`);
  const epochTableId = view.getUint32(12, LE);
  const meta: FrameMeta = {
    flags: view.getUint8(7),
    stateSeq: view.getUint32(20, LE),
    tick: view.getUint32(24, LE),
    eventWatermark: view.getUint32(28, LE),
    ships: view.getUint16(32, LE),
    bodies: view.getUint16(34, LE),
    projectiles: view.getUint16(36, LE),
    contacts: view.getUint16(38, LE),
  };
  if (meta.ships > CAP.ships) return fail('too-many', `ships ${meta.ships}`);
  if (meta.bodies > CAP.bodies) return fail('too-many', `bodies ${meta.bodies}`);
  if (meta.projectiles > CAP.projectiles) return fail('too-many', `projectiles ${meta.projectiles}`);
  if (meta.contacts > CAP.contacts) return fail('too-many', `contacts ${meta.contacts}`);

  const reader = new ByteReader(bytes, HEADER_BYTES);
  const deltaCount = reader.u16();
  if (reader.ok && deltaCount > CAP.tableEntries) reader.reject('too-many', `string table delta ${deltaCount}`);
  if (!reader.ok) return reader.invalid<OpenedFrame>();
  // The sender's pre-frame revision is the declared one minus the entries it is about to add, so a
  // drifted table is caught before this frame can append anything to it.
  if (table.revision + deltaCount !== epochTableId) {
    return fail('out-of-range', `table revision ${table.revision}, frame was written against ${epochTableId - deltaCount}`);
  }
  for (let index = 0; index < deltaCount; index++) {
    const entry = reader.text(CAP.tableEntryBytes, CAP.tableEntryBytes, 'string entry');
    if (!reader.ok) return reader.invalid<OpenedFrame>();
    table.append(entry);
  }
  return ok({ reader, version, primary: view.getUint32(16, LE), meta });
}

function finish<T>(reader: ByteReader, value: T): Result<T> {
  if (!reader.ok) return reader.invalid<T>();
  if (reader.remaining !== 0) return fail('too-large', `${reader.remaining} trailing bytes`);
  return ok(value);
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

export function encodeSnapshot(snapshot: Snapshot, table: StringTable): Uint8Array {
  frameCap(snapshot.ships.length, CAP.ships, 'ships');
  frameCap(snapshot.bodies.length, CAP.bodies, 'bodies');
  frameCap(snapshot.projectiles.length, CAP.projectiles, 'projectiles');
  frameCap(snapshot.contacts.length, CAP.contacts, 'contacts');
  frameCap(snapshot.objectives.length, CAP.objectives, 'objectives');
  const scores = Object.entries(snapshot.teamScores);
  frameCap(scores.length, CAP.teamScores, 'team scores');

  const meta: FrameMeta = {
    flags: snapshot.header.flags,
    stateSeq: snapshot.header.stateSeq,
    tick: snapshot.header.tick,
    eventWatermark: snapshot.header.eventWatermark,
    ships: snapshot.ships.length,
    bodies: snapshot.bodies.length,
    projectiles: snapshot.projectiles.length,
    contacts: snapshot.contacts.length,
  };
  return encodeFrame(FRAME.snapshot, table, snapshot.header.baselineId, meta, (body) => {
    body.u32(table.intern(snapshot.header.epoch));
    writeSelf(body, snapshot.self, table);
    for (const ship of snapshot.ships) writeShip(body, ship, table);
    for (const entity of snapshot.bodies) writeBody(body, entity, table);
    for (const projectile of snapshot.projectiles) writeProjectile(body, projectile, table);
    for (const contact of snapshot.contacts) writeContact(body, contact, table);
    body.u16(snapshot.objectives.length);
    for (const objective of snapshot.objectives) writeObjective(body, objective, table);
    body.u16(scores.length);
    for (const [teamId, score] of scores) {
      body.u32(table.intern(teamId));
      body.f64(score);
    }
    body.u32(snapshot.inventoryRevision);
  });
}

export function decodeSnapshot(bytes: Uint8Array, table: StringTable): Result<Snapshot> {
  const opened = openFrame(bytes, FRAME.snapshot, table);
  if (!opened.ok) return opened;
  const { reader, version, primary, meta } = opened.value;

  const epoch = reader.id(table, 'snapshot epoch');
  const self = readSelf(reader, table);
  const ships: ShipView[] = [];
  for (let index = 0; index < meta.ships; index++) ships.push(readShip(reader, table));
  const bodies: BodyView[] = [];
  for (let index = 0; index < meta.bodies; index++) bodies.push(readBody(reader, table));
  const projectiles: ProjectileView[] = [];
  for (let index = 0; index < meta.projectiles; index++) projectiles.push(readProjectile(reader, table));
  const contacts: ContactView[] = [];
  for (let index = 0; index < meta.contacts; index++) contacts.push(readContact(reader, table));
  const objectiveCount = reader.u16();
  if (objectiveCount > CAP.objectives) reader.reject('too-many', `objectives ${objectiveCount}`);
  const objectives: ObjectiveView[] = [];
  for (let index = 0; index < objectiveCount && reader.ok; index++) objectives.push(readObjective(reader, table));
  const scoreCount = reader.u16();
  if (scoreCount > CAP.teamScores) reader.reject('too-many', `team scores ${scoreCount}`);
  const teamScores: Record<Id, number> = {};
  for (let index = 0; index < scoreCount && reader.ok; index++) {
    const teamId = reader.id(table, 'team score id');
    teamScores[teamId] = reader.f64();
  }
  const inventoryRevision = reader.u32();

  if (!reader.ok) return reader.invalid<Snapshot>();
  const baselineId = resolveId(table, primary, 'snapshot baselineId');
  if (!baselineId.ok) return baselineId;
  const header = {
    codec: version,
    epoch,
    baselineId: baselineId.value,
    stateSeq: meta.stateSeq,
    tick: meta.tick,
    eventWatermark: meta.eventWatermark,
    flags: meta.flags,
  };
  return finish(reader, { header, self, ships, bodies, projectiles, contacts, objectives, teamScores, inventoryRevision });
}

// ---------------------------------------------------------------------------------------------
// Baseline header and chunk
// ---------------------------------------------------------------------------------------------

export function encodeBaselineHeader(header: BaselineHeader, table: StringTable): Uint8Array {
  frameCap(header.chunkCount, CAP.chunks, 'baseline chunks');
  frameCap(header.totalBytes, MAX_BASELINE_BYTES, 'baseline bytes');
  const meta: FrameMeta = { flags: 0, ...NO_ENTITIES, tick: header.tick };
  return encodeFrame(FRAME.baselineHeader, table, header.transferId, meta, (body) => {
    body.u32(table.intern(header.epoch));
    writeText(body, header.mapHash, MAX_MAP_HASH_BYTES, MAX_MAP_HASH_BYTES);
    body.u32(header.chunkCount);
    body.u32(header.totalBytes);
  });
}

export function decodeBaselineHeader(bytes: Uint8Array, table: StringTable): Result<BaselineHeader> {
  const opened = openFrame(bytes, FRAME.baselineHeader, table);
  if (!opened.ok) return opened;
  const { reader, primary, meta } = opened.value;
  const epoch = reader.id(table, 'baseline epoch');
  const mapHash = readRequiredText(reader, MAX_MAP_HASH_BYTES, MAX_MAP_HASH_BYTES, 'baseline mapHash');
  const chunkCount = reader.u32();
  if (chunkCount > CAP.chunks) reader.reject('too-many', `baseline chunks ${chunkCount}`);
  const totalBytes = reader.u32();
  if (totalBytes > MAX_BASELINE_BYTES) reader.reject('too-large', `baseline bytes ${totalBytes}`);
  if (!reader.ok) return reader.invalid<BaselineHeader>();
  const transferId = resolveId(table, primary, 'baseline transferId');
  if (!transferId.ok) return transferId;
  return finish(reader, { transferId: transferId.value, mapHash, epoch, tick: meta.tick, chunkCount, totalBytes });
}

export function encodeBaselineChunk(chunk: BaselineChunk, table: StringTable): Uint8Array {
  frameCap(chunk.bytes.length, MAX_CHUNK_BYTES, 'chunk bytes');
  frameCap(chunk.count, CAP.chunks, 'baseline chunks');
  const meta: FrameMeta = { flags: 0, ...NO_ENTITIES };
  return encodeFrame(FRAME.baselineChunk, table, chunk.transferId, meta, (body) => {
    body.u32(chunk.index);
    body.u32(chunk.count);
    body.u32(chunk.bytes.length);
    body.bytes(chunk.bytes);
  });
}

export function decodeBaselineChunk(bytes: Uint8Array, table: StringTable): Result<BaselineChunk> {
  const opened = openFrame(bytes, FRAME.baselineChunk, table);
  if (!opened.ok) return opened;
  const { reader, primary } = opened.value;
  const index = reader.u32();
  const count = reader.u32();
  if (count > CAP.chunks) reader.reject('too-many', `baseline chunks ${count}`);
  if (index >= count) reader.reject('out-of-range', `chunk ${index} of ${count}`);
  const length = reader.u32();
  if (length > MAX_CHUNK_BYTES) reader.reject('too-large', `chunk ${length} bytes`);
  const payload = reader.slice(length);
  if (!reader.ok) return reader.invalid<BaselineChunk>();
  const transferId = resolveId(table, primary, 'chunk transferId');
  if (!transferId.ok) return transferId;
  return finish(reader, { transferId: transferId.value, index, count, bytes: payload });
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

function writeEventPayload(w: ByteWriter, event: SessionEvent, table: StringTable): void {
  switch (event.kind) {
    case 'shot': {
      const payload = event.payload as EventPayloadByKind['shot'];
      w.u32(table.intern(payload.shotId));
      w.u32(table.intern(payload.slotId));
      w.u32(table.intern(payload.weaponId));
      w.u32(table.intern(payload.ownerLifeId));
      writeVec2(w, payload.position);
      writeVec2(w, payload.velocity);
      w.u8(PROJECTILE_STATE_CODES.indexOf(payload.state));
      w.u32(payload.expiresAtTick);
      return;
    }
    case 'impact': {
      const payload = event.payload as EventPayloadByKind['impact'];
      w.u32(table.intern(payload.hitId));
      w.u8(HIT_KIND_CODES.indexOf(payload.kind));
      w.u32(table.intern(payload.targetId));
      writeVec2(w, payload.position);
      writeVec2(w, payload.normal);
      w.f64(payload.damage);
      w.f64(payload.energyJ);
      w.u8(payload.destroyed ? 1 : 0);
      w.u32(table.internId(payload.attackerPilotId));
      w.u32(table.internId(payload.victimPilotId));
      return;
    }
    case 'life': {
      const payload = event.payload as EventPayloadByKind['life'];
      w.u32(table.intern(payload.lifeId));
      w.u32(table.intern(payload.shipId));
      w.u32(table.intern(payload.pilotId));
      w.u8(LIFE_CODES.indexOf(payload.life));
      writeVec2(w, payload.position);
      w.u8(payload.respawnAtTick === null ? 0 : 1);
      if (payload.respawnAtTick !== null) w.u32(payload.respawnAtTick);
      return;
    }
    case 'roster': {
      const payload = event.payload as EventPayloadByKind['roster'];
      w.u8(ROSTER_REASON_CODES.indexOf(payload.reason));
      w.u32(table.intern(payload.pilotId));
      w.u32(payload.revision);
      return;
    }
    case 'objective': {
      const payload = event.payload as EventPayloadByKind['objective'];
      w.u32(table.intern(payload.objectiveId));
      w.u8(OBJECTIVE_STATE_CODES.indexOf(payload.state));
      w.u32(payload.completed);
      w.u32(payload.required);
      return;
    }
    case 'result': {
      const payload = event.payload as EventPayloadByKind['result'];
      w.u32(table.intern(payload.resultId));
      w.u8(OUTCOME_CODES.indexOf(payload.outcome));
      w.u32(table.internId(payload.winningTeamId));
      return;
    }
    case 'save': {
      const payload = event.payload as EventPayloadByKind['save'];
      w.u8(SAVE_STATE_CODES.indexOf(payload.state));
      writeText(w, payload.at, MAX_MAP_HASH_BYTES, MAX_MAP_HASH_BYTES);
      writeText(w, payload.reason, MAX_REASON_BYTES, MAX_REASON_BYTES);
      return;
    }
    case 'notice': {
      const payload = event.payload as EventPayloadByKind['notice'];
      w.u8(NOTICE_CODES.indexOf(payload.code));
      writeText(w, payload.message, MAX_TEXT_BYTES, MAX_TEXT_BYTES);
      w.u32(table.internId(payload.forPilotId));
      return;
    }
  }
}

function readEventPayload(r: ByteReader, table: StringTable, kind: SessionEventKind): EventPayloadByKind[SessionEventKind] {
  switch (kind) {
    case 'shot':
      return {
        shotId: r.id(table, 'shot shotId'),
        slotId: r.id(table, 'shot slotId'),
        weaponId: r.id(table, 'shot weaponId'),
        ownerLifeId: r.id(table, 'shot ownerLifeId'),
        position: readVec2(r),
        velocity: readVec2(r),
        state: r.enumCode(PROJECTILE_STATE_CODES, 'shot state'),
        expiresAtTick: r.u32(),
      };
    case 'impact':
      return {
        hitId: r.id(table, 'impact hitId'),
        kind: r.enumCode(HIT_KIND_CODES, 'impact kind'),
        targetId: r.id(table, 'impact targetId'),
        position: readVec2(r),
        normal: readVec2(r),
        damage: r.f64(),
        energyJ: r.f64(),
        destroyed: r.presence(),
        attackerPilotId: r.optionalId(table, 'impact attackerPilotId'),
        victimPilotId: r.optionalId(table, 'impact victimPilotId'),
      };
    case 'life':
      return {
        lifeId: r.id(table, 'life lifeId'),
        shipId: r.id(table, 'life shipId'),
        pilotId: r.id(table, 'life pilotId'),
        life: r.enumCode(LIFE_CODES, 'life state'),
        position: readVec2(r),
        respawnAtTick: r.presence() ? r.u32() : null,
      };
    case 'roster':
      return {
        reason: r.enumCode(ROSTER_REASON_CODES, 'roster reason'),
        pilotId: r.id(table, 'roster pilotId'),
        revision: r.u32(),
      };
    case 'objective':
      return {
        objectiveId: r.id(table, 'objective objectiveId'),
        state: r.enumCode(OBJECTIVE_STATE_CODES, 'objective state'),
        completed: r.u32(),
        required: r.u32(),
      };
    case 'result':
      return {
        resultId: r.id(table, 'result resultId'),
        outcome: r.enumCode(OUTCOME_CODES, 'result outcome'),
        winningTeamId: r.optionalId(table, 'result winningTeamId'),
      };
    case 'save':
      return {
        state: r.enumCode(SAVE_STATE_CODES, 'save state'),
        at: readText(r, MAX_MAP_HASH_BYTES, MAX_MAP_HASH_BYTES, 'save at'),
        reason: readText(r, MAX_REASON_BYTES, MAX_REASON_BYTES, 'save reason'),
      };
    case 'notice':
      return {
        code: r.enumCode(NOTICE_CODES, 'notice code'),
        message: readRequiredText(r, MAX_TEXT_BYTES, MAX_TEXT_BYTES, 'notice message'),
        forPilotId: r.optionalId(table, 'notice forPilotId'),
      };
  }
}

export function encodeEvents(events: readonly SessionEvent[], table: StringTable): Uint8Array {
  frameCap(events.length, CAP.events, 'events');
  const meta: FrameMeta = { flags: 0, ...NO_ENTITIES };
  return encodeFrame(FRAME.events, table, null, meta, (body) => {
    body.u16(events.length);
    for (const event of events) {
      body.u32(event.deliverySeq);
      body.u32(event.tick);
      body.u32(table.intern(event.epoch));
      body.u32(table.intern(event.eventId));
      body.u8(EVENT_KIND_CODES.indexOf(event.kind));
      writeEventPayload(body, event, table);
    }
  });
}

export function decodeEvents(bytes: Uint8Array, table: StringTable): Result<SessionEvent[]> {
  const opened = openFrame(bytes, FRAME.events, table);
  if (!opened.ok) return opened;
  const { reader } = opened.value;
  const count = reader.u16();
  if (count > CAP.events) reader.reject('too-many', `events ${count}`);
  const events: SessionEvent[] = [];
  for (let index = 0; index < count && reader.ok; index++) {
    const deliverySeq = reader.u32();
    const tick = reader.u32();
    const epoch = reader.id(table, 'event epoch');
    const eventId = reader.id(table, 'event eventId');
    const kind = reader.enumCode(EVENT_KIND_CODES, 'event kind');
    events.push({ deliverySeq, tick, epoch, eventId, kind, payload: readEventPayload(reader, table, kind) });
  }
  return finish(reader, events);
}
