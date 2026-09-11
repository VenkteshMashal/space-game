/**
 * Shell composition (Plan A1/A2). `createShell` is the browser entry point: it owns the DOM
 * surface, the session scope, the delegated listeners and the render loop. `createShellRuntime` is
 * the same object without a DOM, which is what the tests drive — drafts, overlays, scope counts and
 * the HUD throttle are all observable through it.
 *
 * Authority state is read-only here. The shell routes transitions, executes effects and releases
 * input; it never writes a phase, a life, a fit or a credit.
 */

import type { ClientView, Command, CommandResult, ConnectOptions, SessionEvent, SessionPort } from '../shared/contracts.ts';
import { HudWriter } from './hud.ts';
import type { AudioPort, FrameClock, RuntimeOptions, SettingsPort, Shell, ShellOptions, Surface } from './ports.ts';
import { browserClock } from './ports.ts';
import { SessionScope } from './scope.ts';
import {
  authorityOf, createInitialState, dispatch as route, escapeLayer, ownedFit, patchFor, reconcileDrafts, screenForPhase,
  type Authority, type Effect, type RouterContext, type ShellState, type Transition, type UiAction,
} from './router.ts';
import { confirmMarkup, overlayMarkup, screenMarkup, type Layout } from './views.ts';
import { ensureStyles } from './styles.ts';
import { readSettings } from './screens/settings.ts';
import type { JoinError } from './screens/join.ts';

export const HUD_PHASES: readonly ClientView['phase'][] = ['countdown', 'live', 'extraction', 'settlement'];
/** Screens a successful connect is allowed to leave; nothing else is yanked off its own page. */
export const ENTRY_SCREENS: readonly string[] = ['boot', 'title', 'join', 'host'];

export interface ShellRuntime extends Shell {
  readonly state: ShellState;
  readonly view: ClientView;
  readonly authority: Authority;
  readonly scope: SessionScope;
  readonly surface: Surface;
  readonly lastEffects: readonly Effect[];
  readonly hudFlushes: number;
  /** True while the single telemetry frame loop is scheduled. */
  readonly frameLoopRunning: boolean;
  dispatch(action: UiAction): Transition;
  escape(): Transition;
  render(): void;
  /** One telemetry frame; the browser clock drives this, tests call it directly. */
  frame(nowMs: number): void;
  /** Route a text/range/select edit into the drafts or settings. Does not re-render. */
  editField(fieldId: string, value: string): void;
  /** Commit a dirty callsign draft, as blur or the Save button requires. */
  commitName(pilotId: string): void;
  /** Blur/hidden handling: release captured input without touching authority state. */
  releaseFor(reason: 'blur' | 'hidden' | 'overlay' | 'disconnect' | 'life-change'): void;
  context(): RouterContext;
  /** Resolves when every effect started so far has finished; the deterministic test seam. */
  settle(): Promise<void>;
}

function connectError(error: unknown): JoinError {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : null;
  if (code === 'loading-failed') return { code: 'timeout', message: 'The host did not finish loading the arena in time.' };
  if (code === 'reconnect-failed') return { code: 'refused', message: 'The host refused to resume this seat.' };
  if (code === 'already-connected') return { code: 'refused', message: 'This client is already connected.' };
  return { code: 'refused', message: error instanceof Error ? error.message : 'The connection could not be opened.' };
}

const COMMAND_MESSAGE: Partial<Record<CommandResult['code'], string>> = {
  'stale-revision': 'The lobby changed before that landed. Check the roster and try again.',
  'not-captain': 'Only the captain can do that.',
  'seat-taken': 'That seat was taken.',
  'room-full': 'The room is full.',
  'invalid-fit': 'The authority rejected this build. Your previous fit is unchanged.',
  'join-closed': 'This host is not accepting joins.',
  'bad-code': 'That room code is wrong.',
  'wrong-life': 'Your ship cannot do that right now.',
  'wrong-phase': 'That action is not available in this phase.',
  'rate-limited': 'Slow down, then try again.',
  denied: 'The host denied that action.',
  unsupported: 'The host does not support that action.',
  'already-processed': 'That was already handled.',
};

