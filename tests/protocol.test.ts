/**
 * Control-plane contract (Plan B3). These are the rejections that keep a malformed or hostile frame
 * from reaching the authority at all, so they are tested as behaviour: each case asserts the typed
 * failure code, not merely that parsing failed.
 */

import { describe, expect, test } from 'bun:test';
import { RELEASE } from '../src/shared/contracts.ts';
import { parseClientMessage, parseServerMessage } from '../src/shared/protocol.ts';
import { finiteNumber, safeInteger, type Result } from '../src/shared/validate.ts';

const hello = (patch: Record<string, unknown> = {}): string => JSON.stringify({
  t: 'hello', protocol: RELEASE.protocol, contentVersion: RELEASE.contentVersion, name: 'Pilot',
  roomCode: null, resumeToken: null, campaignId: null, ...patch,
});

const code = (parsed: Result<unknown>): string => (parsed.ok ? 'ok' : parsed.code);

describe('client messages', () => {
  test('a well-formed hello is accepted with its optionals defaulted', () => {
    const parsed = parseClientMessage(hello());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ t: 'hello', name: 'Pilot', roomCode: null, resumeToken: null, campaignId: null });
  });

  test('non-text, malformed and unknown frames are refused', () => {
    expect(code(parseClientMessage({ t: 'hello' }))).toBe('bad-type');
    expect(code(parseClientMessage('{ not json'))).toBe('bad-type');
    expect(code(parseClientMessage('{"t":"shutdown"}'))).toBe('bad-enum');
    expect(code(parseClientMessage('[]'))).toBe('not-object');
  });

  test('a huge control frame is refused before it is parsed', () => {
    expect(code(parseClientMessage(`{"t":"hello","name":"${'a'.repeat(5000)}"}`))).toBe('too-large');
  });

  test('names are normalized, bounded and free of control or bidi characters', () => {
    expect(code(parseClientMessage(hello({ name: 'a'.repeat(21) })))).toBe('too-long');
    expect(code(parseClientMessage(hello({ name: 'a'.repeat(79) })))).toBe('too-long');
    expect(code(parseClientMessage(hello({ name: 'Pi\u202elot' })))).toBe('bad-name');
    expect(code(parseClientMessage(hello({ name: '   ' })))).toBe('bad-name');
    expect(code(parseClientMessage(hello({ name: ' Pilot' })))).toBe('bad-name');
    const parsed = parseClientMessage(hello({ name: 'Íona' }));
    expect(parsed.ok && parsed.value.t === 'hello' && parsed.value.name).toBe('Íona');
    // The byte cap is exactly reachable and not exceeded by any 20-character name.
    expect(parseClientMessage(hello({ name: '🚀'.repeat(20) })).ok).toBe(true);
  });

  test('a number JSON cannot carry is refused as the wrong type, not silently accepted', () => {
    // JSON turns Infinity/NaN into null before any parser sees them, so the defensive checks are
    // exercised directly on the validator as well as through the wire format.
    expect(code(parseClientMessage(hello({ protocol: 1e309 })))).toBe('bad-type');
    expect(code(parseClientMessage(JSON.stringify({ t: 'ping', nonce: 1, clientTimeMs: 1e309 })))).toBe('bad-type');
    expect(code(parseClientMessage(JSON.stringify({ t: 'release', epoch: 'e1', lifeId: 'l1', seq: -1 })))).toBe('out-of-range');
    expect(finiteNumber(1e309).ok).toBe(false);
    expect(code(finiteNumber(Number.NaN))).toBe('not-finite');
    expect(code(safeInteger(Number.MAX_SAFE_INTEGER + 1))).toBe('not-finite');
  });

  test('an input frame is bounded and its axes are clamped, not rejected', () => {
    const frame = (intent: Record<string, unknown>, targetTick = 100) => JSON.stringify({
      t: 'input',
      frame: { epoch: 'e1', lifeId: 'l1', seq: 1, targetTick, intent: { thrust: 0, turn: 0, strafe: 0, brake: false, boost: false, angularAssist: true, fireMask: 0, aimWorld: null, lockContactId: null, ...intent } },
    });
    const clamped = parseClientMessage(frame({ turn: 3, thrust: -4 }));
    expect(clamped.ok).toBe(true);
    if (clamped.ok && clamped.value.t === 'input') {
      expect(clamped.value.frame.intent.turn).toBe(1);
      expect(clamped.value.frame.intent.thrust).toBe(-1);
    }
    expect(code(parseClientMessage(frame({ turn: Number.NaN })))).toBe('bad-type');
    expect(code(parseClientMessage(frame({ turn: 1e309 })))).toBe('bad-type');
    expect(code(parseClientMessage(frame({ fireMask: 65536 })))).toBe('out-of-range');
    expect(code(parseClientMessage(frame({}, 0x1_0000_0000)))).toBe('out-of-range');
    expect(code(parseClientMessage(frame({ aimWorld: { x: 1e12, y: 0 } })))).toBe('out-of-range');
  });

  test('commands reject unknown fields instead of ignoring them', () => {
    const command = (payload: Record<string, unknown>) => JSON.stringify({ t: 'command', requestId: 'r1', command: payload });
    expect(code(parseClientMessage(command({ kind: 'ready', expectedRevision: 1, ready: true, secret: 'x' })))).toBe('unknown-field');
    expect(code(parseClientMessage(command({ kind: 'ready', expectedRevision: 1, ready: 'yes' })))).toBe('bad-type');
    expect(code(parseClientMessage(command({ kind: 'ready', expectedRevision: -1, ready: true })))).toBe('out-of-range');
    expect(code(parseClientMessage(command({ kind: 'leave', extra: 1 })))).toBe('unknown-field');
    expect(code(parseClientMessage(command({ kind: 'start' })))).toBe('missing-field');
    const ok = parseClientMessage(command({ kind: 'request-respawn' }));
    expect(ok.ok).toBe(true);
  });

  test('an edit-lobby patch cannot smuggle an unknown key or an empty patch', () => {
    const command = (patch: Record<string, unknown>) => JSON.stringify({ t: 'command', requestId: 'r1', command: { kind: 'edit-lobby', expectedRevision: 1, patch } });
    expect(code(parseClientMessage(command({ mapId: 'belt', nope: 1 })))).toBe('unknown-field');
    expect(code(parseClientMessage(command({})))).toBe('missing-field');
    expect(code(parseClientMessage(command({ mode: 'deathmatch' })))).toBe('bad-enum');
    expect(parseClientMessage(command({ mode: 'team-deathmatch', mapId: 'belt' })).ok).toBe(true);
  });
});

