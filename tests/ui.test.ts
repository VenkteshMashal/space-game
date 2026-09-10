/**
 * Shell acceptance tests (Plan A2/A6). No browser: the shell is driven through a recording surface
 * and a deterministic frame clock, so every claim here is about observable behaviour — which screen
 * a control reaches, what an overlay does to a live match, that a draft survives a stale roster,
 * that a rejected fit keeps the previous build, that pagination follows measured height, and that
 * one disposal leaves nothing behind.
 */

import { describe, expect, test } from 'bun:test';
import {
  aliveScenario, captainTransferScenario, deadScenario, emptyLobbyScenario, fullLobbyScenario,
  invalidFitScenario, loadingFailureScenario, MockSession, packetStallScenario,
  secondMatchScenario, settlementFailedScenario, settlementPendingScenario, scoreTieScenario,
} from '../src/client/session/mock.ts';
import type { MockScenario } from '../src/client/session/mock.ts';
import type {
  ClientView, Command, CommandResult, ConnectOptions, SessionPort,
} from '../src/shared/contracts.ts';
import { deriveFit } from '../src/shared/catalog.ts';
import { createShellRuntime, stateMirror, type ShellRuntime } from '../src/ui/shell.ts';
import type { AudioPort, FrameClock, HostSetup, RuntimeOptions, SettingsPort, Surface } from '../src/ui/ports.ts';
import type { FocusSnapshot } from '../src/ui/ports.ts';
import { paginate, rowsPerPage } from '../src/ui/pagination.ts';
import { hudModel, hudMarkup, hudFieldMarkup, HUD_INTERVAL_MS } from '../src/ui/hud.ts';
import { encodeQr, qrCodewords, blockSyndromes, qrSvg } from '../src/ui/qr.ts';
import { normalizeAddress } from '../src/ui/address.ts';
import { parseFields } from '../src/ui/dom.ts';
import { fitComparison } from '../src/ui/format.ts';

const OPTIONS: ConnectOptions = { transport: 'lan', address: '127.0.0.1:8080', pilotName: 'Ace' };
const READY_ASSETS = [{ id: 'belt', label: 'Belt geometry', state: 'ready' as const }];
const PENDING_ASSETS = [{ id: 'belt', label: 'Belt geometry', state: 'pending' as const, progress: 0.4 }];

interface Control {
  readonly action: string;
  readonly data: Record<string, string>;
}

/** Reads every rendered control with its payload, straight out of the markup. */
function parseControls(markup: string): readonly Control[] {
  const controls: Control[] = [];
  for (const match of markup.matchAll(/<button\b[^>]*>/g)) {
    const tag = match[0];
    // A disabled control cannot be pressed in a browser, so it is not required to resolve.
    if (/\sdisabled(?:[=\s>])/.test(tag)) continue;
    const action = /data-action="([^"]+)"/.exec(tag);
    if (!action) continue;
    const data: Record<string, string> = {};
    for (const attribute of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      if (attribute[1] !== 'action') data[attribute[1]!] = attribute[2]!;
    }
    controls.push({ action: action[1]!, data });
  }
  return controls;
}

class RecordingSurface implements Surface {
  markup = '';
  hud = '';
  renderCount = 0;
  hudWrites = 0;
  readonly restored: FocusSnapshot[] = [];
  readonly announcements: string[] = [];
  readonly copied: string[] = [];
  copyOk = true;
  focus: FocusSnapshot | null = null;
  measureResult = { availableHeight: 640, width: 1280 };

  render(markup: string): void {
    this.markup = markup;
    this.renderCount += 1;
  }

  writeHud(markup: string): void {
    this.hud = markup;
    this.hudWrites += 1;
  }

  captureFocus(): FocusSnapshot | null {
    return this.focus;
  }

  restoreFocus(snapshot: FocusSnapshot): void {
    this.restored.push(snapshot);
  }

  announce(message: string): void {
    this.announcements.push(message);
  }

  async copy(text: string): Promise<boolean> {
    this.copied.push(text);
    return this.copyOk;
  }

  title(): void {}

  measure(): { availableHeight: number; width: number } {
    return this.measureResult;
  }
}

class FakeClock implements FrameClock {
  private handles = new Map<number, (timeMs: number) => void>();
  private nextHandle = 1;
  private nowMs = 0;

  requestFrame(callback: (timeMs: number) => void): number {
    const handle = this.nextHandle++;
    this.handles.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.handles.delete(handle);
  }

  now(): number {
    return this.nowMs;
  }

  get pending(): number {
    return this.handles.size;
  }

  /** Runs the currently scheduled frame, exactly as a browser would once per paint. */
  tick(timeMs: number): void {
    this.nowMs = timeMs;
    const callbacks = [...this.handles.values()];
    this.handles.clear();
    for (const callback of callbacks) callback(timeMs);
  }
}

class StubSettings implements SettingsPort {
  value: Record<string, unknown> = {
    version: 3,
    audio: { master: 0.8, muted: false },
    graphics: { quality: 'auto' },
    accessibility: { reducedMotion: false },
    controls: { bindings: { thrust: ['KeyW'] } },
  };
  readonly patches: unknown[] = [];
  readonly resets: string[] = [];

  get(): unknown {
    return this.value;
  }

  subscribe(): () => void {
    return () => {};
  }

  set(patch: unknown): unknown {
    this.patches.push(patch);
    return this.value;
  }

  reset(category: string): unknown {
    this.resets.push(category);
    return this.value;
  }
}