class DriftShell implements ShellRuntime {
  private readonly options: RuntimeOptions;
  private session: SessionPort;
  readonly scope: SessionScope;
  readonly surface: Surface;
  private readonly clock: FrameClock;
  private readonly audio: AudioPort;
  private readonly settings: SettingsPort;
  private readonly hudWriter: HudWriter;
  private readonly listeners: { view: (view: ClientView) => void; event: (event: SessionEvent) => void };

  private stateValue: ShellState;
  private viewValue: ClientView;
  private authorityValue: Authority;
  private effects: readonly Effect[] = [];
  private pending: Promise<void> = Promise.resolve();
  private loopRunning = false;
  private disposed = false;
  private closing: Promise<void> | null = null;
  private epoch: string | null;
  private lastLife: string | null = null;
  private lastLink: string | null = null;
  private lastPhase: ClientView['phase'] = null;
  private wasOnline = false;
  private lastBlocker: string | null = null;
  private transport: 'lan' | 'local' | null;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.transport = options.transport ?? null;
    this.session = options.session;
    this.surface = options.surface;
    this.clock = options.clock;
    this.audio = options.audio;
    this.settings = options.settings;
    this.scope = new SessionScope(this.session, this.clock);
    this.hudWriter = new HudWriter(markup => this.surface.writeHud(markup));
    this.listeners = { view: view => this.onView(view), event: event => this.onEvent(event) };
    this.viewValue = this.session.view();
    this.stateValue = createInitialState({ recentHosts: options.recentHosts, pilotName: options.pilotName });
    this.authorityValue = authorityOf(this.viewValue, options.transport ?? null);
    this.epoch = this.viewValue.epoch;
    this.lastLife = this.viewValue.self?.ship.life ?? null;
    this.lastLink = this.viewValue.link;
    this.scope.attach(this.session, this.listeners);
    this.followAuthority(this.viewValue);
    this.ensureFrameLoop();
    this.render();
  }

  get state(): ShellState { return this.stateValue; }
  get view(): ClientView { return this.viewValue; }
  get authority(): Authority { return this.authorityValue; }
  get lastEffects(): readonly Effect[] { return this.effects; }
  get hudFlushes(): number { return this.hudWriter.flushCount; }
  get frameLoopRunning(): boolean { return this.loopRunning; }
  get controlsActive(): boolean {
    return this.state.screen === 'flight' && this.state.overlay === 'none' && !this.state.confirm
      && this.view.link === 'online' && this.view.self?.ship.life === 'alive'
      && (this.view.phase === 'live' || this.view.phase === 'extraction');
  }
  get paused(): boolean {
    return this.authority.transport === 'local' && (this.state.overlay !== 'none' || this.state.confirm !== null);
  }

  dispatch(action: UiAction): Transition {
    if (this.disposed) return { state: this.stateValue, effects: [] };
    const transition = route(this.stateValue, action, this.context());
    this.apply(transition);
    return transition;
  }

  escape(): Transition {
    if (this.disposed) return { state: this.stateValue, effects: [] };
    const transition = escapeLayer(this.stateValue, this.context());
    this.apply(transition);
    return transition;
  }

  private apply(transition: Transition): void {
    this.stateValue = transition.state;
    this.effects = transition.effects;
    // Effects start immediately so the session boundary sees them in dispatch order; `settle`
    // only waits for the ones already started.
    const started = transition.effects.map(effect => this.runEffect(effect));
    this.pending = Promise.all(started).then(() => undefined).catch(() => undefined);
    this.render();
  }

  /** Waits for every effect started so far, including work those effects queued in turn. */
  async settle(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      const current = this.pending;
      await current;
      if (current === this.pending) return;
    }
  }

  context(): RouterContext {
    const view = this.viewValue;
    const measured = this.surface.measure();
    const snapshot = this.settings.get();
    const lobby = view.lobby;
    return {
      view,
      authority: this.authorityValue,
      host: this.options.host ?? null,
      savedCampaign: this.options.savedCampaign ?? null,
      webgl: this.options.webgl ?? { ok: true, detail: null },
      assets: this.options.assets ?? [],
      settings: readSettings(snapshot),
      settingsVersion: settingsVersion(snapshot),
      appVersion: this.options.appVersion ?? '1.0.0',
      phone: measured.width <= 800,
      availableHeight: measured.availableHeight,
      overlayMarkup: '',
      progress: null,
      blockers: lobby?.startBlockers ?? [],
      // Only a lobby names a captain; elsewhere the local pilot owns their own view.
      captain: lobby ? lobby.captainId === view.pilotId : true,
      selfPilotId: view.pilotId ?? '',
    };
  }

  render(): void {
    if (this.disposed) return;
    this.settleBoot();
    const focus = this.surface.captureFocus();
    const context = this.context();
    const layout: Layout = { availableHeight: context.availableHeight, phone: context.phone };
    const overlay = overlayMarkup(this.stateValue, context);
    this.surface.render(`${screenMarkup(this.stateValue, context, layout, overlay)}${overlay}${confirmMarkup(this.stateValue)}${stateMirror(this.stateValue, context)}`);
    if (focus) this.surface.restoreFocus(focus);
    this.surface.title(this.stateValue.screen === 'flight' ? 'DRIFT \u00b7 flying' : `DRIFT \u00b7 ${this.stateValue.screen}`);
  }

  frame(nowMs: number): void {
    if (this.disposed) return;
    if (this.hudWriter.update(this.viewValue, nowMs)) this.announceBlocker();
  }

  releaseFor(reason: 'blur' | 'hidden' | 'overlay' | 'disconnect' | 'life-change'): void {
    this.scope.releaseControls(reason);
  }

  get lockedContactId(): string | null {
    return this.stateValue.lockedContactId;
  }

  /**
   * Binding-driven actions from the input router. Nothing here writes authority state: the shell
   * maps a key to a screen, overlay or bounded command, and does nothing at all outside flight.
   */
  action(action: string, phase: 'press' | 'release'): void {
    if (this.disposed || this.stateValue.screen !== 'flight') return;
    switch (action) {
      case 'pause':
      case 'menu':
        if (phase === 'press') this.stateValue.overlay === 'none' ? this.dispatch({ id: 'overlay.menu' }) : this.escape();
        return;
      case 'map':
        if (phase === 'press') this.dispatch({ id: 'overlay.map' });
        return;
      case 'help':
        if (phase === 'press') this.dispatch({ id: 'overlay.help' });
        return;
      case 'scoreboard':
        if (phase === 'press') this.dispatch({ id: 'overlay.scoreboard' });
        else if (this.stateValue.overlay === 'scoreboard') this.escape();
        return;
      case 'interact':
        if (phase === 'press') this.dispatch({ id: 'flight.interact', data: {} });
        return;
      case 'reload':
        if (phase === 'press') this.dispatch({ id: 'flight.reload', data: {} });
        return;
      case 'cinematic':
        if (phase === 'press') this.dispatch({ id: 'flight.cinematic' });
        return;
      case 'respawn':
        if (phase === 'press') this.dispatch({ id: 'flight.respawn' });
        return;
      case 'sensor':
        if (phase === 'press') this.dispatch({ id: 'flight.sensor-mode', data: { mode: 'active' } });
        return;
      default:
        // Thrust, aim, fire and the rest belong to the input router's intent lease.
        return;
    }
  }

  cycleLock(direction: -1 | 1): void {
    if (this.disposed || this.stateValue.screen !== 'flight') return;
    this.dispatch({ id: 'flight.lock-cycle', data: { direction: String(direction) } });
  }

  editField(fieldId: string, value: string): void {
    if (this.disposed) return;
    const drafts = this.stateValue.drafts;
    if (fieldId.startsWith('lobby-name-')) {
      const pilotId = fieldId.slice('lobby-name-'.length);
      this.stateValue = { ...this.stateValue, drafts: { ...drafts, name: { pilotId, value, dirty: true } } };
      return;
    }
    // The join drafts gate the Connect control, so the screen has to reflect them as the pilot
    // types; the surface restores focus and caret across the re-render.
    const joinDraft = fieldId === 'join-name' ? 'joinName' : fieldId === 'join-address' ? 'joinAddress' : fieldId === 'join-code' ? 'joinCode' : null;
    if (joinDraft) {
      this.stateValue = { ...this.stateValue, drafts: { ...drafts, [joinDraft]: value } };
      this.render();
      return;
    }
    if (fieldId.startsWith('setting-')) {
      const key = fieldId.slice('setting-'.length);
      const numeric = Number(value);
      this.settings.set(patchFor(key, Number.isFinite(numeric) && value.trim() !== '' ? numeric : value));
      this.stateValue = { ...this.stateValue, settingsDirty: true };
    }
  }

  commitName(pilotId: string): void {
    const draft = this.stateValue.drafts.name;
    if (!draft || !draft.dirty || draft.pilotId !== pilotId) return;
    this.dispatch({ id: 'lobby.commit-name', data: { pilot: pilotId } });
  }

  private onView(view: ClientView): void {
    if (this.disposed) return;
    this.viewValue = view;
    this.authorityValue = authorityOf(view, this.transport);
    this.resetEpochIfNeeded(view);
    this.releaseOnChange();
    this.followAuthority(view);
    this.stateValue = reconcileDrafts(this.stateValue, view);
    this.ensureFrameLoop();
    this.render();
  }

  /**
   * A phase transition selects the base screen, but only once a link is actually live: the title
   * screen must never be pulled into a lobby by an adapter that has not connected yet. A freshly
   * connected link also leaves the join/title flow, which is the only thing that ends a retry.
   * Local navigation (campaign, hangar, settings) is untouched between phase changes.
   */
  private followAuthority(view: ClientView): void {
    const online = view.link === 'online';
    const established = online || view.link === 'loading' || view.link === 'handshake';
    const enteredFromMenu = online && !this.wasOnline && ENTRY_SCREENS.includes(this.stateValue.screen);
    this.wasOnline = online;
    if (view.phase === this.lastPhase && !enteredFromMenu) return;
    this.lastPhase = view.phase;
    // Only an established link may move the pilot; a failed attempt stays where its error is shown.
    if (!established || view.phase === null) return;
    this.stateValue = { ...this.stateValue, screen: screenForPhase(view.phase, view.screenHint), busy: false };
  }

  /** Boot hands over to the title menu once every asset is present; it never connects. */
  private settleBoot(): void {
    if (this.stateValue.screen !== 'boot') return;
    const context = this.context();
    if (!context.webgl.ok) return;
    if (context.assets.length === 0 || context.assets.some(asset => asset.state !== 'ready')) return;
    this.stateValue = { ...this.stateValue, screen: 'title' };
  }

  private onEvent(event: SessionEvent): void {
    if (this.disposed) return;
    if (event.kind === 'roster') this.stateValue = reconcileDrafts(this.stateValue, this.viewValue);
    this.render();
  }

  /**
   * A new epoch means a new match: the previous subscription set and frame loop are replaced, so
   * exactly one of each stays live after any number of rematches.
   */
  private resetEpochIfNeeded(view: ClientView): void {
    if (view.epoch === this.epoch) return;
    this.epoch = view.epoch;
    this.scope.attach(this.session, this.listeners);
    this.scope.cancelFrames();
    this.loopRunning = false;
  }

  /** Link and life changes release captured controls; a coasting LAN ship is still vulnerable. */
  private releaseOnChange(): void {
    const life = this.viewValue.self?.ship.life ?? null;
    const link = this.viewValue.link;
    if (this.lastLife !== null && life !== this.lastLife && (life === 'destroyed' || life === 'disabled' || life === 'respawning')) {
      this.scope.releaseControls('life-change');
    }
    if (this.lastLink !== null && link !== this.lastLink && (link === 'failed' || link === 'reconnecting')) {
      this.scope.releaseControls('disconnect');
    }
    this.lastLife = life;
    this.lastLink = link;
  }

  private ensureFrameLoop(): void {
    if (this.disposed || this.loopRunning) return;
    const phase = this.viewValue.phase;
    if (!phase || !HUD_PHASES.includes(phase) || !this.viewValue.self) return;
    this.loopRunning = true;
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    this.scope.requestFrame(timeMs => {
      if (this.disposed || !this.loopRunning) return;
      this.frame(timeMs);
      this.scheduleFrame();
    });
  }

  private announceBlocker(): void {
    const first = this.viewValue.lobby?.startBlockers[0] ?? null;
    if (first && first !== this.lastBlocker) this.surface.announce(first);
    this.lastBlocker = first;
  }

  private async runEffect(effect: Effect): Promise<void> {
    switch (effect.kind) {
      case 'command':
        await this.runCommand(effect.command, effect.requestId);
        return;
      case 'connect':
        await this.runConnect(effect.options);
        return;
      case 'cancel-connect':
        this.scope.abortConnect();
        return;
      case 'release':
        this.scope.releaseControls(effect.reason);
        return;
      case 'copy':
        this.copy(effect.text);
        return;
      case 'cue':
        this.audio.play({ cue: effect.name });
        return;
      case 'settings':
        this.settings.set(effect.patch);
        return;
      case 'settings-reset':
        this.settings.reset(effect.category);
        return;
      case 'export':
        this.options.onExport?.('settings');
        return;
      case 'host':
        this.options.hostControl?.(effect.action, effect.data);
        return;
      case 'reload-assets':
        this.options.onReloadAssets?.();
        return;
      case 'end-session':
        this.options.onSessionEnd?.(effect.reason);
        return;
      default:
        return;
    }
  }

  private async runConnect(options: ConnectOptions): Promise<void> {
    this.transport = options.transport;
    // A factory defers adapter construction until the pilot actually asks for it. Anything that
    // throws in here — the factory itself, an attach, or an adapter that cannot answer `view()`
    // before it is connected — is reported as a typed failure rather than leaving the pilot with a
    // control that spins forever.
    if (this.options.createSession) {
      try {
        const created = this.options.createSession(options.transport);
        const previous = this.session;
        if (previous !== created) {
          this.scope.abortConnect();
          await previous.dispose();
        }
        this.session = created;
        this.scope.attach(created, this.listeners);
        this.epoch = created.view().epoch;
      } catch (error) {
        this.reportConnectFailure(error);
        return;
      }
    }
    const result = await this.scope.connect(options);
    if (this.disposed || !this.scope.isCurrent(result.generation)) return;
    if (result.connected) {
      const recent = options.address ? [options.address, ...this.stateValue.recentHosts.filter(host => host !== options.address)].slice(0, 5) : this.stateValue.recentHosts;
      this.stateValue = { ...this.stateValue, busy: false, joinError: null, recentHosts: recent };
      this.audio.unlock();
    } else {
      const failure = connectError(result.error);
      this.stateValue = { ...this.stateValue, busy: false, joinError: failure, notice: failure.message, noticeKind: 'error' };
      this.surface.announce(failure.message, true);
    }
    this.render();
  }

  /** One place reports a connect that never started, so the control cannot spin forever. */
  private reportConnectFailure(error: unknown): void {
    const failure = connectError(error);
    this.stateValue = { ...this.stateValue, busy: false, joinError: failure, notice: failure.message, noticeKind: 'error' };
    this.surface.announce(failure.message, true);
    this.render();
  }

  private async runCommand(command: Command, requestId: string): Promise<void> {
    const result = await this.session.command(command, requestId);
    if (this.disposed) return;
    if (result.ok) {
      this.stateValue = {
        ...this.stateValue,
        busy: false,
        notice: null,
        // An accepted fit clears the draft: the committed build is now the authority's.
        drafts: command.kind === 'set-pilot' && command.fit
          ? { ...this.stateValue.drafts, fit: null, fitRejection: null }
          : this.stateValue.drafts,
      };
      this.render();
      return;
    }
    const drafts = result.code === 'invalid-fit'
      ? { ...this.stateValue.drafts, fitRejection: result.message ?? 'Rejected by the authority' }
      : this.stateValue.drafts;
    this.stateValue = {
      ...this.stateValue,
      busy: false,
      drafts,
      notice: COMMAND_MESSAGE[result.code] ?? result.message ?? 'The host refused that action.',
      noticeKind: 'error',
    };
    this.render();
  }

  private copy(text: string): void {
    void this.surface.copy(text).then(ok => {
      if (this.disposed) return;
      this.stateValue = { ...this.stateValue, copyFailed: !ok };
      if (!ok) this.surface.announce('Select and copy this address.');
      this.render();
    });
  }

  dispose(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.loopRunning = false;
    this.hudWriter.dispose();
    await this.scope.dispose();
    this.options.onSessionEnd?.('disposed');
  }
}

