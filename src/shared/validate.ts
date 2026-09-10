/**
 * Bounded runtime validation (Plan B3). Every value that arrives from a client, a socket or saved
 * data passes through here *before* it can allocate, spawn, spend or mutate. Validators never
 * silently repair: an invalid fit is rejected as-is so the previous build stays intact.
 *
 * Structured results rather than exceptions, so the server can answer with a typed code without
 * building an error object per frame.
 */

import type { Command, Fit, FlightIntent, Id, InputFrame, Mode, SlotKind, Vec2 } from './contracts.ts';
import { RELEASE } from './contracts.ts';

export type InvalidCode =
  | 'not-object'
  | 'missing-field'
  | 'bad-type'
  | 'bad-enum'
  | 'bad-id'
  | 'bad-name'
  | 'not-finite'
  | 'out-of-range'
  | 'too-long'
  | 'too-many'
  | 'unknown-field'
  | 'too-large';

export interface Invalid { ok: false; code: InvalidCode; detail: string }
export interface Valid<T> { ok: true; value: T }
export type Result<T> = Valid<T> | Invalid;

export function fail<T>(code: InvalidCode, detail: string): Result<T> {
  return { ok: false, code, detail };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/**
 * Re-emit a nested failure from a parser whose own result type differs. `Result<T>` is
 * `Valid<T> | Invalid`, so an `Invalid` is always assignable and no cast is needed.
 */
export function propagate<T>(invalid: Invalid): Result<T> {
  return invalid;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects NaN, ±Infinity (including JSON `1e309`) and values outside explicit bounds. */
export function finiteNumber(value: unknown, min = -1e9, max = 1e9): Result<number> {
  if (value === undefined) return fail('missing-field', 'expected number, got undefined');
  if (typeof value !== 'number') return fail('bad-type', `expected number, got ${typeof value}`);
  if (!Number.isFinite(value)) return fail('not-finite', String(value));
  if (value < min || value > max) return fail('out-of-range', `${value} outside [${min}, ${max}]`);
  return ok(value);
}

export function safeInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): Result<number> {
  if (value === undefined) return fail('missing-field', 'expected integer, got undefined');
  if (typeof value !== 'number') return fail('bad-type', `expected number, got ${typeof value}`);
  if (!Number.isSafeInteger(value)) return fail('not-finite', String(value));
  if (value < min || value > max) return fail('out-of-range', `${value} outside [${min}, ${max}]`);
  return ok(value);
}

export function boolField(value: unknown): Result<boolean> {
  return typeof value === 'boolean' ? ok(value) : fail('bad-type', `expected boolean, got ${typeof value}`);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]{0,63}$/;

export function idString(value: unknown): Result<Id> {
  if (typeof value !== 'string') return fail('bad-type', `expected string, got ${typeof value}`);
  if (value.length === 0 || value.length > 64) return fail('too-long', `id length ${value.length}`);
  if (!ID_PATTERN.test(value)) return fail('bad-id', value);
  return ok(value);
}

/** Control characters, bidi overrides and line separators may not appear in any client string. */
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

export function boundedString(value: unknown, maxBytes: number, maxChars: number): Result<string> {
  if (typeof value !== 'string') return fail('bad-type', `expected string, got ${typeof value}`);
  const normalized = value.normalize('NFC');
  if (FORBIDDEN.test(normalized)) return fail('bad-name', 'control or bidi characters');
  if ([...normalized].length > maxChars) return fail('too-long', `${[...normalized].length} characters`);
  const bytes = utf8Length(normalized);
  if (bytes > maxBytes) return fail('too-large', `${bytes} UTF-8 bytes`);
  return ok(normalized);
}

/** Display names: 1–20 visible characters, ≤80 UTF-8 bytes, NFC, no surrounding whitespace. */
export function displayName(value: unknown): Result<string> {
  const bounded = boundedString(value, 80, 20);
  if (!bounded.ok) return bounded;
  const trimmed = bounded.value.trim();
  if (trimmed.length === 0) return fail('bad-name', 'empty name');
  if (trimmed !== bounded.value) return fail('bad-name', 'leading or trailing whitespace');
  return ok(trimmed);
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function enumField<T extends string>(value: unknown, allowed: readonly T[]): Result<T> {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? ok(value as T)
    : fail('bad-enum', String(value));
}

export function optionalField<T>(value: unknown, parse: (input: unknown) => Result<T>): Result<T | undefined> {
  return value === undefined ? ok(undefined) : parse(value);
}

export function boundedArray<T>(value: unknown, max: number, parse: (item: unknown, index: number) => Result<T>): Result<T[]> {
  if (!Array.isArray(value)) return fail('bad-type', `expected array, got ${typeof value}`);
  if (value.length > max) return fail('too-many', `${value.length} > ${max}`);
  const out: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = parse(value[index], index);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out);
}

export function vec2Field(value: unknown, maxMagnitude = 1e6): Result<Vec2> {
  if (!isPlainObject(value)) return fail('bad-type', 'expected vector object');
  const x = finiteNumber(value.x, -maxMagnitude, maxMagnitude);
  if (!x.ok) return x;
  const y = finiteNumber(value.y, -maxMagnitude, maxMagnitude);
  if (!y.ok) return y;
  if (Math.hypot(x.value, y.value) > maxMagnitude) return fail('out-of-range', 'vector magnitude');
  return ok({ x: x.value, y: y.value });
}

export function clampAxis(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

const SLOT_ID_PATTERN = /^[wearsu]\d{1,2}$/;

export function slotId(value: unknown): Result<Id> {
  if (typeof value !== 'string') return fail('bad-type', 'expected slot id');
  if (!SLOT_ID_PATTERN.test(value)) return fail('bad-id', value);
  return ok(value);
}

const SLOT_KINDS: readonly SlotKind[] = ['weapon', 'engine', 'reactor', 'armor', 'sensor', 'utility'];

/**
 * Structural fit validation. Semantic validation (budget, slots, sizes) is `deriveFit`, which the
 * authority runs on every accepted fit so an invalid build can never fly.
 */
export function validateFit(value: unknown): Result<Fit> {
  if (!isPlainObject(value)) return fail('not-object', 'fit');
  const chassisId = idString(value.chassisId);
  if (!chassisId.ok) return chassisId;
  const paintId = idString(value.paintId);
  if (!paintId.ok) return paintId;
  if (!isPlainObject(value.slots)) return fail('bad-type', 'fit.slots');
  const entries = Object.entries(value.slots);
  if (entries.length > 16) return fail('too-many', `fit.slots ${entries.length}`);
  const slots: Record<Id, Id> = {};
  for (const [key, partValue] of entries) {
    const slot = slotId(key);
    if (!slot.ok) return slot;
    const partId = idString(partValue);
    if (!partId.ok) return partId;
    slots[slot.value] = partId.value;
  }
  const fireGroups = boundedArray(value.fireGroups, 2, (group, index) => {
    const ids = boundedArray(group, 8, item => slotId(item));
    if (!ids.ok) return ids;
    return ok(ids.value as Id[]);
  });
  if (!fireGroups.ok) return fireGroups;
  const powerPriority = boundedArray(value.powerPriority, SLOT_KINDS.length, item => enumField(item, SLOT_KINDS));
  if (!powerPriority.ok) return powerPriority;
  return ok({
    chassisId: chassisId.value,
    paintId: paintId.value,
    slots,
    fireGroups: fireGroups.value,
    powerPriority: powerPriority.value,
  });
}

export function validateFlightIntent(value: unknown): Result<FlightIntent> {
  if (!isPlainObject(value)) return fail('not-object', 'intent');
  const axes: number[] = [];
  for (const key of ['thrust', 'turn', 'strafe'] as const) {
    const axis = finiteNumber(value[key], -4, 4);
    if (!axis.ok) return axis;
    axes.push(clampAxis(axis.value));
  }
  const flags: boolean[] = [];
  for (const key of ['brake', 'boost', 'angularAssist'] as const) {
    const flag = boolField(value[key]);
    if (!flag.ok) return flag;
    flags.push(flag.value);
  }
  const fireMask = safeInteger(value.fireMask, 0, 0xffff);
  if (!fireMask.ok) return fireMask;
  const aim = value.aimWorld === null || value.aimWorld === undefined ? ok(null) : vec2Field(value.aimWorld, 1e6);
  if (!aim.ok) return aim;
  const lock = value.lockContactId === null || value.lockContactId === undefined ? ok(null) : idString(value.lockContactId);
  if (!lock.ok) return lock;
  return ok({
    thrust: axes[0]!,
    turn: axes[1]!,
    strafe: axes[2]!,
    brake: flags[0]!,
    boost: flags[1]!,
    angularAssist: flags[2]!,
    fireMask: fireMask.value,
    aimWorld: aim.value,
    lockContactId: lock.value,
  });
}

const MAX_TICK = 0xffffffff;

export function validateInputFrame(value: unknown, epoch: string | null, lifeId: string | null): Result<InputFrame> {
  if (!isPlainObject(value)) return fail('not-object', 'input frame');
  if (epoch !== null && value.epoch !== epoch) return fail('bad-id', 'epoch mismatch');
  if (lifeId !== null && value.lifeId !== lifeId) return fail('bad-id', 'life mismatch');
  const seq = safeInteger(value.seq, 0, MAX_TICK);
  if (!seq.ok) return seq;
  const targetTick = safeInteger(value.targetTick, 0, MAX_TICK);
  if (!targetTick.ok) return targetTick;
  const intent = validateFlightIntent(value.intent);
  if (!intent.ok) return intent;
  return ok({ epoch: String(value.epoch), lifeId: String(value.lifeId), seq: seq.value, targetTick: targetTick.value, intent: intent.value });
}

const MODES: readonly Mode[] = ['campaign', 'skirmish', 'team-deathmatch'];
const COMMAND_KINDS = [
  'edit-lobby', 'set-pilot', 'ready', 'start', 'interact', 'vote', 'reload', 'sensor-mode', 'utility',
  'crew-order', 'extraction', 'bot-fill', 'captain', 'recovery', 'inventory', 'request-respawn', 'return-lobby', 'leave',
] as const;

const COMMAND_FIELDS: Record<(typeof COMMAND_KINDS)[number], readonly string[]> = {
  'edit-lobby': ['kind', 'expectedRevision', 'patch'],
  'set-pilot': ['kind', 'expectedRevision', 'name', 'teamId', 'fit'],
  ready: ['kind', 'expectedRevision', 'ready'],
  start: ['kind', 'expectedRevision'],
  interact: ['kind', 'entityId', 'action'],
  vote: ['kind', 'decisionId', 'optionId'],
  reload: ['kind', 'slotId'],
  'sensor-mode': ['kind', 'mode'],
  utility: ['kind', 'slotId', 'targetId', 'active'],
  'crew-order': ['kind', 'order', 'contactId'],
  extraction: ['kind', 'action'],
  'bot-fill': ['kind', 'expectedRevision', 'total', 'difficulty'],
  captain: ['kind', 'expectedRevision', 'action', 'pilotId'],
  recovery: ['kind', 'action'],
  inventory: ['kind', 'expectedRevision', 'action', 'itemId'],
  'request-respawn': ['kind'],
  'return-lobby': ['kind'],
  leave: ['kind'],
};

/**
 * Command validation. Unknown fields are rejected rather than ignored so a client cannot smuggle
 * extra state past the authority, and every mutation carries its expected revision.
 */
export function validateCommand(value: unknown): Result<Command> {
  if (!isPlainObject(value)) return fail('not-object', 'command');
  const kind = enumField(value.kind, COMMAND_KINDS);
  if (!kind.ok) return kind;
  const allowed = COMMAND_FIELDS[kind.value];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return fail('unknown-field', `${kind.value}.${key}`);
  }
  const revision = () => safeInteger(value.expectedRevision, 0, MAX_TICK);
  switch (kind.value) {
    case 'edit-lobby': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      if (!isPlainObject(value.patch)) return fail('bad-type', 'patch');
      const patch: { mode?: Mode; mapId?: Id; missionId?: Id; joinPolicy?: 'open' | 'code' | 'closed' } = {};
      const patchKeys = Object.keys(value.patch);
      for (const key of patchKeys) if (!['mode', 'mapId', 'missionId', 'joinPolicy'].includes(key)) return fail('unknown-field', `patch.${key}`);
      if ('mode' in value.patch) {
        const mode = enumField(value.patch.mode, MODES);
        if (!mode.ok) return mode;
        patch.mode = mode.value;
      }
      for (const key of ['mapId', 'missionId'] as const) {
        if (key in value.patch) {
          const id = idString(value.patch[key]);
          if (!id.ok) return id;
          patch[key] = id.value;
        }
      }
      if ('joinPolicy' in value.patch) {
        const policy = enumField(value.patch.joinPolicy, ['open', 'code', 'closed'] as const);
        if (!policy.ok) return policy;
        patch.joinPolicy = policy.value;
      }
      if (Object.keys(patch).length === 0) return fail('missing-field', 'empty patch');
      return ok({ kind: 'edit-lobby', expectedRevision: expectedRevision.value, patch });
    }
    case 'set-pilot': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      const command: Extract<Command, { kind: 'set-pilot' }> = { kind: 'set-pilot', expectedRevision: expectedRevision.value };
      if ('name' in value) {
        const name = displayName(value.name);
        if (!name.ok) return name;
        command.name = name.value;
      }
      if ('teamId' in value) {
        const teamId = idString(value.teamId);
        if (!teamId.ok) return teamId;
        command.teamId = teamId.value;
      }
      if ('fit' in value) {
        const fit = validateFit(value.fit);
        if (!fit.ok) return fit;
        command.fit = fit.value;
      }
      if (command.name === undefined && command.teamId === undefined && command.fit === undefined) return fail('missing-field', 'empty set-pilot');
      return ok(command);
    }
    case 'ready': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      const ready = boolField(value.ready);
      if (!ready.ok) return ready;
      return ok({ kind: 'ready', expectedRevision: expectedRevision.value, ready: ready.value });
    }
    case 'start': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      return ok({ kind: 'start', expectedRevision: expectedRevision.value });
    }
    case 'interact': {
      const entityId = idString(value.entityId);
      if (!entityId.ok) return entityId;
      const action = enumField(value.action, ['dock', 'recover', 'repair', 'scan', 'rescue'] as const);
      if (!action.ok) return action;
      return ok({ kind: 'interact', entityId: entityId.value, action: action.value });
    }
    case 'vote': {
      const decisionId = idString(value.decisionId);
      if (!decisionId.ok) return decisionId;
      const optionId = idString(value.optionId);
      if (!optionId.ok) return optionId;
      return ok({ kind: 'vote', decisionId: decisionId.value, optionId: optionId.value });
    }
    case 'reload': {
      const slot = slotId(value.slotId);
      if (!slot.ok) return slot;
      return ok({ kind: 'reload', slotId: slot.value });
    }
    case 'sensor-mode': {
      const mode = enumField(value.mode, ['passive', 'active'] as const);
      if (!mode.ok) return mode;
      return ok({ kind: 'sensor-mode', mode: mode.value });
    }
    case 'utility': {
      const slot = slotId(value.slotId);
      if (!slot.ok) return slot;
      const target = value.targetId === null || value.targetId === undefined ? ok(null) : idString(value.targetId);
      if (!target.ok) return target;
      const active = boolField(value.active);
      if (!active.ok) return active;
      return ok({ kind: 'utility', slotId: slot.value, targetId: target.value, active: active.value });
    }
    case 'crew-order': {
      const order = enumField(value.order, ['focus', 'defend', 'recover', 'regroup'] as const);
      if (!order.ok) return order;
      const contact = value.contactId === null || value.contactId === undefined ? ok(null) : idString(value.contactId);
      if (!contact.ok) return contact;
      return ok({ kind: 'crew-order', order: order.value, contactId: contact.value });
    }
    case 'extraction': {
      const action = enumField(value.action, ['request', 'confirm', 'cancel'] as const);
      if (!action.ok) return action;
      return ok({ kind: 'extraction', action: action.value });
    }
    case 'bot-fill': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      const total = safeInteger(value.total, 0, RELEASE.maxPvpCombatants);
      if (!total.ok) return total;
      const difficulty = enumField(value.difficulty, ['easy', 'normal', 'hard'] as const);
      if (!difficulty.ok) return difficulty;
      return ok({ kind: 'bot-fill', expectedRevision: expectedRevision.value, total: total.value, difficulty: difficulty.value });
    }
    case 'captain': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      const action = enumField(value.action, ['transfer', 'remove-seat'] as const);
      if (!action.ok) return action;
      const pilotId = idString(value.pilotId);
      if (!pilotId.ok) return pilotId;
      return ok({ kind: 'captain', expectedRevision: expectedRevision.value, action: action.value, pilotId: pilotId.value });
    }
    case 'recovery': {
      const action = enumField(value.action, ['tow', 'retry-checkpoint', 'return-carrier'] as const);
      if (!action.ok) return action;
      return ok({ kind: 'recovery', action: action.value });
    }
    case 'inventory': {
      const expectedRevision = revision();
      if (!expectedRevision.ok) return expectedRevision;
      const action = enumField(value.action, ['buy', 'repair', 'restock'] as const);
      if (!action.ok) return action;
      const itemId = idString(value.itemId);
      if (!itemId.ok) return itemId;
      return ok({ kind: 'inventory', expectedRevision: expectedRevision.value, action: action.value, itemId: itemId.value });
    }
    case 'request-respawn':
      return ok({ kind: 'request-respawn' });
    case 'return-lobby':
      return ok({ kind: 'return-lobby' });
    case 'leave':
      return ok({ kind: 'leave' });
  }
}

/** Origin allowlist: served origins plus explicitly enabled dev origins (B3). */
export function originAllowed(origin: string | null | undefined, allowed: readonly string[]): boolean {
  if (origin === null || origin === undefined || origin.length === 0) return false;
  return allowed.some(entry => entry === origin || entry === '*');
}