class StubAudio implements AudioPort {
  readonly cues: string[] = [];
  unlocked = 0;
  disposed = 0;

  unlock(): boolean {
    this.unlocked += 1;
    return true;
  }

  setVolume(): void {}
  play(request: { cue: string }): boolean {
    this.cues.push(request.cue);
    return true;
  }
  suspend(): void {}
  dispose(): void {
    this.disposed += 1;
  }
}

interface Harness {
  readonly runtime: ShellRuntime;
  readonly surface: RecordingSurface;
  readonly clock: FakeClock;
  readonly settings: StubSettings;
  readonly audio: StubAudio;
}

interface PortCounts {
  readonly port: SessionPort;
  readonly commands: Command[];
  readonly releases: string[];
  viewSubscriptionCount(): number;
}

function createHarness(session: SessionPort, over: Partial<RuntimeOptions> = {}): Harness {
  const surface = new RecordingSurface();
  const clock = new FakeClock();
  const settings = new StubSettings();
  const audio = new StubAudio();
  const options: RuntimeOptions = {
    session,
    settings,
    audio,
    surface,
    clock,
    assets: READY_ASSETS,
    webgl: { ok: true, detail: null },
    ...over,
  };
  return { runtime: createShellRuntime(options), surface, clock, settings, audio };
}

function countingPort(port: SessionPort): PortCounts {
  const commands: Command[] = [];
  const releases: string[] = [];
  let viewSubscriptions = 0;
  return {
    commands,
    releases,
    viewSubscriptionCount: () => viewSubscriptions,
    port: {
      connect: (options, signal) => port.connect(options, signal),
      view: () => port.view(),
      subscribe: listener => {
        viewSubscriptions += 1;
        const unsubscribe = port.subscribe(listener);
        return () => {
          viewSubscriptions -= 1;
          unsubscribe();
        };
      },
      events: listener => port.events(listener),
      command: async (command: Command, requestId: string): Promise<CommandResult> => {
        commands.push(command);
        return port.command(command, requestId);
      },
      setIntent: intent => port.setIntent(intent),
      releaseControls: reason => {
        releases.push(reason);
        port.releaseControls(reason);
      },
      dispose: () => port.dispose(),
    },
  };
}

/** A port over a fixed view; used for screens the scripted mock does not reach (campaign). */
function stubPort(view: ClientView): PortCounts {
  const commands: Command[] = [];
  const releases: string[] = [];
  return {
    commands,
    releases,
    viewSubscriptionCount: () => 1,
    port: {
      connect: async () => {},
      view: () => view,
      subscribe: () => () => {},
      events: () => () => {},
      command: async (command, requestId) => {
        commands.push(command);
        return { requestId, ok: true, code: 'ok' };
      },
      setIntent: () => {},
      releaseControls: reason => {
        releases.push(reason);
      },
      dispose: async () => {},
    },
  };
}

async function connected(scenario: MockScenario): Promise<MockSession> {
  const session = new MockSession(scenario);
  await session.connect(OPTIONS, new AbortController().signal);
  return session;
}

function campaignView(base: ClientView): ClientView {
  return {
    ...base,
    phase: null,
    screenHint: 'title',
    link: 'idle',
    campaign: {
      id: 'campaign-1',
      name: 'The quiet signal',
      credits: 240,
      inventoryRevision: 4,
      inventory: [{ instanceId: 'inst-1', partId: 'gun-rail', health: 0.7, reservedByPilotId: null }],
      missions: [
        { id: 'mission-1', title: 'Listening stone', sectorId: 'witness', state: 'complete' },
        { id: 'mission-2', title: 'Cold relay', sectorId: 'witness', state: 'available' },
        { id: 'mission-3', title: 'The far wake', sectorId: 'outward', state: 'locked' },
      ],
      decisions: [{ id: 'decision-1', optionId: 'listen' }],
      activeVote: null,
      saveOwner: 'host',
      lastSavedAt: '2026-09-10T09:00:00Z',
    },
  };
}

/** Every screen, with the real path a pilot takes to reach it. */
async function setupFor(screen: string): Promise<Harness> {
  switch (screen) {
    case 'boot':
      return createHarness(new MockSession(emptyLobbyScenario()), { assets: PENDING_ASSETS });
    case 'title':
      return createHarness(new MockSession(emptyLobbyScenario()));
    case 'host': {
      const harness = createHarness(new MockSession(emptyLobbyScenario()), { host: hostSetup() });
      harness.runtime.dispatch({ id: 'title.host' });
      return harness;
    }
    case 'join': {
      const harness = createHarness(new MockSession(emptyLobbyScenario()));
      harness.runtime.dispatch({ id: 'title.join' });
      return harness;
    }
    case 'campaign': {
      const harness = createHarness(stubPort(campaignView(new MockSession(emptyLobbyScenario()).view())).port);
      harness.runtime.dispatch({ id: 'title.resume' });
      return harness;
    }
    case 'lobby':
      return createHarness(await connected(emptyLobbyScenario()));
    case 'hangar': {
      const harness = createHarness(await connected(emptyLobbyScenario()));
      harness.runtime.dispatch({ id: 'lobby.hangar' });
      return harness;
    }
    case 'flight':
      return createHarness(await connected(aliveScenario()));
    case 'debrief':
      return createHarness(await connected(secondMatchScenario()));
    default:
      throw new Error(`no setup for ${screen}`);
  }
}

function hostSetup(): HostSetup {
  return {
    launcher: 'running',
    launcherDetail: null,
    adapter: 'lan',
    port: 8080,
    guestOrigin: 'http://192.168.1.24:8080',
    roomCode: '7QX4',
    joinPolicy: 'code',
    mode: 'campaign',
    isOperator: true,
    canStop: true,
  };
}

