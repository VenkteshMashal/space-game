import { describe, expect, test } from 'bun:test';
import {
  ENTITY_KEY_BYTES,
  FRAME,
  HEADER_BYTES,
  StringTable,
  decodeBaselineChunk,
  decodeBaselineHeader,
  decodeEvents,
  decodeSnapshot,
  encodeBaselineChunk,
  encodeBaselineHeader,
  encodeEvents,
  encodeSnapshot,
} from '../src/shared/codec.ts';
import type {
  BaselineChunk,
  BaselineHeader,
  BodyView,
  ContactView,
  DerivedFit,
  Fit,
  FlightIntent,
  Id,
  ObjectiveView,
  ProjectileView,
  ScheduledInput,
  SelfAuthority,
  SessionEvent,
  ShipView,
  Snapshot,
} from '../src/shared/contracts.ts';
import { RELEASE } from '../src/shared/contracts.ts';
import type { InvalidCode, Result } from '../src/shared/validate.ts';

/**
 * Float32 wire precision is ~1.2e-7 relative, so float fields compare with 1e-6 headroom —
 * eight ulp of slack, far below any dropped or mis-scaled field. Integer fields (ticks,
 * sequences, quantized health) must match exactly, which is what catches a layout regression.
 */
const WIRE_EPSILON = 1e-6;