function settingsVersion(snapshot: unknown): number {
  const version = snapshot && typeof snapshot === 'object' ? (snapshot as { version?: unknown }).version : undefined;
  return typeof version === 'number' ? version : 0;
}

/**
 * One hidden element mirrors the state the browser tests assert on: which screen and overlay are
 * showing, and what the authority currently reports. Layout never depends on it.
 */
export function stateMirror(state: ShellState, ctx: RouterContext): string {
  return `<div class="state-mirror" data-state-mirror hidden`
    + ` data-screen="${state.screen}" data-overlay="${state.overlay}" data-tab="${state.tabs.lobby ?? ''}"`
    + ` data-phase="${ctx.authority.phase ?? 'none'}" data-link="${ctx.authority.link}" data-life="${ctx.authority.life}"`
    + ` data-presence="${ctx.authority.presence}" data-transport="${ctx.authority.transport ?? 'none'}"`
    + ` data-epoch="${ctx.view.epoch ?? 'none'}" data-revision="${ctx.view.lobby?.revision ?? 0}"`
    + ` data-busy="${state.busy}" data-confirm="${state.confirm?.id ?? ''}" data-cinematic="${state.cinematic}" data-lock="${state.lockedContactId ?? ''}"`
    + ` data-draft="${state.drafts.name?.dirty === true ? 'dirty' : 'clean'}" data-copy-failed="${state.copyFailed}"></div>`;
}

