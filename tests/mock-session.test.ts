import { describe, expect, test } from 'bun:test';
import {
  aliveScenario, captainTransferScenario, deadScenario, disabledScenario, emptyLobbyScenario, fullLobbyScenario,
  invalidFitScenario, loadingFailureScenario, MockSession, MockSessionError, packetStallScenario,
  reconnectFailureScenario, reconnectSuccessScenario, scoreTieScenario, secondMatchScenario,
  settlementFailedScenario, settlementPendingScenario,
} from '../src/client/session/mock';
import type { MockScenario } from '../src/client/session/mock';
import { EMPTY_FLIGHT_INTENT } from '../src/shared/contracts';
import type { ClientView, ConnectOptions, LinkState, SessionEvent } from '../src/shared/contracts';

const OPTIONS: ConnectOptions = { transport: 'lan', address: '127.0.0.1:8080', pilotName: 'Ace' };

async function open(scenario: MockScenario): Promise<MockSession> {
  const port = new MockSession(scenario);
  await port.connect(OPTIONS, new AbortController().signal);
  return port;
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (cause: unknown) => cause);
}

describe('mock session', () => {
  test('aborting a connect fails the link and leaves the port disposed', async () => {
    const port = new MockSession(emptyLobbyScenario());
    const controller = new AbortController();
    const links: LinkState[] = [];
    port.subscribe(view => links.push(view.link));

    const connecting = port.connect(OPTIONS, controller.signal);
    controller.abort();
    const failure = await failureOf(connecting);

    expect(failure).toBeInstanceOf(MockSessionError);
    expect((failure as MockSessionError).code).toBe('aborted');
    expect(links).toEqual(['connecting', 'failed']);
    expect(port.view().link).toBe('failed');

    // Nothing lingers: the aborted port is disposed, so later use cannot resurrect callbacks.
    let notified = 0;
    port.subscribe(() => { notified += 1; });
    port.advance(5_000);
    await port.dispose();
    await port.dispose();
    expect(notified).toBe(0);
    expect(port.view().link).toBe('failed');
  });

  test('an empty lobby blocks on the pilot and fills with bots', async () => {
    const port = await open(emptyLobbyScenario());
    const lobby = port.view().lobby!;
    expect(lobby.roster).toHaveLength(1);
    expect(lobby.canStart).toBe(false);
    expect(lobby.startBlockers.join()).toContain('Waiting for');

    expect((await port.command({ kind: 'ready', expectedRevision: lobby.revision, ready: true }, 'ready')).code).toBe('ok');
    expect(port.view().lobby!.canStart).toBe(true);

    const filled = await port.command({ kind: 'bot-fill', expectedRevision: lobby.revision, total: 4, difficulty: 'normal' }, 'bots');
    expect(filled.code).toBe('ok');
    const after = port.view().lobby!;
    expect(after.roster).toHaveLength(4);
    expect(after.roster.filter(entry => entry.isBot)).toHaveLength(3);
    expect(after.botFill).toEqual({ total: 4, difficulty: 'normal' });
    // A lobby edit bumps the revision and revokes the readiness it was given for (B1).
    expect(after.revision).toBe(lobby.revision + 1);
    expect(after.roster[0]!.readyRevision).toBeNull();
    expect(after.canStart).toBe(false);
  });

  test('a full lobby starts once its human is ready and refuses a ninth seat', async () => {
    const port = await open(fullLobbyScenario());
    const lobby = port.view().lobby!;
    expect(lobby.roster).toHaveLength(8);
    expect(lobby.roster.filter(entry => entry.isBot)).toHaveLength(7);

    const overflow = await port.command({ kind: 'bot-fill', expectedRevision: lobby.revision, total: 9, difficulty: 'normal' }, 'overflow');
    expect(overflow.ok).toBe(false);
    expect(port.view().lobby!.roster).toHaveLength(8);

    expect((await port.command({ kind: 'ready', expectedRevision: lobby.revision, ready: true }, 'ready')).code).toBe('ok');
    expect((await port.command({ kind: 'start', expectedRevision: lobby.revision }, 'start')).code).toBe('ok');
    expect(port.view().phase).toBe('loading');
  });

  test('a stale revision is rejected and changes nothing', async () => {
    const port = await open(emptyLobbyScenario());
    const before = port.view().lobby!;
    const result = await port.command({ kind: 'ready', expectedRevision: before.revision - 1, ready: true }, 'stale');

    expect(result.code).toBe('stale-revision');
    expect(result.revision).toBe(before.revision);
    const after = port.view().lobby!;
    expect(after.revision).toBe(before.revision);
    expect(after.roster[0]!.readyRevision).toBeNull();
  });

  test('an invalid fit is rejected while the previous fit stays in the roster', async () => {
    const port = await open(invalidFitScenario());
    const before = port.view().lobby!;
    const previous = before.roster[0]!.fit;
    const slots = Object.fromEntries(Object.entries(previous.slots).filter(([slotId]) => slotId !== 'e1'));

    const rejected = await port.command({ kind: 'set-pilot', expectedRevision: before.revision, fit: { ...previous, slots } }, 'bad-fit');
    expect(rejected.code).toBe('invalid-fit');
    expect(rejected.message).toContain('missing-engine');

    const after = port.view().lobby!;
    expect(after.revision).toBe(before.revision);
    expect(after.roster[0]!.fit).toEqual(previous);
  });

  test('captain transfer moves the seat and a guest cannot start', async () => {
    const port = await open(captainTransferScenario());
    const rosterEvents: SessionEvent[] = [];
    port.events(event => { if (event.kind === 'roster') rosterEvents.push(event); });
    const lobby = port.view().lobby!;
    const target = lobby.roster[1]!;
    expect(lobby.captainId).not.toBe(target.pilotId);

    const transfer = await port.command({ kind: 'captain', expectedRevision: lobby.revision, action: 'transfer', pilotId: target.pilotId }, 'captain');
    expect(transfer.code).toBe('ok');
    const moved = port.view().lobby!;
    expect(moved.captainId).toBe(target.pilotId);
    expect(rosterEvents).toHaveLength(1);
    expect(rosterEvents[0]!.payload).toMatchObject({ reason: 'captain', pilotId: target.pilotId });

    const refused = await port.command({ kind: 'start', expectedRevision: moved.revision }, 'start');
    expect(refused.code).toBe('not-captain');
  });

  test('alive, disabled and dead are distinguishable, and a dead pilot respawns', async () => {
    const alive = await open(aliveScenario());
    expect(alive.view().self!.ship.life).toBe('alive');
    expect(alive.view().respawnAtTick).toBeNull();

    const disabled = await open(disabledScenario());
    expect(disabled.view().self!.ship.life).toBe('disabled');
    expect(disabled.view().self!.ship.hull).toBeGreaterThan(0);

    const dead = await open(deadScenario());
    const view = dead.view();
    expect(view.self!.ship.life).toBe('destroyed');
    expect(view.self!.ship.hull).toBe(0);
    expect(view.respawnAtTick).toBeGreaterThan(view.tick);

    const life: SessionEvent[] = [];
    dead.events(event => { if (event.kind === 'life') life.push(event); });
    expect((await dead.command({ kind: 'request-respawn' }, 'respawn')).code).toBe('ok');
    expect(dead.view().self!.ship.life).toBe('respawning');
    expect(life).toHaveLength(1);
  });

  test('a stalled link is reconnecting, loses deliveries and resumes on a fresh epoch', async () => {
    const port = await open(packetStallScenario());
    const sequences: number[] = [];
    port.events(event => sequences.push(event.deliverySeq));
    const epoch = port.view().epoch;

    port.advance(600);
    expect(port.view().link).toBe('reconnecting');

    port.advance(1_400);
    expect(port.view().link).toBe('online');
    expect(port.view().epoch).toBeTruthy();
    expect(port.view().epoch).not.toBe(epoch);

    const gaps = sequences.slice(1).map((seq, index) => seq - sequences[index]!);
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeGreaterThan(1);
  });

  test('a reconnect returns a lobby seat to connected', async () => {
    const port = await open(reconnectSuccessScenario());
    expect(port.view().lobby!.roster[0]!.presence).toBe('connected');

    port.advance(600);
    expect(port.view().link).toBe('reconnecting');
    expect(port.view().lobby!.roster[0]!.presence).toBe('reconnecting');

    port.advance(1_000);
    expect(port.view().link).toBe('online');
    expect(port.view().lobby!.roster[0]!.presence).toBe('connected');
  });

  test('a rejected resume and a blown loading deadline are typed failures', async () => {
    const resume = new MockSession(reconnectFailureScenario());
    const resumed = await failureOf(resume.connect(OPTIONS, new AbortController().signal));
    expect(resumed).toBeInstanceOf(MockSessionError);
    expect((resumed as MockSessionError).code).toBe('reconnect-failed');
    expect(resume.view().link).toBe('failed');

    const loading = new MockSession(loadingFailureScenario());
    const failed = await failureOf(loading.connect(OPTIONS, new AbortController().signal));
    expect((failed as MockSessionError).code).toBe('loading-failed');
    expect(loading.view().link).toBe('failed');

    // The deadline is recoverable: retrying the same port reaches the lobby.
    await loading.connect(OPTIONS, new AbortController().signal);
    expect(loading.view().link).toBe('online');
    expect(loading.view().phase).toBe('lobby');
  });

  test('a score tie resolves in sudden death', async () => {
    const port = await open(scoreTieScenario());
    expect(port.view().teamScores['team-a']).toBe(port.view().teamScores['team-b']);
    expect(port.view().phase).toBe('live');

    port.advance(5_000);
    expect(port.view().teamScores['team-a']).not.toBe(port.view().teamScores['team-b']);
    expect(port.view().phase).toBe('settlement');
  });

  test('settlement reaches saved', async () => {
    const port = await open(settlementPendingScenario());
    const announced: SessionEvent[] = [];
    port.events(event => announced.push(event));
    expect(port.view().save).toBe('pending');

    port.advance(2_000);
    expect(port.view().save).toBe('saved');
    expect(announced).toHaveLength(1);
    expect(announced[0]!.payload).toMatchObject({ state: 'saved' });
  });

  test('a failed settlement blocks until the retry commits', async () => {
    const port = await open(settlementFailedScenario());
    expect(port.view().save).toBe('pending');

    port.advance(2_000);
    expect(port.view().save).toBe('failed');

    expect((await port.command({ kind: 'recovery', action: 'retry-checkpoint' }, 'retry')).code).toBe('ok');
    expect(port.view().save).toBe('saved');
    expect((await port.command({ kind: 'recovery', action: 'retry-checkpoint' }, 'retry-again')).code).toBe('denied');
  });

  test('a second match runs on a fresh epoch under one subscription set', async () => {
    const port = await open(secondMatchScenario());
    const first = port.view();
    expect(first.phase).toBe('debrief');
    expect(first.epoch).toBeTruthy();
    expect(first.debrief!.outcome).toBe('victory');

    let notified = 0;
    const unsubscribe = port.subscribe(() => { notified += 1; });

    expect((await port.command({ kind: 'return-lobby' }, 'return')).code).toBe('ok');
    const lobby = port.view().lobby!;
    expect(port.view().phase).toBe('lobby');
    expect(port.view().epoch).toBeNull();

    expect((await port.command({ kind: 'ready', expectedRevision: lobby.revision, ready: true }, 'ready')).code).toBe('ok');
    expect((await port.command({ kind: 'start', expectedRevision: lobby.revision }, 'start')).code).toBe('ok');
    const second = port.view();
    expect(second.phase).toBe('loading');
    expect(second.epoch).not.toBe(first.epoch);
    expect(notified).toBe(3);

    unsubscribe();
    expect((await port.command({ kind: 'return-lobby' }, 'return-late')).ok).toBe(false);
    expect(notified).toBe(3);
  });

  test('the view is deep-frozen and subscriptions fire only on change', async () => {
    const port = await open(emptyLobbyScenario());
    const view: ClientView = port.view();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.lobby)).toBe(true);
    expect(Object.isFrozen(view.lobby!.roster)).toBe(true);
    expect(Object.isFrozen(view.lobby!.roster[0]!.fit.slots)).toBe(true);

    let notified = 0;
    const stop = port.subscribe(() => { notified += 1; });
    port.setIntent(EMPTY_FLIGHT_INTENT);
    expect(port.intent).toBe(EMPTY_FLIGHT_INTENT);
    port.releaseControls('blur');
    expect(port.intent).toBeNull();
    expect(port.releaseReason).toBe('blur');
    expect(notified).toBe(0);

    let announced = 0;
    const stopEvents = port.events(() => { announced += 1; });
    expect((await port.command({ kind: 'ready', expectedRevision: view.lobby!.revision, ready: true }, 'ready')).code).toBe('ok');
    expect(notified).toBe(1);
    expect(announced).toBe(1);

    stop();
    stopEvents();
    port.advance(1_000);
    expect(notified).toBe(1);
    expect(announced).toBe(1);
  });
});