describe('every screen is reachable and every control resolves', () => {
  const screens = ['boot', 'title', 'host', 'join', 'campaign', 'lobby', 'hangar', 'flight', 'debrief'];

  test('each screen is produced by its real path', async () => {
    for (const screen of screens) {
      const harness = await setupFor(screen);
      // The state mirror is what browser tests read; assert both it and the visible screen root.
      expect(harness.surface.markup).toContain(`data-screen="${screen}"`);
      expect(stateMirror(harness.runtime.state, harness.runtime.context())).toContain(`data-screen="${screen}"`);
      await harness.runtime.dispose();
    }
  });

  test('every rendered control resolves to a transition', async () => {
    for (const screen of screens) {
      const source = await setupFor(screen);
      const controls = parseControls(source.surface.markup);
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        const harness = await setupFor(screen);
        const before = harness.runtime.state;
        const transition = harness.runtime.dispatch({ id: control.action, data: control.data });
        const unknown = transition.effects.filter(effect => effect.kind === 'unknown-action');
        expect(`${screen}:${control.action}:${unknown.length}`).toBe(`${screen}:${control.action}:0`);
        // A real transition either moves the state or asks the shell to do something.
        const changed = JSON.stringify(before) !== JSON.stringify(transition.state);
        // A real transition either moves the state or asks the shell to do something.
        expect(`${screen}:${control.action}:${changed || transition.effects.length > 0}`).toBe(`${screen}:${control.action}:true`);
        await harness.runtime.dispose();
      }
      await source.runtime.dispose();
    }
  });

  test('the lobby start action moves a live match onto the flight screen', async () => {
    const session = await connected(emptyLobbyScenario());
    const harness = createHarness(session);
    const lobby = session.view().lobby!;
    expect(harness.runtime.state.screen).toBe('lobby');

    harness.runtime.dispatch({ id: 'lobby.ready', data: { pilot: 'pilot-1' } });
    await harness.runtime.settle();
    harness.runtime.dispatch({ id: 'lobby.start', data: {} });
    await harness.runtime.settle();

    expect(session.view().phase).toBe('loading');
    expect(harness.runtime.state.screen).toBe('flight');
    expect(harness.surface.markup).toContain('data-screen="flight"');
    await harness.runtime.dispose();
  });

  test('authority phases pick the base screen without a connect', async () => {
    // A fresh session is not connected: the title menu must not be pulled into a lobby.
    const harness = createHarness(new MockSession(emptyLobbyScenario()));
    expect(harness.runtime.state.screen).toBe('title');
    expect(harness.runtime.view.link).toBe('idle');
  });

  test('the capture flow walks boot -> title -> join -> host -> title', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()), { assets: PENDING_ASSETS, host: hostSetup() });
    expect(harness.runtime.state.screen).toBe('boot');
    harness.runtime.dispatch({ id: 'boot.continue' });
    expect(harness.runtime.state.screen).toBe('title');
    harness.runtime.dispatch({ id: 'title.join' });
    expect(harness.runtime.state.screen).toBe('join');
    harness.runtime.dispatch({ id: 'join.back' });
    expect(harness.runtime.state.screen).toBe('title');
    harness.runtime.dispatch({ id: 'title.host' });
    expect(harness.runtime.state.screen).toBe('host');
    harness.runtime.dispatch({ id: 'host.back' });
    expect(harness.runtime.state.screen).toBe('title');
  });
});