interface FieldEdit {
  readonly fieldId: string;
  readonly value: string;
}

/** Any text, range, number or select control the shell routes into drafts or settings. */
export function fieldValueReader(element: HTMLElement): FieldEdit | null {
  const value = (element as HTMLInputElement).value;
  if (typeof value !== 'string') return null;
  const id = element.getAttribute('data-field') ?? element.getAttribute('data-number') ?? element.getAttribute('data-select');
  return id ? { fieldId: id, value } : null;
}

/** Update existing nodes so telemetry cannot detach a pressed button or an active text field. */
function patchMarkup(root: Element, markup: string): void {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = markup;
  const sync = (parent: Node, next: Node): void => {
    const desired = Array.from(next.childNodes);
    desired.forEach((fresh, index) => {
      const old = parent.childNodes[index];
      if (!old) { parent.appendChild(fresh.cloneNode(true)); return; }
      const a = old instanceof Element ? old : null;
      const b = fresh instanceof Element ? fresh : null;
      if (old.nodeType !== fresh.nodeType || (a && b && (a.tagName !== b.tagName || a.getAttribute('data-action') !== b.getAttribute('data-action')))) {
        parent.replaceChild(fresh.cloneNode(true), old); return;
      }
      if (a && b) {
        for (const attr of Array.from(a.attributes)) if (!b.hasAttribute(attr.name)) a.removeAttribute(attr.name);
        for (const attr of Array.from(b.attributes)) if (a.getAttribute(attr.name) !== attr.value) a.setAttribute(attr.name, attr.value);
        sync(a, b);
      } else if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    });
    while (parent.childNodes.length > desired.length) parent.removeChild(parent.lastChild!);
  };
  sync(root, template.content);
}