function expectMatch(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') throw new Error(`${path}: expected number, got ${typeof actual}`);
    if (Number.isInteger(expected) && Number.isInteger(actual)) {
      expect(actual).toBe(expected);
      return;
    }
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(WIRE_EPSILON * Math.max(1, Math.abs(expected)));
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) throw new Error(`${path}: expected array, got ${typeof actual}`);
    expect(actual.length).toBe(expected.length);
    expected.forEach((item, index) => expectMatch(actual[index], item, `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') throw new Error(`${path}: expected object, got ${actual}`);
    const found = actual as Record<string, unknown>;
    const wanted = expected as Record<string, unknown>;
    expect(Object.keys(found).sort()).toEqual(Object.keys(wanted).sort());
    for (const key of Object.keys(wanted)) expectMatch(found[key], wanted[key], `${path}.${key}`);
    return;
  }
  expect(actual).toBe(expected);
}

function patched(frame: Uint8Array, offset: number, kind: 'u8' | 'u16' | 'u32' | 'f32', value: number): Uint8Array {
  const copy = frame.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  if (kind === 'u8') view.setUint8(offset, value);
  else if (kind === 'u16') view.setUint16(offset, value, true);
  else if (kind === 'u32') view.setUint32(offset, value, true);
  else view.setFloat32(offset, value, true);
  return copy;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function hexOf(bytes: Uint8Array, count: number): string {
  return [...bytes.subarray(0, count)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectRejected<T>(result: Result<T>, code: InvalidCode): void {
  if (result.ok) throw new Error('frame decoded, expected rejection');
  expect(result.code).toBe(code);
}

const FIT: Fit = {
  chassisId: 'kestrel',
  paintId: 'paint-07',
  slots: { w1: 'rivet30', w2: 'warden-pdc', e1: 'drive-c', r1: 'reactor-a' },
  fireGroups: [['w1'], ['w2', 'w1']],
  powerPriority: ['weapon', 'engine', 'reactor', 'sensor'],
};

const DERIVED: DerivedFit = {
  hash: 'a1b2c3d4',
  valid: false,
  errors: ['slot w2: part warder-pdc exceeds hull size'],
  dryMassKg: 65000,
  fuelCapacityKg: 16000,
  hullMax: 140,
  thrustN: 812345.5,
  inertiaKgM2: 12500000.25,
  powerSupplyMW: 18.5,
  idleDemandMW: 0.5,
  coolingMW: 0.8,
  heatCapacityMJ: 100,
  capacitorMJ: 8,
  buildCost: 110,
};

const INTENT: FlightIntent = {
  thrust: 0.75,
  turn: -0.125,
  strafe: 0.5,
  brake: true,
  boost: false,
  angularAssist: true,
  fireMask: 3,
  aimWorld: { x: 1234.567, y: -987.654 },
  lockContactId: 'contact-2',
};

const SCHEDULED: ScheduledInput = { seq: 812, applyAtTick: 4097, intent: INTENT };

function makeShip(id: Id, over: Partial<ShipView> = {}): ShipView {
  return {
    id,
    pilotId: `${id}-pilot`,
    lifeId: `${id}-life/1`,
    teamId: 'team-a',
    position: { x: 1234.567, y: -987.654 },
    velocity: { x: 12.3456, y: -0.5 },
    angle: 1.23456,
    angularVelocity: -0.0123456,
    fit: FIT,
    hull: 118.4,
    hullMax: 140,
    fuelKg: 8123.456789,
    fuelMaxKg: 16000,
    heatMJ: 42.123456,
    heatMaxMJ: 100,
    capacitorMJ: 6.789012,
    life: 'alive',
    ...over,
  };
}

const SELF: SelfAuthority = {
  tick: 4096,
  ship: makeShip('ship-1'),
  derived: DERIVED,
  activeInput: SCHEDULED,
  scheduledInputs: [
    SCHEDULED,
    { seq: 813, applyAtTick: 4098, intent: { ...INTENT, thrust: 1, aimWorld: null, lockContactId: null } },
  ],
  receivedSeq: 812,
  appliedSeq: 811,
  predictionState: {
    tick: 4096,
    position: { x: 1234.567, y: -987.654 },
    velocity: { x: 12.3456, y: -0.5 },
    angle: 1.23456,
    angularVelocity: -0.0123456,
    fuelKg: 8123.456789,
    heatMJ: 42.123456,
    capacitorMJ: 6.789012,
    angularAssist: true,
  },
  weapons: [
    {
      slotId: 'w1',
      partId: 'rivet30',
      group: 0,
      autoDefense: false,
      magazine: 120,
      reserve: 480,
      reloadEndsAtTick: 4400,
      chargeFraction: 0.125,
      readyAtTick: 4090,
      blockedReason: null,
    },
    {
      slotId: 'w2',
      partId: 'warden-pdc',
      group: null,
      autoDefense: true,
      magazine: null,
      reserve: null,
      reloadEndsAtTick: null,
      chargeFraction: 0,
      readyAtTick: 0,
      blockedReason: 'thermal-limit',
    },
  ],
};

const BODIES: readonly BodyView[] = [
  {
    id: 'rock-7',
    generation: 3,
    visualId: 'rock-a',
    renderSeed: 4711,
    position: { x: 64.5, y: -32.25 },
    velocity: { x: 0, y: 0 },
    angle: 0.5,
    angularVelocity: 0.0625,
    shape: { kind: 'circle', radiusM: 6.5 },
    collidable: true,
    hull: 40,
    hullMax: 55,
  },
  {
    id: 'rock-8',
    generation: 2,
    visualId: 'rock-b',
    renderSeed: 4712,
    position: { x: -150.75, y: 88.125 },
    velocity: { x: -1.5, y: 0.25 },
    angle: -0.25,
    angularVelocity: -0.0625,
    shape: { kind: 'capsule', radiusM: 3.5, halfSegmentM: 12 },
    collidable: true,
    hull: 22.5,
    hullMax: 30,
  },
  {
    id: 'rib-1',
    generation: 1,
    visualId: 'rib-a',
    renderSeed: 4713,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    shape: { kind: 'convex', vertices: [{ x: -4, y: -9 }, { x: 12, y: 0 }, { x: -4, y: 9 }] },
    collidable: false,
    hull: 500,
    hullMax: 600,
  },
];

const PROJECTILES: readonly ProjectileView[] = [
  {
    id: 'shot-9',
    generation: 5,
    weaponId: 'rivet30',
    ownerLifeId: 'ship-1-life/1',
    teamId: 'team-a',
    position: { x: 1300.25, y: -950.5 },
    velocity: { x: 1200.75, y: -87.25 },
    angle: 1.2,
    state: 'armed',
    expiresAtTick: 4400,
  },
  {
    id: 'mine-3',
    generation: 1,
    weaponId: 'anchor-mine',
    ownerLifeId: 'ship-2-life/1',
    teamId: 'team-b',
    position: { x: -60.125, y: 44.5 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    state: 'unarmed',
    expiresAtTick: 9000,
  },
];

const CONTACTS: readonly ContactView[] = [
  { id: 'contact-1', kind: 'hostile', position: { x: 800.5, y: 120.25 }, uncertaintyM: 15.5, ageTicks: 6, targetable: true },
  { id: 'contact-2', kind: 'unknown', position: { x: -200.75, y: -400.5 }, uncertaintyM: 120, ageTicks: 40, targetable: false },
];

const OBJECTIVES: readonly ObjectiveView[] = [
  { id: 'obj-scan-north', title: 'Scan the north node', state: 'active', completed: 1, required: 3, marker: { x: 512.25, y: -64.5 } },
  { id: 'obj-withdraw', title: 'Withdraw', state: 'locked', completed: 0, required: 1, marker: null },
];

function representativeSnapshot(): Snapshot {
  return {
    header: {
      codec: RELEASE.protocol,
      epoch: 'epoch-7',
      baselineId: 'baseline-3',
      stateSeq: 900,
      tick: 4096,
      eventWatermark: 512,
      flags: 3,
    },
    self: SELF,
    ships: [makeShip('ship-1'), makeShip('ship-2', { teamId: 'team-b', pilotId: null, life: 'disabled', hull: 0 })],
    bodies: BODIES,
    projectiles: PROJECTILES,
    contacts: CONTACTS,
    objectives: OBJECTIVES,
    teamScores: { 'team-a': 3, 'team-b': 1 },
    inventoryRevision: 77,
  };
}

function tinySnapshot(): Snapshot {
  return {
    header: {
      codec: RELEASE.protocol,
      epoch: 'e1',
      baselineId: 'b1',
      stateSeq: 4,
      tick: 12,
      eventWatermark: 3,
      flags: 5,
    },
    self: null,
    ships: [],
    bodies: [],
    projectiles: [],
    contacts: [],
    objectives: [],
    teamScores: {},
    inventoryRevision: 0,
  };
}

function bodyOnlySnapshot(): Snapshot {
  return {
    header: {
      codec: RELEASE.protocol,
      epoch: 'epoch-7',
      baselineId: 'baseline-3',
      stateSeq: 901,
      tick: 4097,
      eventWatermark: 512,
      flags: 0,
    },
    self: null,
    ships: [],
    bodies: [BODIES[0]],
    projectiles: [],
    contacts: [],
    objectives: [],
    teamScores: {},
    inventoryRevision: 77,
  };
}

function withPilot(snapshot: Snapshot, pilotId: Id): Snapshot {
  const [first, ...rest] = snapshot.ships;
  return { ...snapshot, ships: [{ ...first, pilotId }, ...rest] };
}

describe('frame layout', () => {
  test('header and entity key sizes are frozen', () => {
    expect(HEADER_BYTES).toBe(40);
    expect(ENTITY_KEY_BYTES).toBe(8);
    expect(FRAME).toEqual({ snapshot: 1, baselineHeader: 2, baselineChunk: 3, events: 4 });
  });

  test('golden tiny snapshot pins the first 16 header bytes', () => {
    const table = new StringTable();
    const frame = encodeSnapshot(tinySnapshot(), table);

    // magic | version 2 | snapshot | flags 5 | length 23 | epochTableId 2 | 'e1','b1'
    expect(hexOf(frame, 16)).toBe('54465244020001051700000002000000');
    expect(frame.length).toBe(63);
    expect(readU32(frame, 8)).toBe(frame.length - HEADER_BYTES);

    const decoded = decodeSnapshot(frame, new StringTable());
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expectMatch(decoded.value, tinySnapshot(), '$');
  });
});

describe('snapshot', () => {
  test('a representative snapshot round-trips exactly', () => {
    const table = new StringTable();
    const frame = encodeSnapshot(representativeSnapshot(), table);
    const decoded = decodeSnapshot(frame, new StringTable());
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expectMatch(decoded.value, representativeSnapshot(), '$');
    expectMatch(decoded.value.self!.predictionState, SELF.predictionState, '$.self.predictionState');
    expect(readU16(frame, 32)).toBe(2);
    expect(readU16(frame, 34)).toBe(3);
    expect(readU16(frame, 36)).toBe(2);
    expect(readU16(frame, 38)).toBe(2);
  });

  test('truncating anywhere is rejected and never throws', () => {
    const frame = encodeSnapshot(representativeSnapshot(), new StringTable());
    for (let cut = 0; cut < frame.length; cut++) {
      expectRejected(decodeSnapshot(frame.subarray(0, cut), new StringTable()), 'out-of-range');
    }
    expect(decodeSnapshot(frame, new StringTable()).ok).toBe(true);
  });

  test('bad magic, version, frame type and length are rejected', () => {
    const frame = encodeSnapshot(representativeSnapshot(), new StringTable());
    expectRejected(decodeSnapshot(patched(frame, 0, 'u32', 0x44524655), new StringTable()), 'bad-enum');
    expectRejected(decodeSnapshot(patched(frame, 4, 'u16', RELEASE.protocol + 1), new StringTable()), 'bad-enum');
    expectRejected(decodeSnapshot(patched(frame, 6, 'u16', 0), new StringTable()), 'bad-enum');
    expectRejected(decodeSnapshot(patched(frame, 8, 'u32', frame.length - HEADER_BYTES + 1), new StringTable()), 'out-of-range');
    expectRejected(decodeSnapshot(patched(frame, 8, 'u32', 64 * 1024 + 1), new StringTable()), 'too-large');
  });

  test('excessive counts and an oversized table delta are rejected', () => {
    const frame = encodeSnapshot(representativeSnapshot(), new StringTable());
    expectRejected(decodeSnapshot(patched(frame, 32, 'u16', 9), new StringTable()), 'too-many');
    expectRejected(decodeSnapshot(patched(frame, 36, 'u16', 513), new StringTable()), 'too-many');
    expectRejected(decodeSnapshot(patched(frame, HEADER_BYTES, 'u16', 65), new StringTable()), 'too-many');
  });

  test('a drifted string table is rejected before any id resolves', () => {
    const frame = encodeSnapshot(representativeSnapshot(), new StringTable());
    const drifted = new StringTable();
    drifted.intern('something-else');
    expectRejected(decodeSnapshot(frame, drifted), 'out-of-range');
    // A frame that is refused must not append its delta to a table that is already wrong.
    expect(drifted.size).toBe(1);
    expect(drifted.revision).toBe(1);
  });

  test('an entity that lies about its field mask is rejected', () => {
    const table = new StringTable();
    const frame = encodeSnapshot(bodyOnlySnapshot(), table);
    const warm = encodeSnapshot(bodyOnlySnapshot(), table);
    const section = HEADER_BYTES + (frame.length - warm.length + 2) + 4 + 1;
    expectRejected(decodeSnapshot(patched(frame, section + 6, 'u16', 0x40), new StringTable()), 'unknown-field');
  });

  test('non-finite floats and unknown ids are rejected', () => {
    const table = new StringTable();
    const frame = encodeSnapshot(bodyOnlySnapshot(), table);
    const warm = encodeSnapshot(bodyOnlySnapshot(), table);
    const section = HEADER_BYTES + (frame.length - warm.length + 2) + 4 + 1;

    expectRejected(decodeSnapshot(patched(frame, section + 8, 'f32', Number.NaN), new StringTable()), 'not-finite');
    expectRejected(decodeSnapshot(patched(frame, section + 8, 'f32', Number.POSITIVE_INFINITY), new StringTable()), 'not-finite');
    expectRejected(decodeSnapshot(patched(frame, section, 'u32', 0xffffffff), new StringTable()), 'bad-id');
    expectRejected(decodeSnapshot(patched(frame, section, 'u32', 0), new StringTable()), 'bad-id');
    expectRejected(decodeSnapshot(patched(frame, 16, 'u32', 0xffffffff), new StringTable()), 'bad-id');
  });

  test('a frame of another type is rejected', () => {
    const events = encodeEvents([], new StringTable());
    expectRejected(decodeSnapshot(events, new StringTable()), 'bad-enum');
    expectRejected(decodeEvents(encodeSnapshot(tinySnapshot(), new StringTable()), new StringTable()), 'bad-enum');
  });

  test('a frame that would break the table delta cap fails at the source', () => {
    const ships = Array.from({ length: 8 }, (_unused, index) =>
      makeShip(`ship-${index}`, {
        fit: {
          ...FIT,
          paintId: `paint-${index}`,
          slots: Object.fromEntries(['w1', 'w2', 'e1', 'r1', 'u1', 'u2'].map((slot) => [slot, `part-${index}-${slot}`])),
          fireGroups: [],
          powerPriority: [],
        },
      }));
    // A cold table cannot carry eight per-pilot fits: the baseline warms it first (B3).
    const table = new StringTable();
    expect(() => encodeSnapshot({ ...tinySnapshot(), ships }, table)).toThrow(RangeError);
    expect(table.size).toBe(0);
    expect(table.revision).toBe(0);
  });
});

describe('string table', () => {
  test('ids are stable across encodes and the revision only moves when entries are added', () => {
    const table = new StringTable();
    const receiver = new StringTable();
    const snapshot = representativeSnapshot();
    const first = encodeSnapshot(snapshot, table);
    const revision = readU32(first, 12);
    const size = table.size;
    expect(size).toBeGreaterThan(0);
    expect(decodeSnapshot(first, receiver).ok).toBe(true);

    const second = encodeSnapshot(snapshot, table);
    expect(table.size).toBe(size);
    expect(readU32(second, 12)).toBe(revision);
    expect(readU16(second, HEADER_BYTES)).toBe(0);

    // Same data, same ids: only the delta block shrinks, the body is byte-identical.
    const firstDelta = first.length - second.length + 2;
    expect(second.slice(HEADER_BYTES + 2)).toEqual(first.slice(HEADER_BYTES + firstDelta));

    const extended = encodeSnapshot(withPilot(snapshot, 'pilot-z'), table);
    expect(readU32(extended, 12)).toBe(revision + 1);
    expect(readU16(extended, HEADER_BYTES)).toBe(1);

    // The id keeps its index: a re-encode of the same data adds nothing to the table.
    const pilotIdIndex = table.intern('pilot-z');
    const repeated = encodeSnapshot(withPilot(snapshot, 'pilot-z'), table);
    expect(table.intern('pilot-z')).toBe(pilotIdIndex);
    expect(readU32(repeated, 12)).toBe(revision + 1);
    expect(readU16(repeated, HEADER_BYTES)).toBe(0);

    const decoded = decodeSnapshot(second, receiver);
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expectMatch(decoded.value, snapshot, '$');
  });

  test('an unknown id resolves to neither text nor the empty string', () => {
    const table = new StringTable();
    expect(table.get(0)).toBeNull();
    expect(table.get(1)).toBeUndefined();
    expect(table.intern('x')).toBe(1);
    expect(table.intern('x')).toBe(1);
    expect(table.intern('y')).toBe(2);
    expect(table.get(1)).toBe('x');
    expect(table.revision).toBe(2);
  });
});

describe('baseline', () => {
  test('a baseline header round-trips', () => {
    const header: BaselineHeader = {
      transferId: 'xfer-1',
      mapHash: 'deadbeefcafe0001',
      epoch: 'epoch-7',
      tick: 4096,
      chunkCount: 3,
      totalBytes: 90000,
    };
    const frame = encodeBaselineHeader(header, new StringTable());
    expect(readU16(frame, 6)).toBe(FRAME.baselineHeader);
    expect(readU32(frame, 24)).toBe(4096);
    const decoded = decodeBaselineHeader(frame, new StringTable());
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expectMatch(decoded.value, header, '$');
  });

  test('a baseline chunk round-trips and its bounds hold', () => {
    const bytes = new Uint8Array(1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7) & 0xff;
    const chunk: BaselineChunk = { transferId: 'xfer-1', index: 1, count: 3, bytes };
    const table = new StringTable();
    const frame = encodeBaselineChunk(chunk, table);
    const warm = encodeBaselineChunk(chunk, table);
    const decoded = decodeBaselineChunk(frame, new StringTable());
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expect(decoded.value.bytes).toEqual(bytes);
    expect(decoded.value.index).toBe(1);
    expect(decoded.value.count).toBe(3);
    expect(decoded.value.transferId).toBe('xfer-1');

    expect(readU16(warm, HEADER_BYTES)).toBe(0);
    const body = HEADER_BYTES + (frame.length - warm.length + 2);
    expectRejected(decodeBaselineChunk(patched(frame, body + 8, 'u32', 48 * 1024), new StringTable()), 'too-large');
    expectRejected(decodeBaselineChunk(patched(frame, body + 0, 'u32', 3), new StringTable()), 'out-of-range');
    expectRejected(decodeBaselineChunk(patched(frame, body + 4, 'u32', 33), new StringTable()), 'too-many');
  });

  test('encoding over a decoder cap fails at the source', () => {
    const huge = new Uint8Array(32 * 1024 + 1);
    expect(() => encodeBaselineChunk({ transferId: 'xfer-1', index: 0, count: 1, bytes: huge }, new StringTable())).toThrow(RangeError);
    expect(() => encodeBaselineHeader(
      { transferId: 'xfer-1', mapHash: 'deadbeef', epoch: 'epoch-7', tick: 1, chunkCount: 33, totalBytes: 1 },
      new StringTable(),
    )).toThrow(RangeError);
  });
});

describe('events', () => {
  function fixtureEvents(): SessionEvent[] {
    return [
      {
        deliverySeq: 91,
        tick: 4096,
        epoch: 'epoch-7',
        eventId: 'ev-1',
        kind: 'shot',
        payload: {
          shotId: 'shot-9',
          slotId: 'w1',
          weaponId: 'rivet30',
          ownerLifeId: 'ship-1-life/1',
          position: { x: 12.5, y: -3.25 },
          velocity: { x: 900.5, y: 12.75 },
          state: 'armed',
          expiresAtTick: 4400,
        },
      },
      {
        deliverySeq: 92,
        tick: 4096,
        epoch: 'epoch-7',
        eventId: 'ev-2',
        kind: 'impact',
        payload: {
          hitId: 'hit-4',
          kind: 'rock',
          targetId: 'rock-7',
          position: { x: 64.5, y: -32.25 },
          normal: { x: -1, y: 0.25 },
          damage: 12.75,
          energyJ: 4500000.5,
          destroyed: false,
          attackerPilotId: 'ship-1-pilot',
          victimPilotId: null,
        },
      },
      {
        deliverySeq: 93,
        tick: 4097,
        epoch: 'epoch-7',
        eventId: 'ev-3',
        kind: 'life',
        payload: { lifeId: 'ship-2-life/1', shipId: 'ship-2', pilotId: 'ship-2-pilot', life: 'destroyed', position: { x: 10.25, y: 20.5 }, respawnAtTick: 5000 },
      },
      {
        deliverySeq: 94,
        tick: 4097,
        epoch: 'epoch-7',
        eventId: 'ev-4',
        kind: 'roster',
        payload: { reason: 'captain', pilotId: 'ship-1-pilot', revision: 42 },
      },
      {
        deliverySeq: 95,
        tick: 4098,
        epoch: 'epoch-7',
        eventId: 'ev-5',
        kind: 'objective',
        payload: { objectiveId: 'obj-scan-north', state: 'complete', completed: 3, required: 3 },
      },
      {
        deliverySeq: 96,
        tick: 4098,
        epoch: 'epoch-7',
        eventId: 'ev-6',
        kind: 'result',
        payload: { resultId: 'result-1', outcome: 'mission-complete', winningTeamId: 'team-a' },
      },
      {
        deliverySeq: 97,
        tick: 4099,
        epoch: 'epoch-7',
        eventId: 'ev-7',
        kind: 'save',
        payload: { state: 'saved', at: '2026-09-10T12:00:00.000Z', reason: null },
      },
      {
        deliverySeq: 98,
        tick: 4099,
        epoch: 'epoch-7',
        eventId: 'ev-8',
        kind: 'notice',
        payload: { code: 'weapon-traffic-limit', message: 'Weapon traffic limit', forPilotId: null },
      },
    ];
  }

  test('every event payload round-trips', () => {
    const events = fixtureEvents();
    const frame = encodeEvents(events, new StringTable());
    expect(readU16(frame, 6)).toBe(FRAME.events);
    const decoded = decodeEvents(frame, new StringTable());
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expectMatch(decoded.value, events, '$');
  });

  test('repeated delivery with a warm table round-trips', () => {
    const table = new StringTable();
    const receiver = new StringTable();
    const events = fixtureEvents();
    expect(decodeEvents(encodeEvents(events, table), receiver).ok).toBe(true);
    const warm = encodeEvents(events, table);
    expect(readU16(warm, HEADER_BYTES)).toBe(0);
    const decoded = decodeEvents(warm, receiver);
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.code} ${decoded.detail}`);
    expectMatch(decoded.value, events, '$');
  });

  test('an unknown event kind is rejected', () => {
    const table = new StringTable();
    const events = fixtureEvents();
    const frame = encodeEvents(events, table);
    const warm = encodeEvents(events, table);
    // body: u16 count, then deliverySeq, tick, epoch, eventId, kind for the first event.
    const body = HEADER_BYTES + (frame.length - warm.length + 2);
    expectRejected(decodeEvents(patched(frame, body + 2 + 16, 'u8', 0xff), new StringTable()), 'bad-enum');
  });
});