describe('session scope lifecycle', () => {
  test('an overlay over a live match leaves the phase alone and releases controls', async () => {
    const session = await connected(aliveScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);

    expect(harness.runtime.state.screen).toBe('flight');
    const phaseBefore = session.view().phase;
    harness.runtime.dispatch({ id: 'overlay.menu' });

    expect(harness.runtime.state.overlay).toBe('menu');
    expect(session.view().phase).toBe(phaseBefore);
    expect(harness.runtime.state.screen).toBe('flight');
    expect(counts.releases).toContain('overlay');
    // The match is still running: the telemetry loop stays scheduled.
    expect(harness.runtime.frameLoopRunning).toBe(true);
    await harness.runtime.dispose();
  });

  test('escape closes exactly one layer', async () => {
    const harness = createHarness(await connected(aliveScenario()));
    harness.runtime.dispatch({ id: 'overlay.menu' });
    harness.runtime.dispatch({ id: 'overlay.settings' });
    expect(harness.runtime.state.overlay).toBe('settings');
    harness.runtime.escape();
    expect(harness.runtime.state.overlay).toBe('menu');
    harness.runtime.escape();
    expect(harness.runtime.state.overlay).toBe('none');
  });

  test('a second match leaves one subscription and one frame loop live', async () => {
    const session = await connected(secondMatchScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    const firstEpoch = session.view().epoch;

    expect(counts.viewSubscriptionCount()).toBe(1);
    expect(harness.runtime.scope.stats().eventSubscriptions).toBe(1);

    // Captain continues: settlement returns to the lobby, then a new match begins.
    harness.runtime.dispatch({ id: 'debrief.continue', data: {} });
    await harness.runtime.settle();
    expect(session.view().phase).toBe('lobby');
    expect(harness.runtime.state.screen).toBe('lobby');

    const lobby = session.view().lobby!;
    await session.command({ kind: 'ready', expectedRevision: lobby.revision, ready: true }, 'ready-2');
    await session.command({ kind: 'start', expectedRevision: lobby.revision }, 'start-2');
    expect(session.view().epoch).not.toBe(firstEpoch);

    const stats = harness.runtime.scope.stats();
    expect(counts.viewSubscriptionCount()).toBe(1);
    expect(stats.eventSubscriptions).toBe(1);
    expect(stats.frames).toBeLessThanOrEqual(1);
    await harness.runtime.dispose();
  });

  test('a stalled link releases controls and a resumed epoch keeps one subscription', async () => {
    const session = await connected(packetStallScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);

    session.advance(500);
    expect(counts.releases).toContain('disconnect');
    session.advance(2_000);
    expect(counts.viewSubscriptionCount()).toBe(1);
    expect(harness.runtime.scope.stats().eventSubscriptions).toBe(1);
    await harness.runtime.dispose();
  });

  test('life changes release controls', async () => {
    const session = await connected(aliveScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    session.advance(100);
    await harness.runtime.settle();
    counts.releases.length = 0;

    await session.command({ kind: 'request-respawn' }, 'noop');
    session.advance(0);
    await harness.runtime.settle();
    // The ship is alive, so the authority refuses; nothing may be released by a refused command.
    expect(counts.releases).toEqual([]);
    await harness.runtime.dispose();
  });

  test('dispose twice is safe and stops every writer', async () => {
    const session = await connected(aliveScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);

    harness.clock.tick(0);
    const flushesBefore = harness.runtime.hudFlushes;
    await harness.runtime.dispose();
    await harness.runtime.dispose();

    expect(harness.runtime.scope.stats().teardowns).toBe(1);
    expect(harness.runtime.scope.stats().disposed).toBe(true);
    expect(counts.viewSubscriptionCount()).toBe(0);
    expect(harness.runtime.scope.stats().frames).toBe(0);

    harness.runtime.frame(500);
    harness.runtime.dispatch({ id: 'overlay.menu' });
    expect(harness.runtime.hudFlushes).toBe(flushesBefore);
    expect(harness.runtime.state.overlay).toBe('none');
  });
});

describe('lobby drafts and fits', () => {
  test('a stale roster update never clobbers an in-progress name draft', async () => {
    const session = await connected(captainTransferScenario());
    const harness = createHarness(session);

    harness.runtime.dispatch({ id: 'lobby.rename', data: { pilot: 'pilot-1' } });
    harness.runtime.editField('lobby-name-pilot-1', 'Nova');
    expect(harness.runtime.state.drafts.name?.value).toBe('Nova');

    // A captain edit rewrites the roster and bumps the revision while the draft is open.
    await session.command({ kind: 'edit-lobby', expectedRevision: session.view().lobby!.revision, patch: { mapId: 'relay' } }, 'edit-1');
    session.advance(0);

    expect(harness.runtime.state.drafts.name?.value).toBe('Nova');
    expect(harness.runtime.state.drafts.name?.dirty).toBe(true);
    expect(harness.surface.markup).toContain('value="Nova"');
    // A field never loses its stable focus key across a roster update.
    expect(parseFields(harness.surface.markup)).toContain('lobby-name-pilot-1');
    await harness.runtime.dispose();
  });

  test('committing a name sends one set-pilot command with the current revision', async () => {
    const session = await connected(captainTransferScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);

    harness.runtime.dispatch({ id: 'lobby.rename', data: { pilot: 'pilot-1' } });
    harness.runtime.editField('lobby-name-pilot-1', 'Nova');
    const revisionBefore = session.view().lobby!.revision;
    harness.runtime.commitName('pilot-1');
    await harness.runtime.settle();

    const command = counts.commands.find(candidate => candidate.kind === 'set-pilot');
    expect(command?.kind).toBe('set-pilot');
    if (command?.kind === 'set-pilot') {
      expect(command.name).toBe('Nova');
      expect(command.expectedRevision).toBe(revisionBefore);
    }
    await harness.runtime.dispose();
  });

  test('a rejected fit keeps the previous build and the draft', async () => {
    const session = await connected(invalidFitScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    harness.runtime.dispatch({ id: 'lobby.hangar' });
    expect(harness.runtime.state.screen).toBe('hangar');

    const owned = session.view().lobby!.roster.find(entry => entry.pilotId === 'pilot-1')!.fit;
    expect(deriveFit(owned).valid).toBe(true);

    // Clear the reactor: a legal-looking edit that the authority must reject.
    harness.runtime.dispatch({ id: 'hangar.clear-slot', data: { slot: 'r1' } });
    const draft = harness.runtime.state.drafts.fit!;
    expect(deriveFit(draft).valid).toBe(false);

    harness.runtime.dispatch({ id: 'hangar.commit', data: { revision: String(session.view().lobby!.revision) } });
    await harness.runtime.settle();

    const after = session.view().lobby!.roster.find(entry => entry.pilotId === 'pilot-1')!.fit;
    expect(after.slots.r1).toBe(owned.slots.r1);
    expect(deriveFit(after).valid).toBe(true);
    // The draft survives with its rejection visible.
    expect(harness.runtime.state.drafts.fit?.slots.r1).toBeUndefined();
    expect(harness.runtime.state.drafts.fitRejection).not.toBeNull();
    // The authority's own reason is visible; nothing was silently repaired.
    expect(harness.surface.markup).toContain('missing-reactor');
    await harness.runtime.dispose();
  });

  test('a legal fit commits and clears the draft', async () => {
    const session = await connected(invalidFitScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    harness.runtime.dispatch({ id: 'lobby.hangar' });

    harness.runtime.dispatch({ id: 'hangar.fit-part', data: { slot: 'r1', part: 'reactor-standard' } });
    harness.runtime.dispatch({ id: 'hangar.commit', data: {} });
    await harness.runtime.settle();

    expect(counts.commands.some(command => command.kind === 'set-pilot')).toBe(true);
    expect(harness.runtime.state.drafts.fit).toBeNull();
    await harness.runtime.dispose();
  });

  test('readiness follows the revision and blockers are exact', async () => {
    const session = await connected(emptyLobbyScenario());
    const harness = createHarness(session);
    expect(harness.surface.markup).toContain('Waiting for');

    harness.runtime.dispatch({ id: 'lobby.ready', data: { pilot: 'pilot-1' } });
    await harness.runtime.settle();
    expect(session.view().lobby!.canStart).toBe(true);

    // A captain edit revokes readiness visibly.
    await session.command({ kind: 'edit-lobby', expectedRevision: session.view().lobby!.revision, patch: { mode: 'team-deathmatch' } }, 'edit-2');
    session.advance(0);
    expect(session.view().lobby!.canStart).toBe(false);
    expect(harness.surface.markup).toContain('Waiting for');
    await harness.runtime.dispose();
  });

  test('phone lobby tabs and pagination show four seats a page', async () => {
    const session = await connected(fullLobbyScenario());
    const harness = createHarness(session);
    harness.surface.measureResult = { availableHeight: 500, width: 390 };
    harness.runtime.render();

    const state = paginate({ availableHeight: 500, fixedPx: 220, maxRows: 4 }, 8, 0, 0);
    expect(state.perPage).toBe(4);
    expect(state.pages).toBe(2);
    expect(harness.surface.markup).toContain('Page 1 of 2');
    expect(harness.surface.markup).toContain('data-action="lobby.page-next"');
    await harness.runtime.dispose();
  });
});

describe('pagination follows measured height', () => {
  test('page count recomputes from the available height', () => {
    const tall = paginate({ availableHeight: 600, fixedPx: 200, rowPx: 48 }, 8, 0, 0);
    expect(tall.perPage).toBe(8);
    expect(tall.pages).toBe(1);

    const short = paginate({ availableHeight: 300, fixedPx: 200, rowPx: 48 }, 8, 0, 0);
    expect(short.perPage).toBe(2);
    expect(short.pages).toBe(4);

    // Tiny viewports still get a readable row: the count drops, the row size never does.
    const tiny = paginate({ availableHeight: 60, fixedPx: 40, rowPx: 20 }, 8, 0, 0);
    expect(tiny.perPage).toBe(1);
    expect(tiny.rowPx).toBe(44);
  });

  test('re-pagination preserves the selected row', () => {
    const before = paginate({ availableHeight: 600, fixedPx: 200, rowPx: 48 }, 8, 5, 0);
    expect(before.page).toBe(0);

    // The window shrinks: row five moves to page two, and the view follows it.
    const after = paginate({ availableHeight: 300, fixedPx: 200, rowPx: 48 }, 8, 5, 0);
    expect(after.perPage).toBe(2);
    expect(after.page).toBe(2);
    expect(after.firstRow).toBeLessThanOrEqual(5);
    expect(after.lastRow).toBeGreaterThan(5);
  });

  test('a declared row ceiling keeps three parts on desktop and two on a phone', () => {
    expect(rowsPerPage({ availableHeight: 2000, fixedPx: 0, rowPx: 72, maxRows: 3 })).toBe(3);
    expect(rowsPerPage({ availableHeight: 2000, fixedPx: 0, rowPx: 72, maxRows: 2 })).toBe(2);
  });
});

describe('flight HUD', () => {
  test('telemetry never exceeds ten updates a second', async () => {
    const session = await connected(aliveScenario());
    const harness = createHarness(session);
    const before = harness.runtime.hudFlushes;

    // A 30 Hz caller across one second, with the view advancing: the DOM changes ten times at
    // most, never thirty.
    for (let frame = 1; frame <= 30; frame++) {
      session.advance(1000 / 30);
      harness.runtime.frame(frame * (1000 / 30));
    }
    const flushes = harness.runtime.hudFlushes - before;
    expect(flushes).toBeGreaterThan(0);
    expect(flushes).toBeLessThanOrEqual(10);
    expect(HUD_INTERVAL_MS).toBe(100);

    // Two calls inside one interval write at most once, and a changed view is what triggers it.
    const mark = harness.runtime.hudFlushes;
    session.advance(50);
    harness.runtime.frame(20_000);
    harness.runtime.frame(20_050);
    expect(harness.runtime.hudFlushes - mark).toBe(1);

    // An unchanged view writes nothing at all.
    const steady = harness.runtime.hudFlushes;
    harness.runtime.frame(20_400);
    harness.runtime.frame(20_500);
    expect(harness.runtime.hudFlushes - steady).toBe(0);
    await harness.runtime.dispose();
  });

  test('the HUD stops updating while disposed', async () => {
    const session = await connected(aliveScenario());
    const harness = createHarness(session);
    harness.runtime.frame(0);
    const flushes = harness.runtime.hudFlushes;
    expect(flushes).toBeGreaterThan(0);

    await harness.runtime.dispose();
    session.advance(3_000);
    harness.runtime.frame(1_000);
    harness.runtime.frame(5_000);
    expect(harness.runtime.hudFlushes).toBe(flushes);
    expect(harness.runtime.scope.stats().frames).toBe(0);
  });

  test('only the HUD region changes on a telemetry flush', async () => {
    const session = await connected(aliveScenario());
    const harness = createHarness(session);
    const renders = harness.surface.renderCount;
    harness.runtime.frame(0);
    harness.runtime.frame(200);
    expect(harness.surface.hudWrites).toBeGreaterThan(0);
    expect(harness.surface.renderCount).toBe(renders);
    await harness.runtime.dispose();
  });

  test('fitted maxima come from the shared derivation', async () => {
    const session = await connected(aliveScenario());
    const view = session.view();
    const model = hudModel(view)!;
    const derived = deriveFit(view.self!.ship.fit);
    expect(model.hull.value).toContain(String(derived.hullMax));
    expect(model.propellant.value).toContain('t');
    expect(model.weapons.length).toBe(derived.weaponSlots.length);
  });

  test('the central field holds only reticle, lead, threat arrows and prompts', async () => {
    const session = await connected(aliveScenario());
    const model = hudModel(session.view())!;
    const field = hudFieldMarkup(model);
    const cues = [...field.matchAll(/data-cue="([^"]+)"/g)].map(match => match[1]!);
    for (const cue of cues) expect(['reticle', 'lead', 'threat-arrow', 'prompt', 'boundary-arrow', 'boundary']).toContain(cue);
    expect(field).not.toContain('hud-instruments');
    expect(field).not.toContain('radar');
  });

  test('radar draws contacts from the view, with age and uncertainty', async () => {
    const session = await connected(aliveScenario());
    const base = session.view();
    const view: ClientView = {
      ...base,
      contacts: [
        { id: 'c1', kind: 'hostile', position: { x: 400, y: 400 }, uncertaintyM: 120, ageTicks: 30, targetable: true },
        { id: 'c2', kind: 'unknown', position: { x: -200, y: 100 }, uncertaintyM: 900, ageTicks: 90, targetable: false },
      ],
    };
    const model = hudModel(view)!;
    const markup = hudMarkup(model);
    expect(model.radar?.contacts).toHaveLength(2);
    expect(markup).toContain('data-contact="c1"');
    expect(markup).toContain('data-uncertainty="\u00b1120\u2009m"');
    expect(markup).toContain('data-age="1.0\u2009s ago"');

    // A view with no contacts can never show an enemy.
    const empty = hudModel({ ...base, contacts: [] })!;
    expect(empty.radar?.contacts).toEqual([]);
    expect(hudMarkup(empty)).not.toContain('data-contact=');
  });

  test('a healthy link shows only a quality mark', async () => {
    const session = await connected(aliveScenario());
    const model = hudModel(session.view())!;
    expect(model.link.notice).toBeNull();
    const markup = hudMarkup(model);
    expect(markup).toContain('hud-quality');
    expect(markup).not.toContain('Reconnecting');
  });

  test('a boundary shows direction and the fifteen second countdown', async () => {
    const session = await connected(aliveScenario());
    const base = session.view();
    const view: ClientView = {
      ...base,
      self: { ...base.self!, predictionState: { ...base.self!.predictionState, position: { x: 0, y: 5_800 } } },
    };
    const model = hudModel(view)!;
    expect(model.boundary?.secondsLeft).toBe(15);
    expect(model.field.some(cue => cue.kind === 'boundary-arrow')).toBe(true);
    expect(hudFieldMarkup(model)).toContain('to boundary');
  });

  test('a destroyed ship reports no false hull and keeps the redeploy control', async () => {
    const session = await connected(deadScenario());
    const harness = createHarness(session);
    expect(harness.surface.markup).toContain('data-action="flight.respawn"');
    expect(hudModel(session.view())!.hull.value.startsWith('0')).toBe(true);
    await harness.runtime.dispose();
  });
});

describe('host, join and settings surfaces', () => {
  test('the host screen explains a missing launcher instead of pretending to start it', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()), {
      host: { ...hostSetup(), launcher: 'absent', guestOrigin: 'http://192.168.1.24:8080' },
    });
    harness.runtime.dispatch({ id: 'title.host' });
    const markup = harness.surface.markup;
    expect(markup).toContain('cannot start a Windows process');
    expect(markup).toContain('data-action="host.start"');
    expect(markup).toContain('Launcher process not detected');
  });

  test('the join screen normalises the address and never rewrites it to localhost', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()));
    harness.runtime.dispatch({ id: 'title.join' });
    harness.runtime.editField('join-name', 'Ace');
    harness.runtime.editField('join-address', 'http://192.168.1.24/');
    harness.runtime.render();
    expect(harness.surface.markup).toContain('Connects to 192.168.1.24:8080');
    expect(normalizeAddress('http://192.168.1.24/')).toBe('192.168.1.24:8080');
    expect(normalizeAddress('   ')).toBeNull();
    expect(normalizeAddress('10.0.0.5:99999')).toBeNull();
  });

  test('a copy failure selects the address and says so', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()), { host: hostSetup() });
    harness.surface.copyOk = false;
    harness.runtime.dispatch({ id: 'title.host' });
    harness.runtime.dispatch({ id: 'host.copy-link' });
    await harness.runtime.settle();
    expect(harness.surface.copied).toContain('http://192.168.1.24:8080');
    expect(harness.surface.markup).toContain('Select and copy this address');
    expect(harness.runtime.state.copyFailed).toBe(true);
  });

  test('host stop asks for confirmation before acting', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()), { host: hostSetup() });
    harness.runtime.dispatch({ id: 'title.host' });
    const transition = harness.runtime.dispatch({ id: 'host.stop' });
    expect(transition.state.confirm?.id).toBe('host.stop');
    expect(transition.effects).toHaveLength(0);
    harness.runtime.dispatch({ id: 'confirm.accept', data: { confirmed: 'true' } });
    expect(harness.runtime.lastEffects).toContainEqual({ kind: 'host', action: 'stop' });
  });

  test('settings pages are separate and reset one category at a time', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()));
    harness.runtime.dispatch({ id: 'title.settings' });
    expect(harness.runtime.state.overlay).toBe('settings');
    expect(harness.surface.markup).toContain('data-page="flight"');
    harness.runtime.dispatch({ id: 'settings.page-audio' });
    expect(harness.surface.markup).toContain('data-page="audio"');
    harness.runtime.dispatch({ id: 'settings.reset', data: { category: 'audio' } });
    expect(harness.settings.resets).toEqual(['audio']);
    harness.runtime.dispatch({ id: 'settings.toggle', data: { key: 'audio.muted' } });
    expect(harness.settings.patches).toEqual([{ audio: { muted: true } }]);
  });

  test('help is paged lessons, not one scroll', async () => {
    const harness = createHarness(new MockSession(emptyLobbyScenario()));
    harness.runtime.dispatch({ id: 'title.help' });
    expect(harness.runtime.state.overlay).toBe('help');
    harness.runtime.dispatch({ id: 'help.page-touch' });
    expect(harness.surface.markup).toContain('data-page="touch"');
    harness.runtime.dispatch({ id: 'help.close' });
    expect(harness.runtime.state.overlay).toBe('none');
  });
});