/** Browser surface with persistent controls and a separately updated HUD. */
export function domSurface(root: HTMLElement): Surface {
  const doc = root.ownerDocument;
  let lastMarkup = '';
  return {
    render: markup => {
      if (markup === lastMarkup) return;
      lastMarkup = markup;
      patchMarkup(root, markup);
      root.classList.toggle('in-flight', root.querySelector('.screen.flight') !== null);
    },
    writeHud: markup => {
      const region = root.querySelector('[data-hud-region]');
      if (region) patchMarkup(region, markup);
    },
    captureFocus: () => {
      const active = doc.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
      const key = active.getAttribute('data-key');
      if (!key) return null;
      const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
      return { key, start: input?.selectionStart ?? 0, end: input?.selectionEnd ?? 0 };
    },
    restoreFocus: snapshot => {
      const target = root.querySelector<HTMLElement>(`[data-key="${snapshot.key}"]`);
      if (!target) return;
      target.focus();
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        try {
          target.setSelectionRange(snapshot.start, snapshot.end);
        } catch {
          // Some input types (range, number) do not support a selection range.
        }
      }
    },
    announce: (message, urgent) => {
      const region = root.querySelector('[data-live]');
      if (region) {
        region.textContent = message;
        region.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
      }
    },
    copy: async text => {
      try {
        await doc.defaultView?.navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    title: text => {
      doc.title = text;
    },
    measure: () => ({ availableHeight: doc.defaultView?.innerHeight ?? 720, width: doc.defaultView?.innerWidth ?? 1280 }),
    download: (filename, text) => {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    },
  };
}

/** Bind one delegated listener set to the root; returns the detach function. */
function bindDom(runtime: ShellRuntime, root: HTMLElement, options: RuntimeOptions): () => void {
  const doc = root.ownerDocument;
  const onClick = (event: Event): void => {
    const target = event.target;
    const element = target instanceof Element ? target.closest('[data-action]') : null;
    if (!element) return;
    if (element instanceof HTMLButtonElement && element.disabled) return;
    const data: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith('data-') && attribute.name !== 'data-action') data[attribute.name.slice(5)] = attribute.value;
    }
    runtime.dispatch({ id: element.getAttribute('data-action') ?? '', data });
  };
  const onEdit = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const id = fieldValueReader(target);
    if (id) runtime.editField(id.fieldId, id.value);
  };
  const onFocusOut = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const field = target.getAttribute('data-field');
    if (field && field.startsWith('lobby-name-')) runtime.commitName(field.slice('lobby-name-'.length));
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      runtime.escape();
    }
  };
  const onBlur = (): void => runtime.releaseFor('blur');
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') runtime.releaseFor('hidden');
  };
  root.addEventListener('click', onClick);
  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);
  root.addEventListener('focusout', onFocusOut);
  // On the document, not the root: after a screen re-render the focused control is gone and focus
  // falls back to <body>, where a listener on the shell root would never see the key again. The
  // handler still ignores keys aimed at a text field.
  doc.addEventListener('keydown', onKeyDown);
  const win = doc.defaultView;
  win?.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  void options;
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onEdit);
    root.removeEventListener('change', onEdit);
    root.removeEventListener('focusout', onFocusOut);
    doc.removeEventListener('keydown', onKeyDown);
    win?.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Browser entry point. The shell installs its own stylesheet and owns its listeners. */