describe('server messages', () => {
  const welcome = (patch: Record<string, unknown> = {}) => JSON.stringify({
    t: 'welcome',
    protocol: RELEASE.protocol,
    contentVersion: RELEASE.contentVersion,
    epoch: 'epoch-1',
    tick: 0,
    pilotId: 'p1',
    sessionId: 's1',
    resumeToken: 'token',
    generation: 1,
    phase: 'lobby',
    seat: 0,
    host: {
      protocol: RELEASE.protocol, contentVersion: RELEASE.contentVersion, appVersion: '1', phase: 'lobby',
      guestOrigin: null, operatorOrigin: null, capacity: 8, occupied: 1, uptimeSeconds: 0, joinPolicy: 'open',
    },
    ...patch,
  });

  test('a welcome carries its seat and host information', () => {
    const parsed = parseServerMessage(welcome());
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.t === 'welcome') {
      expect(parsed.value.seat).toBe(0);
      expect(parsed.value.host.capacity).toBe(8);
    }
  });

  test('a welcome with a bad phase or an impossible seat is refused', () => {
    expect(code(parseServerMessage(welcome({ phase: 'warp' })))).toBe('bad-enum');
    expect(code(parseServerMessage(welcome({ seat: RELEASE.maxHumans })))).toBe('out-of-range');
    expect(code(parseServerMessage(welcome({ pilotId: '' })))).toBe('too-long');
  });

  test('typed codes are enforced on rejections and goodbyes', () => {
    expect(code(parseServerMessage(JSON.stringify({ t: 'reject', code: 'nonsense', message: 'x' })))).toBe('bad-enum');
    expect(code(parseServerMessage(JSON.stringify({ t: 'goodbye', code: 'incompatible', reason: 'build mismatch' })))).toBe('ok');
    expect(code(parseServerMessage(JSON.stringify({ t: 'notice', code: 'not-a-notice', message: 'x' })))).toBe('bad-enum');
  });

  test('view metadata validates objectives, scores and optional blocks', () => {
    const meta = (patch: Record<string, unknown> = {}) => JSON.stringify({
      t: 'meta',
      meta: {
        phase: 'live', link: 'online', pilotId: 'p1', epoch: 'e1', tick: 12, lobby: null, campaign: null,
        host: null, debrief: null, save: 'clean', teamScores: { blue: 3 }, objectives: [], respawnAtTick: null,
        phaseEndsAtTick: null, map: null, economy: null,
        ...patch,
      },
    });
    const parsed = parseServerMessage(meta());
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.t === 'meta') expect(parsed.value.meta.teamScores.blue).toBe(3);

    expect(code(parseServerMessage(meta({ tick: -1 })))).toBe('out-of-range');
    expect(code(parseServerMessage(meta({ teamScores: { blue: -4 } })))).toBe('out-of-range');
    expect(code(parseServerMessage(meta({ save: 'maybe' })))).toBe('bad-enum');
    expect(code(parseServerMessage(meta({ objectives: [{ id: 'o1', title: 'x', state: 'nope', completed: 0, required: 1, marker: null }] })))).toBe('bad-enum');
    expect(code(parseServerMessage(meta({ objectives: [{ id: 'o1', title: 'x', state: 'active', completed: 0, required: 1, marker: { x: 1e309, y: 0 } }] })))).toBe('bad-type');
    expect(parseServerMessage(meta({ objectives: [{ id: 'o1', title: 'Recover the archives', state: 'active', completed: 1, required: 3, marker: { x: 5, y: -5 } }] })).ok).toBe(true);
  });

  test('a lobby with more seats than the release allows is refused', () => {
    const roster = Array.from({ length: RELEASE.maxHumans }, (_, index) => ({
      pilotId: `p${index}`, name: `Pilot ${index}`, teamId: index % 2 === 0 ? 'blue' : 'red', isBot: false,
      presence: 'connected', life: 'staged', readyRevision: null, pingMs: null, seat: index,
      fit: { chassisId: 'kestrel', paintId: 'default', slots: {}, fireGroups: [], powerPriority: ['engine', 'reactor', 'sensor', 'utility', 'weapon', 'armor'] },
    }));
    const lobby = (entries: unknown[]) => JSON.stringify({
      t: 'lobby',
      lobby: { revision: 1, captainId: 'p0', mode: 'team-deathmatch', mapId: 'belt', missionId: null, joinPolicy: 'open', roster: entries, canStart: false, startBlockers: [], botFill: null },
    });
    expect(parseServerMessage(lobby(roster)).ok).toBe(true);
    expect(code(parseServerMessage(lobby([...roster, { ...roster[0], pilotId: 'extra' }])))).toBe('too-many');
    expect(code(parseServerMessage(lobby([{ ...roster[0], seat: 99 }])))).toBe('out-of-range');
    expect(code(parseServerMessage(lobby([{ ...roster[0], presence: 'ghost' }])))).toBe('bad-enum');
  });
});