describe('campaign and debrief', () => {
  test('campaign labels locked, complete and current missions with training replays', async () => {
    const harness = await setupFor('campaign');
    harness.runtime.dispatch({ id: 'campaign.mission', data: { mission: 'mission-1' } });
    const markup = harness.surface.markup;
    expect(markup).toContain('data-state="locked"');
    expect(markup).toContain('data-state="complete"');
    expect(markup).toContain('data-state="available"');
    expect(markup).toContain('Training replay');
    await harness.runtime.dispose();
  });

  test('a failed save offers retry and export, and a retry sends a recovery command', async () => {
    const session = await connected(settlementFailedScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    session.advance(2_500);
    await harness.runtime.settle();
    expect(session.view().save).toBe('failed');

    harness.runtime.dispatch({ id: 'debrief.retry-save', data: {} });
    await harness.runtime.settle();
    expect(counts.commands.some(command => command.kind === 'recovery')).toBe(true);
    expect(harness.runtime.state.screen).toBe('debrief');
    await harness.runtime.dispose();
  });

  test('a pending save is not shown as saved', async () => {
    const session = await connected(settlementPendingScenario());
    const harness = createHarness(session);
    session.advance(1_000);
    await harness.runtime.settle();
    expect(harness.surface.markup).toContain('Saving');
    session.advance(1_500);
    await harness.runtime.settle();
    expect(harness.surface.markup).toContain('Saved on');
    await harness.runtime.dispose();
  });

  test('a guest sees a waiting note and the host-owned save', async () => {
    const session = await connected(secondMatchScenario());
    const lobbySession = await connected(emptyLobbyScenario());
    const guest: ClientView = {
      ...session.view(),
      lobby: { ...lobbySession.view().lobby!, captainId: 'pilot-2' },
    };
    const harness = createHarness(stubPort(guest).port);
    expect(harness.surface.markup).toContain('Waiting for the captain');
    expect(harness.surface.markup).toContain('Saved on host PC');
    await harness.runtime.dispose();
  });

  test('settlement shows the save receipt before a result is published', async () => {
    const session = await connected(scoreTieScenario());
    const harness = createHarness(session);
    session.advance(5_000);
    await harness.runtime.settle();
    expect(harness.runtime.state.screen).toBe('debrief');
    const markup = harness.surface.markup;
    expect(markup).toContain('data-settlement="true"');
    expect(markup).toContain('data-save="clean"');
    expect(markup).not.toContain('Victory');
    await harness.runtime.dispose();
  });
});

describe('pre-release surfaces', () => {
  test('the boot screen has no silent connect', async () => {
    const session = new MockSession(emptyLobbyScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port, { assets: PENDING_ASSETS });
    expect(harness.runtime.state.screen).toBe('boot');
    session.advance(5_000);
    harness.clock.tick(0);
    expect(counts.commands).toEqual([]);
    expect(session.view().link).toBe('idle');
    await harness.runtime.dispose();
  });

  test('a retry after a loading failure stays on the join flow with a typed error', async () => {
    const session = new MockSession(loadingFailureScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    harness.runtime.dispatch({ id: 'title.join' });
    harness.runtime.editField('join-name', 'Ace');
    harness.runtime.editField('join-address', '192.168.1.24');
    harness.runtime.dispatch({ id: 'join.connect', data: {} });
    await harness.runtime.settle();

    expect(harness.runtime.state.joinError?.code).toBe('timeout');
    expect(harness.runtime.state.screen).toBe('join');
    expect(harness.surface.markup).toContain('No answer from that address');
    expect(harness.surface.markup).toContain('data-action="join.retry"');

    // The failure is one-shot: the second attempt reaches the lobby.
    harness.runtime.dispatch({ id: 'join.retry', data: {} });
    await harness.runtime.settle();
    expect(harness.runtime.state.screen).toBe('lobby');
    await harness.runtime.dispose();
  });

  test('a connect creates the adapter through the factory only when asked', async () => {
    const created: string[] = [];
    const session = new MockSession(emptyLobbyScenario());
    const harness = createHarness(session, {
      createSession: kind => {
        created.push(kind);
        return session;
      },
    });
    expect(created).toEqual([]);
    harness.runtime.dispatch({ id: 'title.offline' });
    await harness.runtime.settle();
    expect(created).toEqual(['local']);
    await harness.runtime.dispose();
  });

  test('the QR is a real symbol of the join link', () => {
    const link = 'http://192.168.1.24:8080/?code=7QX4';
    const code = encodeQr(link);
    expect(code.version).toBeGreaterThanOrEqual(2);
    expect(code.matrix).toHaveLength(code.size);
    // Reed-Solomon blocks must be valid codewords.
    const codewords = qrCodewords(link);
    expect(codewords.length).toBeGreaterThan(0);
    const ecPerBlock = [7, 10, 15, 20, 26, 18, 20, 24, 30][code.version - 1]!;
    const blockSizes = [[19], [34], [55], [80], [108], [68, 68], [78, 78], [97, 97], [116, 116]][code.version - 1]!;
    const single: number[] = [];
    const totalData = blockSizes.reduce((sum, size) => sum + size, 0);
    const perBlock = totalData / blockSizes.length;
    const dataBlocks = blockSizes.map((_, index) => codewords.slice(index * perBlock, (index + 1) * perBlock));
    // Interleaved payloads are reassembled in the same order the encoder emitted them.
    const deinterleaved = blockSizes.map(() => [] as number[]);
    let cursor = 0;
    for (let index = 0; index < perBlock; index++) {
      for (let block = 0; block < blockSizes.length; block++) deinterleaved[block]!.push(codewords[cursor++]!);
    }
    const ecBlocks: number[][] = blockSizes.map(() => []);
    for (let index = 0; index < ecPerBlock; index++) {
      for (let block = 0; block < blockSizes.length; block++) ecBlocks[block]!.push(codewords[cursor++]!);
    }
    for (let block = 0; block < blockSizes.length; block++) {
      single.push(...dataBlocks[block]!.slice(0, 1));
      const syndromes = blockSyndromes([...deinterleaved[block]!, ...ecBlocks[block]!], ecPerBlock);
      expect(syndromes.every(value => value === 0)).toBe(true);
    }
    // Finder patterns and the always-dark module make it a scannable symbol, not a square.
    expect(code.matrix[0]![0]).toBe(true);
    expect(code.matrix[1]![1]).toBe(false);
    expect(code.matrix[2]![2]).toBe(true);
    expect(code.matrix[code.size - 8]![8]).toBe(true);
    const svg = qrSvg(link);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('<rect');
  });

  test('overlong QR payloads throw instead of truncating', () => {
    expect(() => encodeQr('A'.repeat(231))).toThrow();
  });

  test('address normalisation is explicit about what it rejects', () => {
    expect(normalizeAddress('192.168.1.24')).toBe('192.168.1.24:8080');
    expect(normalizeAddress('host.local:9000')).toBe('host.local:9000');
    expect(normalizeAddress('http://host:8080/deep/path?x=1')).toBe('host:8080');
    expect(normalizeAddress('bad host')).toBeNull();
  });

  test('fit comparison shows before and after from the shared derivation', async () => {
    const session = await connected(aliveScenario());
    const fit = session.view().self!.ship.fit;
    const heavy = { ...fit, slots: { ...fit.slots, a1: 'armor-plate' } };
    const current = deriveFit(fit);
    const proposed = deriveFit(heavy);
    const rows = fitComparison(current, proposed);
    expect(rows.length).toBeGreaterThan(4);
    const mass = rows.find(row => row.label === 'Mass')!;
    expect(mass.before).toContain('t');
    expect(mass.after).toContain('t');
    await session.dispose();
  });

  test('player text reaches the DOM as text, never as markup', async () => {
    const session = await connected(captainTransferScenario());
    const harness = createHarness(session);
    harness.runtime.dispatch({ id: 'lobby.rename', data: { pilot: 'pilot-1' } });
    harness.runtime.editField('lobby-name-pilot-1', '<img src=x onerror="boom()">Nick');
    harness.runtime.render();
    expect(harness.surface.markup).not.toContain('<img');
    expect(harness.surface.markup).toContain('&lt;img');
  });

  test('a live match keeps momentum under an overlay: no camera or phase writes exist', async () => {
    const session = await connected(aliveScenario());
    const harness = createHarness(session);
    const before = JSON.stringify(session.view());
    harness.runtime.dispatch({ id: 'overlay.scoreboard' });
    harness.runtime.dispatch({ id: 'hud.radar-toggle' });
    harness.runtime.frame(0);
    expect(JSON.stringify(session.view())).toBe(before);
    await harness.runtime.dispose();
  });

  test('the lobby never sends a stale revision', async () => {
    const session = await connected(emptyLobbyScenario());
    const counts = countingPort(session);
    const harness = createHarness(counts.port);
    const lobby = session.view().lobby!;
    harness.runtime.dispatch({ id: 'lobby.map-relay' });
    await harness.runtime.settle();
    const edit = counts.commands.find(command => command.kind === 'edit-lobby');
    expect(edit && 'expectedRevision' in edit ? edit.expectedRevision : -1).toBe(lobby.revision);
    const stale = await session.command({ kind: 'start', expectedRevision: lobby.revision }, 'stale');
    expect(stale.code).toBe('stale-revision');
    await harness.runtime.dispose();
  });
});