export function createShell(options: ShellOptions): Shell {
  const root = options.root;
  ensureStyles(root.ownerDocument);
  root.classList.add('drift-ui');
  const runtimeOptions: RuntimeOptions = {
    ...options,
    surface: options.surface ?? domSurface(root),
    clock: options.clock ?? browserClock,
  };
  const runtime = createShellRuntime(runtimeOptions);
  const detach = bindDom(runtime, root, runtimeOptions);
  return {
    dispose: async () => {
      detach();
      await runtime.dispose();
    },
    action: (action, phase) => runtime.action(action, phase),
    cycleLock: direction => runtime.cycleLock(direction),
    get lockedContactId() {
      return runtime.lockedContactId;
    },
    get controlsActive() {
      return runtime.state.screen === 'flight' && runtime.state.overlay === 'none' && !runtime.state.confirm
        && runtime.view.link === 'online' && runtime.view.self?.ship.life === 'alive'
        && (runtime.view.phase === 'live' || runtime.view.phase === 'extraction');
    },
    get paused() {
      return runtime.authority.transport === 'local' && (runtime.state.overlay !== 'none' || runtime.state.confirm !== null);
    },
  };
}

export function createShellRuntime(options: RuntimeOptions): ShellRuntime {
  return new DriftShell(options);
}
